/**
 * Daemon report subcommand
 *
 * Generates a session report for the current daemon state.
 * Outputs both .md and .json files, or just the JSON path with --json.
 */

import { writeSessionReport } from "../../../daemon/session-report.ts";
import { createRunCost } from "../../../runner/cost.ts";
import { getCurrentRun } from "../../../state/runs.ts";
import type { RunMeta } from "../../../state/types.ts";
import { logError, logInfo } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

/**
 * Load daemon state from the work directory.
 * Returns the current run metadata, or null if no state exists.
 */
function loadState(workDir: string): RunMeta | null {
	return getCurrentRun(workDir);
}

/**
 * Generate and print a daemon session report.
 */
export async function daemonReport(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const state = loadState(opts.workDir);

	if (!state) {
		logError("No daemon state found. Run the daemon first.");
		process.exit(1);
	}

	const jsonOnly = args.includes("--json");

	const result = writeSessionReport(state, opts.workDir, createRunCost());

	if (jsonOnly) {
		if (result.jsonPath) {
			console.log(result.jsonPath);
		}
	} else {
		if (result.jsonPath) logInfo(`JSON report: ${result.jsonPath}`);
		if (result.markdownPath) logInfo(`Markdown report: ${result.markdownPath}`);
	}
}
