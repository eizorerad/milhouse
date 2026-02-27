/**
 * Pipeline orchestrator -- simplified, stateless, cost-aware
 *
 * Loops over phases using PhaseRunner for all phases including exec.
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
import { execPhaseConfig } from "../runner/phases/exec.ts";
import { planPhaseConfig } from "../runner/phases/plan.ts";
import { scanPhaseConfig } from "../runner/phases/scan.ts";
import { validatePhaseConfig } from "../runner/phases/validate.ts";
import { verifyPhaseConfig } from "../runner/phases/verify.ts";
import type { PhaseConfig, PhaseRunResult, ResolvedConfig } from "../runner/types.ts";
import { loadRunMeta, loadRunsIndex } from "../state/runs.ts";
import type { RunMeta } from "../state/types.ts";
import { formatDuration, logError, logInfo, logWarn } from "../ui/logger.ts";
import { validateResumeOutputs } from "./resume-validator.ts";

/** All phase configs indexed by name */
const PHASE_CONFIGS: Record<string, PhaseConfig> = {
	scan: scanPhaseConfig,
	validate: validatePhaseConfig,
	plan: planPhaseConfig,
	consolidate: consolidatePhaseConfig,
	exec: execPhaseConfig,
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

/** Auto-select timeout for non-interactive environments (agents, CI). */
const RESUME_AUTO_SELECT_MS = 5_000;

/** Select a run to resume. Prints the full list, then auto-selects the latest after a timeout. */
async function selectRunForResume(workDir: string, runId?: string): Promise<string> {
	if (runId) return runId;

	const index = loadRunsIndex(workDir);
	const incompleteRuns: RunMeta[] = [];

	for (const entry of index.runs) {
		if (INCOMPLETE_PHASES.has(entry.phase)) {
			const meta = loadRunMeta(entry.id, workDir);
			if (meta) incompleteRuns.push(meta);
		}
	}

	if (incompleteRuns.length === 0) {
		throw new Error("No incomplete runs to resume. Start a new run with: milhouse --run");
	}

	// Newest first
	incompleteRuns.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);

	if (incompleteRuns.length === 1) {
		return incompleteRuns[0].id;
	}

	// Print full list so agents/CI can see all runs in their output context
	const display = incompleteRuns.slice(0, 20);
	console.log(pc.bold(`\nIncomplete runs (${incompleteRuns.length}):\n`));
	for (const [i, meta] of display.entries()) {
		const marker = i === 0 ? pc.green("*") : " ";
		console.log(`  ${marker} ${formatRunChoice(meta)}`);
	}
	if (incompleteRuns.length > 20) {
		console.log(pc.dim(`  ... and ${incompleteRuns.length - 20} more`));
	}
	console.log("");

	const defaultRun = incompleteRuns[0];
	const seconds = RESUME_AUTO_SELECT_MS / 1000;

	// Auto-select after timeout (agents never interact, humans can pick faster)
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RESUME_AUTO_SELECT_MS);

	try {
		const selected = await select(
			{
				message: `Resume which run? (auto-selecting latest in ${seconds}s)`,
				default: defaultRun.id,
				choices: display.map((meta) => ({
					name: formatRunChoice(meta),
					value: meta.id,
				})),
			},
			{ signal: controller.signal },
		);
		clearTimeout(timeout);
		return selected;
	} catch {
		clearTimeout(timeout);
		logInfo(`Auto-selected latest: ${formatRunChoice(defaultRun)}`);
		return defaultRun.id;
	}
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
 * Loops over the resolved phase list. For each phase checks budget
 * and calls runPhase() with the appropriate PhaseConfig.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
	const { workDir, config } = options;
	const startTime = Date.now();
	const cost = createRunCost();
	const phasesCompleted: string[] = [];
	let runId = options.runId;

	// --resume: pick an incomplete run (interactive if multiple)
	// --run (without --resume): always starts fresh, no prompt
	if (options.resume) {
		runId = await selectRunForResume(workDir, runId);
		options.startPhase = options.startPhase ?? getResumeStartPhase(runId, workDir);

		// Validate that prior phase outputs exist before skipping phases
		const validation = validateResumeOutputs(runId, options.startPhase, workDir);
		if (!validation.valid && validation.firstInvalidPhase) {
			logWarn(
				`Resume validation failed: missing outputs for phase "${validation.firstInvalidPhase}". Falling back to re-run from "${validation.firstInvalidPhase}".`,
			);
			for (const err of validation.errors) {
				logWarn(`  ${err}`);
			}
			options.startPhase = validation.firstInvalidPhase;
		}

		logInfo(`Resuming run ${runId} from phase "${options.startPhase}"`);
	}

	const phases = resolvePhases(options);
	logInfo(`Pipeline phases: ${phases.join(" \u2192 ")}`);

	if (config.cost.budgetLimit <= 0) {
		logWarn(
			"Budget limit is unlimited (budgetLimit: 0). Set cost.budgetLimit in .milhouse/config.ts to cap spending.",
		);
	}

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
			if (result.success) phasesCompleted.push(phase);
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

	// Build a meaningful error message from failed phase outcomes
	if (!allSuccess) {
		const failedPhases = outcomes.filter((o) => !o.success);
		const failedNames = failedPhases.map((o) => o.phase);
		const firstFailed = failedPhases[0];
		const errorMsg = firstFailed?.error
			? `Phase "${firstFailed.phase}" failed: ${firstFailed.error}`
			: `${failedNames.length} phase(s) failed: ${failedNames.join(", ")}`;
		return {
			runId,
			success: false,
			cost,
			phasesCompleted,
			stoppedAt: firstFailed?.phase,
			error: errorMsg,
		};
	}

	return { runId, success: true, cost, phasesCompleted };
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
