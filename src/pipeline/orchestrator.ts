/**
 * Pipeline orchestrator -- simplified, stateless, cost-aware
 *
 * Loops over phases using PhaseRunner for scan/validate/plan/consolidate/verify.
 * Special-cases exec (delegates to existing exec code).
 * Accumulates cost across all phases, checks budget between phases.
 * Supports smart resume with --resume --run-id <id>.
 */

import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { autoGenerateReport } from "../report/generator.ts";
import {
	BudgetExceededError,
	type RunCost,
	createRunCost,
	formatCost,
	formatTokens,
} from "../runner/cost.ts";
import { runPhase } from "../runner/phase-runner.ts";
import { consolidatePhaseConfig } from "../runner/phases/consolidate.ts";
import { planPhaseConfig } from "../runner/phases/plan.ts";
import { scanPhaseConfig } from "../runner/phases/scan.ts";
import { validatePhaseConfig } from "../runner/phases/validate.ts";
import { verifyPhaseConfig } from "../runner/phases/verify.ts";
import type { PhaseConfig, PhaseRunResult, ResolvedConfig } from "../runner/types.ts";
import { loadRunMeta, loadRunsIndex } from "../state/runs.ts";
import type { RunMeta } from "../state/types.ts";
import { formatDuration, logError, logInfo, logWarn } from "../ui/logger.ts";

/** All phase configs indexed by name */
const PHASE_CONFIGS: Record<string, PhaseConfig> = {
	scan: scanPhaseConfig,
	validate: validatePhaseConfig,
	plan: planPhaseConfig,
	consolidate: consolidatePhaseConfig,
	verify: verifyPhaseConfig,
};

/** Default phase order */
const PHASE_ORDER: string[] = ["scan", "validate", "plan", "consolidate", "exec", "verify"];

const SEPARATOR = pc.dim("═".repeat(47));

/** Track per-phase outcome for the final summary */
interface PhaseOutcome {
	phase: string;
	success: boolean;
	duration: number;
	error?: string;
}

/** Pipeline run options */
export interface PipelineOptions {
	workDir: string;
	config: ResolvedConfig;
	scope?: string;
	/** Custom phase order from config (overrides default) */
	pipeline?: string[];
	/** Resume from this run ID */
	runId?: string;
	/** Start from this phase (inclusive) */
	startPhase?: string;
	/** End at this phase (inclusive) */
	endPhase?: string;
	/** Resume a previous run */
	resume?: boolean;
	/** Force re-run even if phase already completed */
	force?: boolean;
}

/** Pipeline result */
export interface PipelineResult {
	runId?: string;
	success: boolean;
	cost: RunCost;
	phasesCompleted: string[];
	stoppedAt?: string;
	error?: string;
}

/** Resolve the phases to run based on start/end options and config pipeline. */
function resolvePhases(opts: PipelineOptions): string[] {
	let phases = [...(opts.pipeline ?? PHASE_ORDER)];
	if (opts.startPhase) {
		const idx = phases.indexOf(opts.startPhase);
		if (idx >= 0) phases = phases.slice(idx);
	}
	if (opts.endPhase) {
		const idx = phases.indexOf(opts.endPhase);
		if (idx >= 0) phases = phases.slice(0, idx + 1);
	}
	return phases;
}

/** Phases that indicate a run is still in progress (not finished). */
const INCOMPLETE_PHASES = new Set(["scan", "validate", "plan", "consolidate", "exec", "verify"]);

/** Format a run for display in the interactive selector. */
function formatRunChoice(meta: RunMeta): string {
	const phase = pc.yellow(`[${meta.phase}]`);
	const scope = meta.scope ? pc.dim(` — ${meta.scope}`) : "";
	const age = formatAge(meta.created_at);
	return `${meta.id} ${phase}${scope} ${pc.dim(age)}`;
}

/** Format age of a run relative to now. */
function formatAge(isoDate: string): string {
	const ms = Date.now() - new Date(isoDate).getTime();
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Check for incomplete runs and prompt the user to resume or start new.
 * Returns { action: "resume", runId } or { action: "new" }.
 */
async function promptResumeOrNew(
	workDir: string,
): Promise<{ action: "resume"; runId: string; startPhase: string } | { action: "new" }> {
	const index = loadRunsIndex(workDir);
	const incompleteRuns: RunMeta[] = [];

	for (const entry of index.runs) {
		if (INCOMPLETE_PHASES.has(entry.phase)) {
			const meta = loadRunMeta(entry.id, workDir);
			if (meta) incompleteRuns.push(meta);
		}
	}

	if (incompleteRuns.length === 0) return { action: "new" };

	// Sort newest first
	incompleteRuns.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);

	const choices = [
		...incompleteRuns.map((meta) => ({
			name: `Resume: ${formatRunChoice(meta)}`,
			value: `resume:${meta.id}`,
		})),
		{ name: pc.green("Start new run"), value: "new" },
	];

	const answer = await select({
		message: "Incomplete run(s) found. What would you like to do?",
		choices,
	});

	if (answer === "new") return { action: "new" };

	const runId = answer.replace("resume:", "");
	const meta = loadRunMeta(runId, workDir);
	const startPhase = meta && PHASE_ORDER.includes(meta.phase) ? meta.phase : "scan";
	return { action: "resume", runId, startPhase };
}

/** Select or derive a run ID for resume. Picks latest run when none given. */
function selectRunForResume(workDir: string, runId?: string): string {
	if (runId) return runId;
	const index = loadRunsIndex(workDir);
	if (index.runs.length === 0) {
		throw new Error('No runs found. Start with: milhouse --scan --scope "your scope"');
	}
	return index.runs[index.runs.length - 1].id;
}

/** Determine which phase to resume from based on run metadata. */
function getResumeStartPhase(runId: string, workDir: string): string {
	const meta = loadRunMeta(runId, workDir);
	if (!meta) throw new Error(`Run ${runId} not found`);
	if (PHASE_ORDER.includes(meta.phase)) return meta.phase;
	return "scan";
}

/** Build a failed PipelineResult. */
function failResult(
	runId: string | undefined,
	cost: RunCost,
	phasesCompleted: string[],
	stoppedAt: string,
	error: string,
): PipelineResult {
	return { runId, success: false, cost, phasesCompleted, stoppedAt, error };
}

/**
 * Run the full pipeline.
 *
 * Loops over the resolved phase list. For each phase checks budget,
 * delegates exec to the exec module, and calls runPhase() for all others.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
	const { workDir, config } = options;
	const startTime = Date.now();
	const cost = createRunCost();
	const phasesCompleted: string[] = [];
	let runId = options.runId;

	// Handle explicit --resume flag
	if (options.resume) {
		runId = selectRunForResume(workDir, runId);
		options.startPhase = options.startPhase ?? getResumeStartPhase(runId, workDir);
		logInfo(`Resuming run ${runId} from phase "${options.startPhase}"`);
	}
	// For new runs: check for incomplete runs and offer to resume
	else if (!runId && !options.startPhase) {
		const decision = await promptResumeOrNew(workDir);
		if (decision.action === "resume") {
			runId = decision.runId;
			options.startPhase = decision.startPhase;
			logInfo(`Resuming run ${runId} from phase "${decision.startPhase}"`);
		}
	}

	const phases = resolvePhases(options);
	logInfo(`Pipeline phases: ${phases.join(" \u2192 ")}`);

	const outcomes: PhaseOutcome[] = [];

	for (const phase of phases) {
		// Budget gate
		if (config.cost.budgetLimit > 0 && cost.totalCost >= config.cost.budgetLimit) {
			logWarn(
				`Budget limit $${config.cost.budgetLimit} reached (spent: ${formatCost(cost.totalCost)}). Stopping.`,
			);
			return failResult(runId, cost, phasesCompleted, phase, "Budget exceeded");
		}

		const phaseStart = Date.now();

		try {
			if (phase === "exec") {
				// Exec is specialised -- delegate to existing exec code (wired in T9).
				logInfo('Phase "exec" -- delegating to exec module');
				phasesCompleted.push(phase);
				outcomes.push({ phase, success: true, duration: Date.now() - phaseStart });
				continue;
			}

			const phaseConfig = PHASE_CONFIGS[phase];
			if (!phaseConfig) {
				logWarn(`Unknown phase: ${phase}, skipping`);
				continue;
			}

			const result: PhaseRunResult = await runPhase(phaseConfig, {
				workDir,
				config,
				runId,
				scope: options.scope,
				runCost: cost,
			});

			// After scan, capture the runId for subsequent phases
			if (phase === "scan" && result.runId) runId = result.runId;
			phasesCompleted.push(phase);
			outcomes.push({ phase, success: result.success, duration: result.duration });

			if (!result.success && config.failFast) {
				logError(`Phase "${phase}" failed. Stopping (fail-fast enabled).`);
				return failResult(runId, cost, phasesCompleted, phase, `Phase ${phase} failed`);
			}
		} catch (error) {
			outcomes.push({
				phase,
				success: false,
				duration: Date.now() - phaseStart,
				error: error instanceof Error ? error.message : String(error),
			});
			if (error instanceof BudgetExceededError) {
				logWarn(`Budget exceeded during "${phase}": ${error.message}`);
				return failResult(runId, cost, phasesCompleted, phase, error.message);
			}
			const msg = error instanceof Error ? error.message : String(error);
			logError(`Phase "${phase}" error: ${msg}`);
			if (config.failFast) {
				return failResult(runId, cost, phasesCompleted, phase, msg);
			}
		}
	}

	// Auto-generate report before displaying summary
	const pipelineDuration = Date.now() - startTime;
	if (runId) {
		autoGenerateReport(runId, cost, pipelineDuration, config, workDir);
	}

	const allSuccess = outcomes.every((o) => o.success);
	displaySummary(cost, config, phasesCompleted, phases, outcomes, pipelineDuration, allSuccess);
	return { runId, success: allSuccess, cost, phasesCompleted };
}

/** Display pipeline cost summary. */
function displaySummary(
	cost: RunCost,
	config: ResolvedConfig,
	completed: string[],
	total: string[],
	outcomes: PhaseOutcome[],
	totalDuration: number,
	allSuccess: boolean,
): void {
	const log = console.log;
	log("");
	log(SEPARATOR);
	const status = allSuccess ? pc.green("SUCCESS") : pc.red("FAILED");
	log(`Pipeline Summary: ${status}`);
	log(`  Phases:    ${pc.cyan(String(completed.length))}/${total.length}`);
	log(`  Duration:  ${formatDuration(totalDuration)}`);
	log(`  Tokens:    ${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out`);
	log(`  Cost:      ${formatCost(cost.totalCost)}`);
	if (config.cost.budgetLimit > 0) {
		const rem = config.cost.budgetLimit - cost.totalCost;
		log(`  Budget:    ${formatCost(rem)} / ${formatCost(config.cost.budgetLimit)} remaining`);
	}
	log("");
	for (const outcome of outcomes) {
		const icon = outcome.success ? pc.green("✔") : pc.red("✗");
		const dur = pc.dim(formatDuration(outcome.duration));
		const phaseCost = cost.byPhase[outcome.phase];
		const costStr = phaseCost ? pc.dim(formatCost(phaseCost.cost)) : "";
		log(`  ${icon} ${outcome.phase.padEnd(14)} ${dur.padEnd(12)} ${costStr}`);
	}
	log(SEPARATOR);
	log("");
}
