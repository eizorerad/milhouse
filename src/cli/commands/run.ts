import { existsSync } from "node:fs";
import type { RuntimeOptions } from "../runtime-options.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName } from "../../engines/types.ts";
import {
	type PipelineConfig,
	type PipelinePhase,
	type PipelineResult,
	getPipelineStatus,
	resumePipeline,
	runPipeline,
} from "../../execution/pipeline.ts";
import { shouldEnableBrowser, legacyFlagToBrowserMode } from "../../execution/runtime/browser.ts";
import { runParallel } from "../../execution/steps/parallel.ts";
import { runSequential } from "../../execution/steps/sequential.ts";
import type { MilhouseStepBatchResult } from "../../execution/steps/types.ts";
import { getDefaultBaseBranch } from "../../vcs/services/branch-service.ts";
import { createLegacyTaskSource } from "../../tasks/index.ts";
import {
	formatDuration,
	formatTokens,
	logError,
	logInfo,
	logSuccess,
	logWarn,
	setVerbose,
} from "../../ui/logger.ts";
import { notifyAllComplete } from "../../ui/notify.ts";
import { buildActiveSettings } from "../../ui/settings.ts";

/**
 * Options for the new pipeline-based run
 */
export interface PipelineRunOptions {
	/** Start from this phase */
	startPhase?: PipelinePhase;
	/** Stop after this phase */
	endPhase?: PipelinePhase;
	/** Resume from where it left off */
	resume?: boolean;
	/** Force run even if phases already completed */
	force?: boolean;
	/** Stop on first phase failure */
	failFast?: boolean;
}

/**
 * Run the full Milhouse pipeline (scan → validate → plan → consolidate → exec → verify)
 *
 * This is the new agent-based pipeline execution mode that:
 * 1. Scans the repository for issues with the Lead Investigator agent
 * 2. Validates issues with Issue Validator agents
 * 3. Plans fixes with Planner agents
 * 4. Consolidates plans into an Execution Plan
 * 5. Executes tasks with Executor agents
 * 6. Verifies results with Verifier gates
 */
export async function runPipelineMode(
	options: RuntimeOptions,
	pipelineOptions: PipelineRunOptions = {},
): Promise<PipelineResult> {
	const workDir = process.cwd();
	setVerbose(options.verbose);

	// Check engine availability
	const engine = await createEngine(options.aiEngine as AIEngineName);
	let available = false;
	try {
		const plugin = getPlugin(options.aiEngine as AIEngineName);
		available = await plugin.isAvailable();
	} catch {
		available = false;
	}

	if (!available) {
		logError(`${engine.name} CLI not found. Make sure '${engine.cliCommand}' is in your PATH.`);
		process.exit(1);
	}

	logInfo(`Starting Milhouse Pipeline with ${engine.name}`);
	if (options.tmux) {
		logInfo("Tmux mode enabled - OpenCode servers will be started with TUI attachment");
	}

	// Check current pipeline status
	const status = getPipelineStatus(workDir);

	if (status.isComplete && !pipelineOptions.force) {
		logInfo("Pipeline already completed. Use --force to re-run.");
		return {
			success: true,
			phasesCompleted: [],
			phaseResults: [],
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalDurationMs: 0,
		};
	}

	if (status.isFailed && !pipelineOptions.resume && !pipelineOptions.force) {
		logWarn("Previous pipeline run failed.");
		logInfo("Use --resume to continue from where it left off, or --force to start fresh.");
	}

	// Build pipeline config
	const pipelineConfig: PipelineConfig = {
		startPhase: pipelineOptions.startPhase,
		endPhase: pipelineOptions.endPhase,
		failFast: pipelineOptions.failFast ?? true,
		skipCompleted: !pipelineOptions.force,
		force: pipelineOptions.force,
	};

	// Run pipeline
	let result: PipelineResult;

	if (pipelineOptions.resume) {
		result = await resumePipeline(options, pipelineConfig);
	} else {
		result = await runPipeline(options, pipelineConfig);
	}

	// Notify completion
	if (result.success) {
		const tasksCompleted = result.phaseResults.find((p) => p.phase === "exec")?.data
			?.tasksCompleted as number | undefined;
		if (tasksCompleted && tasksCompleted > 0) {
			notifyAllComplete(tasksCompleted);
		}
	}

	if (!result.success) {
		process.exit(1);
	}

	return result;
}

/**
 * Run the PRD loop (multiple tasks from file/GitHub)
 *
 * @deprecated Use runPipelineMode for the new agent-based execution.
 * This function is kept for backward compatibility with PRD-based workflows.
 */
export async function runLoop(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Validate PRD source
	if (options.prdSource === "markdown" || options.prdSource === "yaml") {
		if (!existsSync(options.prdFile)) {
			logError(`${options.prdFile} not found in current directory`);
			logInfo(`Create a ${options.prdFile} file with tasks`);
			process.exit(1);
		}
	} else if (options.prdSource === "markdown-folder") {
		if (!existsSync(options.prdFile)) {
			logError(`PRD folder ${options.prdFile} not found`);
			logInfo(`Create a ${options.prdFile}/ folder with markdown files containing tasks`);
			process.exit(1);
		}
	}

	if (options.prdSource === "github" && !options.githubRepo) {
		logError("GitHub repository not specified. Use --github owner/repo");
		process.exit(1);
	}

	// Check engine availability
	const engine = await createEngine(options.aiEngine as AIEngineName);
	let available2 = false;
	try {
		const plugin = getPlugin(options.aiEngine as AIEngineName);
		available2 = await plugin.isAvailable();
	} catch {
		available2 = false;
	}

	if (!available2) {
		logError(`${engine.name} CLI not found. Make sure '${engine.cliCommand}' is in your PATH.`);
		process.exit(1);
	}

	// Create task source using the legacy API for backward compatibility
	// with runSequential and runParallel which expect the old TaskSource interface
	const taskSource = createLegacyTaskSource({
		type: options.prdSource,
		filePath: options.prdFile,
		repo: options.githubRepo,
		label: options.githubLabel,
	});

	// Check if there are tasks
	const remaining = await taskSource.countRemaining();
	if (remaining === 0) {
		logSuccess("No tasks remaining. All done!");
		return;
	}

	// Get base branch if needed
	let baseBranch = options.baseBranch;
	if ((options.branchPerTask || options.parallel || options.createPr) && !baseBranch) {
		const branchResult = await getDefaultBaseBranch(workDir);
		if (branchResult.ok) {
			baseBranch = branchResult.value;
		} else {
			logError(`Failed to get default base branch: ${branchResult.error.message}`);
			process.exit(1);
		}
	}

	logInfo(`Starting Milhouse with ${engine.name}`);
	logInfo(`Tasks remaining: ${remaining}`);
	if (options.parallel) {
		logInfo(`Mode: Parallel (max ${options.maxParallel} agents)`);
	} else {
		logInfo("Mode: Sequential");
	}
	if (shouldEnableBrowser(legacyFlagToBrowserMode(options.browserEnabled))) {
		logInfo("Browser automation enabled (agent-browser)");
	}
	console.log("");

	// Build active settings for display
	const activeSettings = buildActiveSettings(options);

	// Run tasks
	let result: MilhouseStepBatchResult;
	if (options.parallel) {
		result = await runParallel({
			engine,
			taskSource,
			workDir,
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			dryRun: options.dryRun,
			maxIterations: options.maxIterations,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay,
			branchPerTask: options.branchPerTask,
			baseBranch,
			createPr: options.createPr,
			draftPr: options.draftPr,
			autoCommit: options.autoCommit,
			browserEnabled: options.browserEnabled,
			maxParallel: options.maxParallel,
			prdSource: options.prdSource,
			prdFile: options.prdFile,
			prdIsFolder: options.prdIsFolder,
			activeSettings,
		});
	} else {
		result = await runSequential({
			engine,
			taskSource,
			workDir,
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			dryRun: options.dryRun,
			maxIterations: options.maxIterations,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay,
			branchPerTask: options.branchPerTask,
			baseBranch,
			createPr: options.createPr,
			draftPr: options.draftPr,
			autoCommit: options.autoCommit,
			browserEnabled: options.browserEnabled,
			activeSettings,
		});
	}

	// Summary
	const duration = Date.now() - startTime;
	console.log("");
	console.log("=".repeat(50));
	logInfo("Summary:");
	console.log(`  Completed: ${result.tasksCompleted}`);
	console.log(`  Failed:    ${result.tasksFailed}`);
	console.log(`  Duration:  ${formatDuration(duration)}`);
	if (result.totalInputTokens > 0 || result.totalOutputTokens > 0) {
		console.log(`  Tokens:    ${formatTokens(result.totalInputTokens, result.totalOutputTokens)}`);
	}
	console.log("=".repeat(50));

	if (result.tasksCompleted > 0) {
		notifyAllComplete(result.tasksCompleted);
	}

	if (result.tasksFailed > 0) {
		process.exit(1);
	}
}
