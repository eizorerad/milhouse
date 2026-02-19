/**
 * Markdown report generator -- human-readable run report
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRunDir } from "../state/runs.ts";
import type { JsonRunReport } from "./json-report.ts";
import { formatCost, formatTokens } from "../runner/cost.ts";

/**
 * Generate markdown report from JSON report data
 */
export function generateMarkdownReport(report: JsonRunReport): string {
	const lines: string[] = [];

	lines.push(`# Run Report: ${report.run_id}`);
	lines.push("");
	lines.push(`**Scope**: ${report.scope ?? "N/A"}`);
	lines.push(`**Status**: ${report.status}`);
	lines.push(`**Created**: ${report.created_at}`);

	const durationMin = Math.floor(report.duration_ms / 60000);
	const durationSec = Math.floor((report.duration_ms % 60000) / 1000);
	lines.push(`**Duration**: ${durationMin}m ${durationSec}s`);
	lines.push("");

	// Cost summary
	lines.push("## Cost");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| Total | ${formatCost(report.cost.total)} |`);

	for (const [phase, pc] of Object.entries(report.cost.by_phase)) {
		lines.push(`| ${phase} | ${formatCost(pc.cost)} (${formatTokens(pc.input_tokens)} in / ${formatTokens(pc.output_tokens)} out) |`);
	}
	lines.push("");

	// Results summary
	lines.push("## Results");
	lines.push("");
	lines.push("| Metric | Count |");
	lines.push("|--------|-------|");
	lines.push(`| Items found | ${report.results.items_found} |`);
	lines.push(`| Items confirmed | ${report.results.items_confirmed} |`);
	lines.push(`| Items false positive | ${report.results.items_false} |`);
	lines.push(`| Items partial | ${report.results.items_partial} |`);
	lines.push(`| Tasks created | ${report.results.tasks_created} |`);
	lines.push(`| Tasks completed | ${report.results.tasks_completed} |`);
	lines.push(`| Tasks failed | ${report.results.tasks_failed} |`);
	lines.push("");

	// Items detail
	if (report.items.length > 0) {
		lines.push("## Items");
		lines.push("");
		lines.push("| ID | Type | Title | Severity | Status |");
		lines.push("|------|------|-------|----------|--------|");
		for (const item of report.items) {
			lines.push(`| ${item.id} | ${item.type ?? "bug"} | ${item.title} | ${item.severity} | ${item.status} |`);
		}
		lines.push("");
	}

	// Errors
	if (report.errors.length > 0) {
		lines.push("## Errors");
		lines.push("");
		for (const error of report.errors) {
			lines.push(`- ${error}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Write markdown report to disk
 */
export function writeMarkdownReport(markdown: string, runId: string, workDir: string): string {
	const reportDir = join(getRunDir(runId, workDir), "reports");
	if (!existsSync(reportDir)) {
		mkdirSync(reportDir, { recursive: true });
	}
	const path = join(reportDir, "report.md");
	writeFileSync(path, markdown);
	return path;
}
