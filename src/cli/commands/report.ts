/**
 * Report command -- generate run reports
 *
 * Thin wrapper that loads config, resolves the run, and generates reports.
 *
 * @module cli/commands/report
 */

import { generateReport } from "../../report/generator.ts";
import { loadResolvedConfig } from "../../runner/config-loader.ts";
import { createRunCost } from "../../runner/cost.ts";
import { loadRunMeta, loadRunsIndex } from "../../state/runs.ts";
import { logError, logInfo } from "../../ui/logger.ts";
import type { RuntimeOptions } from "../runtime-options.ts";

export async function runReport(options: RuntimeOptions & { format?: string }): Promise<void> {
	const workDir = process.cwd();
	const config = await loadResolvedConfig(workDir, options);

	// Determine run ID
	let runId = options.runId;
	if (!runId) {
		const index = loadRunsIndex(workDir);
		if (index.runs.length === 0) {
			logError("No runs found.");
			return;
		}
		runId = index.runs[index.runs.length - 1].id;
	}

	const meta = loadRunMeta(runId, workDir);
	if (!meta) {
		logError(`Run ${runId} not found.`);
		return;
	}

	const format = (options.format as "json" | "markdown" | "both") ?? config.report.format;

	const result = generateReport({
		runId,
		cost: createRunCost(),
		duration: 0,
		workDir,
		format,
	});

	if (result.jsonPath) logInfo(`JSON report: ${result.jsonPath}`);
	if (result.markdownPath) logInfo(`Markdown report: ${result.markdownPath}`);
}
