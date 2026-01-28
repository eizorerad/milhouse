/**
 * @fileoverview Milhouse Single Task Command
 *
 * This module provides the entry point for single task execution.
 *
 * @module cli/commands/task
 *
 * @since 4.0.0
 *
 * @example
 * ```bash
 * # Execute a single task with Milhouse
 * milhouse "Fix the login bug"
 *
 * # Execute with specific AI engine
 * milhouse "Add user authentication" --claude
 * ```
 */

import type { RuntimeOptions } from "../runtime-options.ts";
import { logTaskProgress } from "../../services/config/index.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName } from "../../engines/types.ts";
import { shouldEnableBrowser, legacyFlagToBrowserMode, createBrowserConfig } from "../../execution/runtime/browser.ts";
import { buildMilhousePrompt } from "../../execution/runtime/prompt.ts";
import { executeWithRetry, isRetryableError } from "../../execution/runtime/retry.ts";
import { DEFAULT_RETRY_CONFIG, type MilhouseRetryConfig } from "../../execution/runtime/types.ts";
import { formatTokens, logError, logInfo, setVerbose } from "../../ui/logger.ts";
import { notifyTaskComplete, notifyTaskFailed } from "../../ui/notify.ts";
import { buildActiveSettings } from "../../ui/settings.ts";
import { ProgressSpinner } from "../../ui/spinners.ts";
import { MILHOUSE_BRANDING } from "../types.ts";

/**
 * Milhouse task execution configuration
 *
 * @internal
 */
const MILHOUSE_TASK_CONFIG = {
	/** Maximum response preview length */
	maxResponsePreview: 500,
	/** Default task status messages */
	statusMessages: {
		working: "Working",
		retry: "Retry",
		dryRun: "(dry run) Would execute task",
		completed: "completed",
		failed: "failed",
	},
} as const;

/**
 * Format task display header for Milhouse output
 *
 * @param engineName - Name of the AI engine being used
 * @returns Formatted header string
 *
 * @internal
 */
function formatMilhouseTaskHeader(engineName: string): string {
	return `Running task with ${engineName} via ${MILHOUSE_BRANDING.name}...`;
}

/**
 * Run a single task (brownfield mode)
 *
 * Executes a single task using the configured AI engine. This is the
 * simplest way to use Milhouse - just describe what you want done.
 *
 * @param task - Description of the task to execute
 * @param options - Runtime options from CLI
 *
 * @example
 * ```typescript
 * await runTask("Fix the login bug", options);
 * ```
 */
export async function runTask(task: string, options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();

	// Set verbose mode
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

	logInfo(formatMilhouseTaskHeader(engine.name));

	// Check browser availability using modern API
	const browserMode = legacyFlagToBrowserMode(options.browserEnabled);
	if (shouldEnableBrowser(browserMode)) {
		logInfo("Browser automation enabled (agent-browser)");
	}

	// Build prompt using modern API
	const browserConfig = createBrowserConfig(browserMode);
	const milhousePrompt = buildMilhousePrompt({
		task,
		autoCommit: options.autoCommit,
		workDir,
		browser: browserConfig,
		skipTests: options.skipTests,
		skipLint: options.skipLint,
	});
	const prompt = milhousePrompt.text;

	// Build active settings for display
	const activeSettings = buildActiveSettings(options);

	// Execute with spinner
	const spinner = new ProgressSpinner(task, activeSettings);

	if (options.dryRun) {
		spinner.success(MILHOUSE_TASK_CONFIG.statusMessages.dryRun);
		console.log("\nPrompt:");
		console.log(prompt);
		return;
	}

	try {
		// Build retry config using modern API
		const retryConfig: MilhouseRetryConfig = {
			...DEFAULT_RETRY_CONFIG,
			maxRetries: options.maxRetries,
			baseDelayMs: options.retryDelay,
		};

		const retryResult = await executeWithRetry(
			async () => {
				spinner.updateStep(MILHOUSE_TASK_CONFIG.statusMessages.working);

				// Use streaming if available
				if (engine.executeStreaming) {
					return await engine.executeStreaming(prompt, workDir, (step) => {
						spinner.updateStep(step);
					});
				}

				const res = await engine.execute(prompt, workDir);

				if (!res.success && res.error && isRetryableError(res.error)) {
					throw new Error(res.error);
				}

				return res;
			},
			retryConfig,
		);

		// Handle retry result
		if (!retryResult.success || !retryResult.value) {
			throw retryResult.error ?? new Error("Execution failed after retries");
		}

		const result = retryResult.value;

		if (result.success) {
			const tokens = formatTokens(result.inputTokens, result.outputTokens);
			spinner.success(`Done ${tokens}`);

			logTaskProgress(task, MILHOUSE_TASK_CONFIG.statusMessages.completed, workDir);
			notifyTaskComplete(task);

			// Show response summary (truncated for readability)
			if (result.response && result.response !== "Task completed") {
				console.log("\nResult:");
				console.log(result.response.slice(0, MILHOUSE_TASK_CONFIG.maxResponsePreview));
				if (result.response.length > MILHOUSE_TASK_CONFIG.maxResponsePreview) {
					console.log("...");
				}
			}
		} else {
			spinner.error(result.error || "Unknown error");
			logTaskProgress(task, MILHOUSE_TASK_CONFIG.statusMessages.failed, workDir);
			notifyTaskFailed(task, result.error || "Unknown error");
			process.exit(1);
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		spinner.error(errorMsg);
		logTaskProgress(task, MILHOUSE_TASK_CONFIG.statusMessages.failed, workDir);
		notifyTaskFailed(task, errorMsg);
		process.exit(1);
	}
}
