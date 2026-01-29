/**
 * Pipeline Orchestrator
 *
 * Orchestrates the full Milhouse pipeline:
 * scan → validate → plan → consolidate → exec → verify
 *
 * Each phase can be run individually or as part of a full pipeline.
 */

import pc from "picocolors";
import { runConsolidate } from "../cli/commands/consolidate.ts";
import { type ExecResult, runExec } from "../cli/commands/exec.ts";
import { runPlan } from "../cli/commands/plan.ts";
import { runScan } from "../cli/commands/scan.ts";
import { runValidate } from "../cli/commands/validate.ts";
import { type VerifyResult, runVerify } from "../cli/commands/verify.ts";
import type { RuntimeOptions } from "../cli/runtime-options.ts";
import { bus } from "../events";
import { initializeDir } from "../state/manager.ts";
import { getCurrentRun, getCurrentRunId, setCurrentRun } from "../state/runs.ts";
import type { RunMeta, RunPhase, RunState } from "../state/types.ts";
import {
	formatDuration,
	logDebug,
	logError,
	logInfo,
	logSuccess,
	logWarn,
	setVerbose,
} from "../ui/logger.ts";

/**
 * Map RunMeta phase to legacy RunState phase for backward compatibility
 */
function runMetaPhaseToRunStatePhase(phase: RunPhase): RunState["phase"] {
	const mapping: Record<RunPhase, RunState["phase"]> = {
		scan: "scanning",
		validate: "validating",
		plan: "planning",
		consolidate: "consolidating",
		exec: "executing",
		verify: "verifying",
		completed: "completed",
		failed: "failed",
	};
	return mapping[phase];
}

/**
 * Convert RunMeta to RunState-like object for backward compatibility
 */
function runMetaToRunState(meta: RunMeta): RunState {
	return {
		run_id: meta.id,
		started_at: meta.created_at,
		phase: runMetaPhaseToRunStatePhase(meta.phase),
		issues_found: meta.issues_found,
		issues_validated: meta.issues_validated,
		tasks_total: meta.tasks_total,
		tasks_completed: meta.tasks_completed,
		tasks_failed: meta.tasks_failed,
	};
}

/**
 * Load run state from current run (converts RunMeta to RunState for compatibility)
 */
function loadRunStateFromCurrentRun(workDir: string): RunState | null {
	const runMeta = getCurrentRun(workDir);
	if (!runMeta) {
		return null;
	}
	return runMetaToRunState(runMeta);
}

/**
 * Pipeline phase names
 */
export type PipelinePhase = "scan" | "validate" | "plan" | "consolidate" | "exec" | "verify";

/**
 * Pipeline phase order for sequential execution
 */
export const PIPELINE_PHASES: PipelinePhase[] = [
	"scan",
	"validate",
	"plan",
	"consolidate",
	"exec",
	"verify",
];

/**
 * Result of a single pipeline phase
 */
export interface PipelinePhaseResult {
	phase: PipelinePhase;
	success: boolean;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	error?: string;
	data?: Record<string, unknown>;
}

/**
 * Result of the full pipeline
 */
export interface PipelineResult {
	success: boolean;
	phasesCompleted: PipelinePhase[];
	phaseResults: PipelinePhaseResult[];
	totalInputTokens: number;
	totalOutputTokens: number;
	totalDurationMs: number;
	stoppedAt?: PipelinePhase;
	error?: string;
}

/**
 * Pipeline configuration options
 */
export interface PipelineConfig {
	/** Start from this phase (default: scan) */
	startPhase?: PipelinePhase;
	/** Stop after this phase (default: verify) */
	endPhase?: PipelinePhase;
	/** Stop on first phase failure */
	failFast?: boolean;
	/** Skip phases that have already completed */
	skipCompleted?: boolean;
	/** Force run even if phase already completed */
	force?: boolean;
}

/**
 * Default pipeline configuration
 */
export const DEFAULT_PIPELINE_CONFIG: Required<PipelineConfig> = {
	startPhase: "scan",
	endPhase: "verify",
	failFast: true,
	skipCompleted: true,
	force: false,
};

/**
 * Create pipeline configuration with overrides
 * Note: undefined values in overrides are filtered out to preserve defaults
 */
export function createPipelineConfig(overrides: PipelineConfig = {}): Required<PipelineConfig> {
	// Filter out undefined values to avoid overwriting defaults
	const filteredOverrides = Object.fromEntries(
		Object.entries(overrides).filter(([_, value]) => value !== undefined),
	);

	return {
		...DEFAULT_PIPELINE_CONFIG,
		...filteredOverrides,
	};
}

/**
 * Create empty pipeline result
 */
export function createEmptyPipelineResult(): PipelineResult {
	return {
		success: true,
		phasesCompleted: [],
		phaseResults: [],
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalDurationMs: 0,
	};
}

/**
 * Add phase result to pipeline result (immutable)
 */
export function addPhaseResult(
	pipelineResult: PipelineResult,
	phaseResult: PipelinePhaseResult,
): PipelineResult {
	const phasesCompleted = phaseResult.success
		? [...pipelineResult.phasesCompleted, phaseResult.phase]
		: pipelineResult.phasesCompleted;

	return {
		success: pipelineResult.success && phaseResult.success,
		phasesCompleted,
		phaseResults: [...pipelineResult.phaseResults, phaseResult],
		totalInputTokens: pipelineResult.totalInputTokens + phaseResult.inputTokens,
		totalOutputTokens: pipelineResult.totalOutputTokens + phaseResult.outputTokens,
		totalDurationMs: pipelineResult.totalDurationMs + phaseResult.durationMs,
		stoppedAt: phaseResult.success ? pipelineResult.stoppedAt : phaseResult.phase,
		error: phaseResult.error || pipelineResult.error,
	};
}

/**
 * Get phases to execute based on configuration
 */
export function getPhasesToExecute(config: Required<PipelineConfig>): PipelinePhase[] {
	const startIndex = PIPELINE_PHASES.indexOf(config.startPhase);
	const endIndex = PIPELINE_PHASES.indexOf(config.endPhase);

	if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
		return [];
	}

	return PIPELINE_PHASES.slice(startIndex, endIndex + 1);
}

/**
 * Check if a phase should be skipped based on run state
 */
export function shouldSkipPhase(
	phase: PipelinePhase,
	runState: RunState | null,
	config: Required<PipelineConfig>,
): boolean {
	if (config.force) {
		return false;
	}

	if (!config.skipCompleted || !runState) {
		return false;
	}

	const phaseMap: Record<PipelinePhase, RunState["phase"][]> = {
		scan: [
			"validating",
			"planning",
			"reviewing",
			"consolidating",
			"executing",
			"verifying",
			"completed",
		],
		validate: ["planning", "reviewing", "consolidating", "executing", "verifying", "completed"],
		plan: ["reviewing", "consolidating", "executing", "verifying", "completed"],
		consolidate: ["executing", "verifying", "completed"],
		exec: ["verifying", "completed"],
		verify: ["completed"],
	};

	const completedPhases = phaseMap[phase];
	return completedPhases.includes(runState.phase);
}

/**
 * Map run state phase to pipeline phase
 */
export function runStateToPipelinePhase(runStatePhase: RunState["phase"]): PipelinePhase | null {
	const mapping: Partial<Record<RunState["phase"], PipelinePhase>> = {
		scanning: "scan",
		validating: "validate",
		planning: "plan",
		reviewing: "plan",
		consolidating: "consolidate",
		executing: "exec",
		verifying: "verify",
	};

	return mapping[runStatePhase] || null;
}

/**
 * Execute a single pipeline phase
 */
async function executePhase(
	phase: PipelinePhase,
	options: RuntimeOptions,
	workDir: string,
	runId?: string,
): Promise<PipelinePhaseResult> {
	// Pass runId to the phase via options if provided
	const phaseOptions = runId ? { ...options, runId } : options;
	const startTime = Date.now();

	try {
		let result: {
			success: boolean;
			inputTokens: number;
			outputTokens: number;
			error?: string;
			[key: string]: unknown;
		};

		switch (phase) {
			case "scan": {
				const scanResult = await runScan(phaseOptions);
				result = {
					success: scanResult.success,
					inputTokens: scanResult.inputTokens,
					outputTokens: scanResult.outputTokens,
					error: scanResult.error,
					issuesFound: scanResult.issuesFound,
					problemBriefPath: scanResult.problemBriefPath,
					runId: scanResult.runId,
				};
				break;
			}
			case "validate": {
				const validateResult = await runValidate(phaseOptions);
				result = {
					success: validateResult.success,
					inputTokens: validateResult.inputTokens,
					outputTokens: validateResult.outputTokens,
					error: validateResult.error,
					issuesValidated: validateResult.issuesValidated,
					issuesConfirmed: validateResult.issuesConfirmed,
					issuesFalse: validateResult.issuesFalse,
					issuesPartial: validateResult.issuesPartial,
					issuesMisdiagnosed: validateResult.issuesMisdiagnosed,
				};
				break;
			}
			case "plan": {
				const planResult = await runPlan(phaseOptions);
				result = {
					success: planResult.success,
					inputTokens: planResult.inputTokens,
					outputTokens: planResult.outputTokens,
					error: planResult.error,
					issuesPlanned: planResult.issuesPlanned,
					tasksCreated: planResult.tasksCreated,
					planPaths: planResult.planPaths,
				};
				break;
			}
			case "consolidate": {
				const consolidateResult = await runConsolidate(phaseOptions);
				result = {
					success: consolidateResult.success,
					inputTokens: consolidateResult.inputTokens,
					outputTokens: consolidateResult.outputTokens,
					error: consolidateResult.error,
					tasksConsolidated: consolidateResult.tasksConsolidated,
					parallelGroups: consolidateResult.parallelGroups,
					duplicatesRemoved: consolidateResult.duplicatesRemoved,
					executionPlanPath: consolidateResult.executionPlanPath,
				};
				break;
			}
			case "exec": {
				// Enable exec-by-issue by default in pipeline mode for optimal parallelization
				// Each issue runs in its own worktree with all its tasks
				const execOptions = {
					...phaseOptions,
					execByIssue: phaseOptions.execByIssue !== false, // Enable by default unless explicitly disabled
					parallel: true, // Always enable parallel in pipeline mode
				};
				const execResult: ExecResult = await runExec(execOptions);
				result = {
					success: execResult.success,
					inputTokens: execResult.inputTokens,
					outputTokens: execResult.outputTokens,
					error: execResult.error,
					tasksExecuted: execResult.tasksExecuted,
					tasksCompleted: execResult.tasksCompleted,
					tasksFailed: execResult.tasksFailed,
				};
				break;
			}
			case "verify": {
				const verifyResult: VerifyResult = await runVerify(phaseOptions);
				result = {
					success: verifyResult.success,
					inputTokens: verifyResult.inputTokens,
					outputTokens: verifyResult.outputTokens,
					error: verifyResult.error,
					gatesRun: verifyResult.gatesRun,
					gatesPassed: verifyResult.gatesPassed,
					gatesFailed: verifyResult.gatesFailed,
					issues: verifyResult.issues,
				};
				break;
			}
			default: {
				const _exhaustive: never = phase;
				throw new Error(`Unknown phase: ${_exhaustive}`);
			}
		}

		const durationMs = Date.now() - startTime;

		return {
			phase,
			success: result.success,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			durationMs,
			error: result.error,
			data: result,
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			phase,
			success: false,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: Date.now() - startTime,
			error: errorMsg,
		};
	}
}

/**
 * Run the full pipeline
 *
 * Executes phases sequentially: scan → validate → plan → consolidate → exec → verify
 * Each phase depends on the previous phase completing successfully.
 */
export async function runPipeline(
	options: RuntimeOptions,
	pipelineConfig: PipelineConfig = {},
): Promise<PipelineResult> {
	const workDir = process.cwd();
	const startTime = Date.now();
	const config = createPipelineConfig(pipelineConfig);
	
	// Track the pipeline run ID - will be set by scan phase or from current run
	// This ensures all phases in the pipeline use the same run
	let pipelineRunId: string | null = getCurrentRunId(workDir);
	const eventRunId = pipelineRunId || `run-${Date.now()}`;

	setVerbose(options.verbose);
	initializeDir(workDir);

	logInfo("Starting Milhouse Pipeline");
	logInfo(`Phases: ${config.startPhase} → ${config.endPhase}`);
	console.log("");

	const phasesToExecute = getPhasesToExecute(config);

	// Emit pipeline start event
	bus.emit("pipeline:start", { runId: eventRunId, phases: phasesToExecute });

	if (phasesToExecute.length === 0) {
		logError("Invalid phase range specified");
		return {
			...createEmptyPipelineResult(),
			success: false,
			error: "Invalid phase range",
		};
	}

	logDebug(`Phases to execute: ${phasesToExecute.join(" → ")}`);

	let pipelineResult = createEmptyPipelineResult();

	for (const phase of phasesToExecute) {
		// CRITICAL: Ensure the pipeline run ID is set as current before each phase
		// This prevents other concurrent scans from changing the current run mid-pipeline
		if (pipelineRunId) {
			const currentRunId = getCurrentRunId(workDir);
			if (currentRunId !== pipelineRunId) {
				logDebug(`Restoring pipeline run ID: ${pipelineRunId} (was: ${currentRunId})`);
				setCurrentRun(pipelineRunId, workDir);
			}
		}

		const runState = loadRunStateFromCurrentRun(workDir);

		if (shouldSkipPhase(phase, runState, config)) {
			logInfo(`Skipping ${phase} (already completed)`);
			continue;
		}

		console.log("");
		console.log("═".repeat(60));
		logInfo(`Phase: ${pc.cyan(phase.toUpperCase())}`);
		console.log("═".repeat(60));
		console.log("");

		// Emit phase start event
		bus.emit("pipeline:phase:start", { runId: pipelineRunId || eventRunId, phase });

		const phaseResult = await executePhase(phase, options, workDir, pipelineRunId || undefined);
		pipelineResult = addPhaseResult(pipelineResult, phaseResult);

		// Capture the run ID from scan phase to use for subsequent phases
		if (phase === "scan" && phaseResult.data?.runId) {
			pipelineRunId = phaseResult.data.runId as string;
			logDebug(`Pipeline run ID set from scan: ${pipelineRunId}`);
			// Ensure it's set as current (scan should have done this, but be explicit)
			setCurrentRun(pipelineRunId, workDir);
		}

		if (!phaseResult.success) {
			// Emit phase error event
			bus.emit("pipeline:phase:error", {
				runId: pipelineRunId || eventRunId,
				phase,
				error: new Error(phaseResult.error || "Unknown error"),
			});
			logError(`Phase ${phase} failed: ${phaseResult.error || "Unknown error"}`);

			if (config.failFast) {
				logWarn("Stopping pipeline due to failure (failFast=true)");
				break;
			}
		} else {
			// Emit phase complete event
			bus.emit("pipeline:phase:complete", {
				runId: pipelineRunId || eventRunId,
				phase,
				duration: phaseResult.durationMs,
			});
			logSuccess(`Phase ${phase} completed successfully`);
		}
	}

	const totalDuration = Date.now() - startTime;
	pipelineResult = {
		...pipelineResult,
		totalDurationMs: totalDuration,
	};

	// Emit pipeline complete event
	bus.emit("pipeline:complete", { runId: pipelineRunId || eventRunId, duration: totalDuration });

	console.log("");
	console.log("═".repeat(60));
	logInfo("Pipeline Summary");
	console.log("═".repeat(60));
	console.log("");
	console.log(
		`  Status:           ${pipelineResult.success ? pc.green("SUCCESS") : pc.red("FAILED")}`,
	);
	console.log(
		`  Phases completed: ${pc.cyan(String(pipelineResult.phasesCompleted.length))}/${phasesToExecute.length}`,
	);
	console.log(`  Total duration:   ${formatDuration(totalDuration)}`);
	console.log(`  Input tokens:     ${pc.dim(String(pipelineResult.totalInputTokens))}`);
	console.log(`  Output tokens:    ${pc.dim(String(pipelineResult.totalOutputTokens))}`);

	if (pipelineResult.stoppedAt) {
		console.log(`  Stopped at:       ${pc.red(pipelineResult.stoppedAt)}`);
	}

	console.log("");

	for (const phaseResult of pipelineResult.phaseResults) {
		const status = phaseResult.success ? pc.green("✓") : pc.red("✗");
		const duration = formatDuration(phaseResult.durationMs);
		console.log(`  ${status} ${phaseResult.phase.padEnd(12)} ${pc.dim(duration)}`);
	}

	console.log("");

	if (pipelineResult.success) {
		logSuccess("Pipeline completed successfully!");
	} else {
		logError(`Pipeline failed at ${pipelineResult.stoppedAt || "unknown phase"}`);
	}

	return pipelineResult;
}

/**
 * Run pipeline from a specific phase
 */
export async function runPipelineFrom(
	startPhase: PipelinePhase,
	options: RuntimeOptions,
	additionalConfig: Omit<PipelineConfig, "startPhase"> = {},
): Promise<PipelineResult> {
	return runPipeline(options, {
		...additionalConfig,
		startPhase,
	});
}

/**
 * Run pipeline up to a specific phase
 */
export async function runPipelineTo(
	endPhase: PipelinePhase,
	options: RuntimeOptions,
	additionalConfig: Omit<PipelineConfig, "endPhase"> = {},
): Promise<PipelineResult> {
	return runPipeline(options, {
		...additionalConfig,
		endPhase,
	});
}

/**
 * Run a single phase only
 */
export async function runSinglePhase(
	phase: PipelinePhase,
	options: RuntimeOptions,
): Promise<PipelinePhaseResult> {
	const workDir = process.cwd();
	setVerbose(options.verbose);
	initializeDir(workDir);

	return executePhase(phase, options, workDir);
}

/**
 * Resume pipeline from where it left off
 */
export async function resumePipeline(
	options: RuntimeOptions,
	additionalConfig: Omit<PipelineConfig, "startPhase" | "skipCompleted"> = {},
): Promise<PipelineResult> {
	const workDir = process.cwd();
	const runState = loadRunStateFromCurrentRun(workDir);

	if (!runState) {
		logInfo("No previous run found, starting from beginning");
		return runPipeline(options, additionalConfig);
	}

	const currentPhase = runStateToPipelinePhase(runState.phase);

	if (!currentPhase) {
		if (runState.phase === "completed") {
			logInfo("Pipeline already completed");
			return {
				...createEmptyPipelineResult(),
				success: true,
			};
		}

		if (runState.phase === "failed") {
			logWarn("Previous run failed, restarting from beginning");
			return runPipeline(options, { ...additionalConfig, force: true });
		}

		logInfo("Starting from beginning");
		return runPipeline(options, additionalConfig);
	}

	logInfo(`Resuming from ${currentPhase}`);
	return runPipeline(options, {
		...additionalConfig,
		startPhase: currentPhase,
		skipCompleted: false,
	});
}

/**
 * Get current pipeline status
 */
export function getPipelineStatus(workDir: string = process.cwd()): {
	phase: RunState["phase"] | null;
	pipelinePhase: PipelinePhase | null;
	isComplete: boolean;
	isFailed: boolean;
	canResume: boolean;
} {
	const runState = loadRunStateFromCurrentRun(workDir);

	if (!runState) {
		return {
			phase: null,
			pipelinePhase: null,
			isComplete: false,
			isFailed: false,
			canResume: false,
		};
	}

	const pipelinePhase = runStateToPipelinePhase(runState.phase);

	return {
		phase: runState.phase,
		pipelinePhase,
		isComplete: runState.phase === "completed",
		isFailed: runState.phase === "failed",
		canResume: pipelinePhase !== null && runState.phase !== "completed",
	};
}
