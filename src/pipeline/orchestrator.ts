/**
 * Pipeline orchestrator -- simplified, stateless, cost-aware
 *
 * Loops over phases using PhaseRunner for scan/validate/plan/consolidate/verify.
 * Special-cases exec (delegates to existing exec code).
 * Accumulates cost across all phases, checks budget between phases.
 * Supports smart resume with --resume --run-id <id>.
 */

import type { PhaseConfig, PhaseRunResult, ResolvedConfig } from "../runner/types.ts";
import { runPhase } from "../runner/phase-runner.ts";
import { BudgetExceededError, createRunCost, formatCost, formatTokens, type RunCost } from "../runner/cost.ts";
import { scanPhaseConfig } from "../runner/phases/scan.ts";
import { validatePhaseConfig } from "../runner/phases/validate.ts";
import { planPhaseConfig } from "../runner/phases/plan.ts";
import { consolidatePhaseConfig } from "../runner/phases/consolidate.ts";
import { verifyPhaseConfig } from "../runner/phases/verify.ts";
import { loadRunMeta, loadRunsIndex } from "../state/runs.ts";
import { logError, logInfo, logWarn } from "../ui/logger.ts";
import { autoGenerateReport } from "../report/generator.ts";

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

const SEPARATOR = "=".repeat(47);

/** Pipeline run options */
export interface PipelineOptions {
	workDir: string;
	config: ResolvedConfig;
	scope?: string;
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

/** Resolve the phases to run based on start/end options. */
function resolvePhases(opts: PipelineOptions): string[] {
	let phases = [...PHASE_ORDER];
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
	runId: string | undefined, cost: RunCost, phasesCompleted: string[],
	stoppedAt: string, error: string,
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

	// Handle resume
	if (options.resume) {
		runId = selectRunForResume(workDir, runId);
		options.startPhase = options.startPhase ?? getResumeStartPhase(runId, workDir);
		logInfo(`Resuming run ${runId} from phase "${options.startPhase}"`);
	}

	const phases = resolvePhases(options);
	logInfo(`Pipeline phases: ${phases.join(" \u2192 ")}`);

	for (const phase of phases) {
		// Budget gate
		if (config.cost.budgetLimit > 0 && cost.totalCost >= config.cost.budgetLimit) {
			logWarn(`Budget limit $${config.cost.budgetLimit} reached (spent: ${formatCost(cost.totalCost)}). Stopping.`);
			return failResult(runId, cost, phasesCompleted, phase, "Budget exceeded");
		}

		try {
			if (phase === "exec") {
				// Exec is specialised -- delegate to existing exec code (wired in T9).
				logInfo('Phase "exec" -- delegating to exec module');
				phasesCompleted.push(phase);
				continue;
			}

			const phaseConfig = PHASE_CONFIGS[phase];
			if (!phaseConfig) { logWarn(`Unknown phase: ${phase}, skipping`); continue; }

			logInfo(`Starting phase: ${phase}`);
			const result: PhaseRunResult = await runPhase(phaseConfig, {
				workDir, config, runId, scope: options.scope, runCost: cost,
			});

			// After scan, capture the runId for subsequent phases
			if (phase === "scan" && result.runId) runId = result.runId;
			phasesCompleted.push(phase);

			if (!result.success && config.failFast) {
				logError(`Phase "${phase}" failed. Stopping (fail-fast enabled).`);
				return failResult(runId, cost, phasesCompleted, phase, `Phase ${phase} failed`);
			}
		} catch (error) {
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

	displaySummary(cost, config, phasesCompleted, phases);
	return { runId, success: true, cost, phasesCompleted };
}

/** Display pipeline cost summary. */
function displaySummary(
	cost: RunCost, config: ResolvedConfig, completed: string[], total: string[],
): void {
	const log = console.log;
	log("");
	log(SEPARATOR);
	log("Pipeline Summary:");
	log(`  Phases completed: ${completed.length}/${total.length}`);
	log(`  Total tokens:     ${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out`);
	log(`  Total cost:       ${formatCost(cost.totalCost)}`);
	if (config.cost.budgetLimit > 0) {
		const rem = config.cost.budgetLimit - cost.totalCost;
		log(`  Budget remaining: ${formatCost(rem)} / ${formatCost(config.cost.budgetLimit)}`);
	}
	log("");
	log("  Phase breakdown:");
	for (const [phase, pc] of Object.entries(cost.byPhase)) {
		log(`    ${phase.padEnd(12)} ${formatCost(pc.cost)}  (${formatTokens(pc.inputTokens)} in / ${formatTokens(pc.outputTokens)} out)`);
	}
	log(SEPARATOR);
	log("");
}
