import { existsSync } from "node:fs";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName } from "../../engines/types.ts";
import { legacyFlagToBrowserMode, shouldEnableBrowser } from "../../execution/runtime/browser.ts";
import { runParallel } from "../../execution/steps/parallel.ts";
import { runSequential } from "../../execution/steps/sequential.ts";
import type { MilhouseStepBatchResult } from "../../execution/steps/types.ts";
import { createLegacyTaskSource } from "../../tasks/index.ts";
import {
	formatDuration,
	formatTokens,
	logError,
	logInfo,
	logSuccess,
	setVerbose,
} from "../../ui/logger.ts";
import { notifyAllComplete } from "../../ui/notify.ts";
import { buildActiveSettings } from "../../ui/settings.ts";
import { getDefaultBaseBranch } from "../../vcs/services/branch-service.ts";
import type { RuntimeOptions } from "../runtime-options.ts";

import { runPipeline as runPipelineImpl } from "../../pipeline/orchestrator.ts";
import type { PipelineResult } from "../../pipeline/orchestrator.ts";
// Runner-based imports
import { loadResolvedConfig } from "../../runner/config-loader.ts";

/**
 * Options for the pipeline run
 */
export interface PipelineRunOptions {
	/** Start from this phase */
	startPhase?: string;
	/** Stop after this phase */
	endPhase?: string;
	/** Resume from where it left off */
	resume?: boolean;
	/** Force run even if phases already completed */
	force?: boolean;
}

/**
 * Run the full Milhouse pipeline using the PhaseRunner-based orchestrator.
 *
 * 1. loadResolvedConfig() merges defaults + config.yml + CLI flags
 * 2. runPipeline() loops over phases using PhaseRunner
 */
export async function runPipelineV2(
	options: RuntimeOptions,
	pipelineOptions: PipelineRunOptions = {},
): Promise<PipelineResult> {
	const workDir = process.cwd();
	setVerbose(options.verbose);

	const config = await loadResolvedConfig(workDir, options);

	// Load user config for pipeline phase order
	const { loadUserConfig } = await import("../../config/loader.ts");
	const { resolveConfig } = await import("../../config/define.ts");
	const userConfig = resolveConfig(await loadUserConfig(workDir));

	const result = await runPipelineImpl({
		workDir,
		config,
		scope: options.scanFocus,
		runId: options.runId,
		pipeline: userConfig.pipeline,
		startPhase: pipelineOptions.startPhase,
		endPhase: pipelineOptions.endPhase,
		resume: pipelineOptions.resume,
		force: pipelineOptions.force,
	});

	if (!result.success) {
		logError(
			`Pipeline failed${result.stoppedAt ? ` at phase "${result.stoppedAt}"` : ""}: ${result.error ?? "unknown error"}`,
		);
		process.exit(1);
	}

	return result;
}

/**
 * Run the PRD loop (multiple tasks from file/GitHub)
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
