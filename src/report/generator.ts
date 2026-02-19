/**
 * Report generator -- orchestrates JSON and markdown report generation
 */

import type { ResolvedConfig } from "../runner/types.ts";
import type { RunCost } from "../runner/cost.ts";
import { generateJsonReport, writeJsonReport } from "./json-report.ts";
import { generateMarkdownReport, writeMarkdownReport } from "./markdown-report.ts";
import { logInfo } from "../ui/logger.ts";

export interface GenerateReportOptions {
	runId: string;
	cost: RunCost;
	duration: number;
	workDir: string;
	format: "json" | "markdown" | "both";
}

export interface ReportResult {
	jsonPath?: string;
	markdownPath?: string;
}

/**
 * Generate run report(s)
 */
export function generateReport(options: GenerateReportOptions): ReportResult {
	const result: ReportResult = {};

	// Always generate JSON data (needed for markdown too)
	const jsonReport = generateJsonReport(options.runId, options.cost, options.duration, options.workDir);

	if (options.format === "json" || options.format === "both") {
		result.jsonPath = writeJsonReport(jsonReport, options.runId, options.workDir);
		logInfo(`JSON report: ${result.jsonPath}`);
	}

	if (options.format === "markdown" || options.format === "both") {
		const markdown = generateMarkdownReport(jsonReport);
		result.markdownPath = writeMarkdownReport(markdown, options.runId, options.workDir);
		logInfo(`Markdown report: ${result.markdownPath}`);
	}

	return result;
}

/**
 * Auto-generate report after pipeline (called from orchestrator)
 */
export function autoGenerateReport(
	runId: string,
	cost: RunCost,
	duration: number,
	config: ResolvedConfig,
	workDir: string,
): ReportResult | null {
	if (!config.report.enabled || !config.report.autoGenerate) {
		return null;
	}

	return generateReport({
		runId,
		cost,
		duration,
		workDir,
		format: config.report.format,
	});
}
