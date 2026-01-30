/**
 * @fileoverview Verification Report Module
 *
 * Functions for generating and saving verification reports:
 * - getVerificationReportsDir: Get verification reports directory
 * - saveVerificationReport: Save a verification report
 * - updateVerificationIndex: Update verification-index.json
 * - generateVerificationMarkdownReport: Generate markdown report from verification
 *
 * @module cli/commands/utils/verification-report
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateEvents } from "../../../state/events.ts";
import { getMilhouseDir } from "../../../state/manager.ts";
import { getCurrentRunId, getRunDir } from "../../../state/runs.ts";
import type {
	VerificationIndex,
	VerificationIndexEntry,
	VerificationReport,
} from "./verification-types.ts";

/**
 * Get verification reports directory (global)
 * Path: {milhouse_dir}/verification-reports
 * Creates directory if it doesn't exist
 */
export function getVerificationReportsDir(workDir: string): string {
	const dir = join(getMilhouseDir(workDir), "verification-reports");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Save verification report with run_id
 *
 * Saves to:
 * - Global reports directory: {verification-reports}/{runId}.json
 * - Run directory: {run_dir}/verification-report.json
 *
 * Also updates verification index in run directory.
 *
 * @param report - The verification report to save
 * @param workDir - Working directory
 * @param runId - Optional explicit run ID. If not provided, falls back to getCurrentRunId().
 *                Providing an explicit runId is recommended to avoid race conditions
 *                when multiple milhouse processes run in parallel.
 * @returns Path to the saved report file in global reports directory
 */
export function saveVerificationReport(
	report: VerificationReport,
	workDir: string,
	runId?: string,
): string {
	const reportsDir = getVerificationReportsDir(workDir);

	// Use explicit runId if provided, otherwise fall back to getCurrentRunId()
	const effectiveRunId = runId ?? getCurrentRunId(workDir) ?? report.run_id;
	const now = new Date().toISOString();

	// Ensure report has the correct run_id and created_at
	const enrichedReport: VerificationReport = {
		...report,
		run_id: effectiveRunId,
		created_at: report.created_at || now,
	};

	// Save to global reports directory: {verification-reports}/{runId}.json
	const globalFilename = `${effectiveRunId}.json`;
	const globalFilepath = join(reportsDir, globalFilename);
	writeFileSync(globalFilepath, JSON.stringify(enrichedReport, null, 2));

	// Save to run directory: {run_dir}/verification-report.json
	if (effectiveRunId) {
		const runDir = getRunDir(effectiveRunId, workDir);
		if (!existsSync(runDir)) {
			mkdirSync(runDir, { recursive: true });
		}
		const runFilepath = join(runDir, "verification-report.json");
		writeFileSync(runFilepath, JSON.stringify(enrichedReport, null, 2));

		// Update verification index in run directory
		updateVerificationIndex(effectiveRunId, {
			run_id: effectiveRunId,
			report_path: globalFilepath,
			created_at: enrichedReport.created_at,
			overall_success: enrichedReport.overall_success,
			gates_passed: enrichedReport.gates.passed,
			gates_failed: enrichedReport.gates.failed,
		}, workDir);

		// Emit verification:report:created event (using validation event as proxy)
		// Note: The event system doesn't have a specific verification event yet,
		// so we use the validation report event pattern
		stateEvents.emitValidationReportCreated(
			effectiveRunId,
			globalFilename,
			effectiveRunId, // Using runId as issueId since verification is run-level
			enrichedReport.overall_success ? "CONFIRMED" : "FALSE",
		);
	}

	return globalFilepath;
}

/**
 * Update verification-index.json in run directory
 *
 * Reads existing index or creates new one, then replaces existing entry
 * or adds new one based on run_id.
 *
 * @param runId - Run ID to update index for
 * @param entry - Verification index entry to add/update
 * @param workDir - Working directory
 */
export function updateVerificationIndex(
	runId: string,
	entry: VerificationIndexEntry,
	workDir: string,
): void {
	const runDir = getRunDir(runId, workDir);
	const indexPath = join(runDir, "verification-index.json");

	// Load existing index or create new one
	let index: VerificationIndex;
	if (existsSync(indexPath)) {
		try {
			const content = readFileSync(indexPath, "utf-8");
			index = JSON.parse(content) as VerificationIndex;
		} catch {
			index = { run_id: runId, reports: [] };
		}
	} else {
		index = { run_id: runId, reports: [] };
	}

	// Update or add entry (replace if same run_id exists)
	const existingIndex = index.reports.findIndex((r) => r.run_id === entry.run_id);
	if (existingIndex !== -1) {
		index.reports[existingIndex] = entry;
	} else {
		index.reports.push(entry);
	}

	// Save updated index
	writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Generate markdown report from verification data
 *
 * Includes:
 * - Status emoji (✅/❌), run ID, timestamp, duration
 * - Summary table with metrics
 * - Gate results section
 * - Issues section (if any)
 * - AI verification section (if present)
 *
 * @param report - Verification report to generate markdown from
 * @returns Markdown string
 */
export function generateVerificationMarkdownReport(report: VerificationReport): string {
	const statusEmoji = report.overall_success ? "✅" : "❌";
	const durationSec = (report.duration_ms / 1000).toFixed(2);

	const parts: string[] = [];

	// Header with status
	parts.push(`# Verification Report ${statusEmoji}

> **Run ID**: \`${report.run_id}\`
> **Created**: ${report.created_at}
> **Duration**: ${durationSec}s
> **Overall Status**: ${report.overall_success ? "PASSED" : "FAILED"}

---

## Summary

| Metric | Value |
|--------|-------|
| Gates Total | ${report.gates.total} |
| Gates Passed | ${report.gates.passed} |
| Gates Failed | ${report.gates.failed} |
| Tasks Completed | ${report.tasks.completed} |
| Tasks Failed | ${report.tasks.failed} |
| Tasks Total | ${report.tasks.total} |
| Input Tokens | ${report.tokens.input.toLocaleString()} |
| Output Tokens | ${report.tokens.output.toLocaleString()} |

---

## Gate Results
`);

	// Gate results section
	if (report.gates.results.length > 0) {
		parts.push(`
| Gate | Status | Message |
|------|--------|---------|`);

		for (const gate of report.gates.results) {
			const gateEmoji = gate.passed ? "✅" : "❌";
			const message = gate.message || "-";
			parts.push(`| ${gate.gate} | ${gateEmoji} ${gate.passed ? "PASSED" : "FAILED"} | ${message} |`);
		}

		// Add evidence details for failed gates
		const failedGates = report.gates.results.filter((g) => !g.passed && g.evidence.length > 0);
		if (failedGates.length > 0) {
			parts.push(`

### Gate Evidence Details
`);
			for (const gate of failedGates) {
				parts.push(`
#### ${gate.gate}
`);
				for (const evidence of gate.evidence) {
					if (evidence.file) {
						parts.push(`- **File**: \`${evidence.file}\`${evidence.line_start ? `:${evidence.line_start}` : ""}`);
					}
					if (evidence.command) {
						parts.push(`- **Command**: \`${evidence.command}\``);
					}
					if (evidence.output) {
						parts.push(`\`\`\`
${evidence.output}
\`\`\``);
					}
				}
			}
		}
	} else {
		parts.push(`
*No gates were executed.*
`);
	}

	// Issues section
	parts.push(`
---

## Issues Found
`);

	if (report.issues.length > 0) {
		parts.push(`
| Severity | Gate | File | Message |
|----------|------|------|---------|`);

		for (const issue of report.issues) {
			const severityEmoji = issue.severity === "ERROR" ? "🔴" : "🟡";
			const file = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "-";
			parts.push(`| ${severityEmoji} ${issue.severity} | ${issue.gate} | ${file} | ${issue.message} |`);
		}

		// Detailed issue evidence
		const issuesWithEvidence = report.issues.filter((i) => i.evidence);
		if (issuesWithEvidence.length > 0) {
			parts.push(`

### Issue Evidence Details
`);
			for (const issue of issuesWithEvidence) {
				if (issue.evidence) {
					parts.push(`
#### ${issue.gate}: ${issue.message.slice(0, 50)}${issue.message.length > 50 ? "..." : ""}
`);
					if (issue.evidence.file) {
						parts.push(`- **File**: \`${issue.evidence.file}\``);
					}
					if (issue.evidence.output) {
						parts.push(`\`\`\`
${issue.evidence.output}
\`\`\``);
					}
				}
			}
		}
	} else {
		parts.push(`
✅ *No issues found during verification.*
`);
	}

	// AI Verification section
	parts.push(`
---

## AI Verification
`);

	if (report.ai_verification) {
		const aiEmoji = report.ai_verification.overall_pass ? "✅" : "❌";
		const regressionsEmoji = report.ai_verification.regressions_found ? "⚠️" : "✅";

		parts.push(`
| Aspect | Status |
|--------|--------|
| Overall Pass | ${aiEmoji} ${report.ai_verification.overall_pass ? "Yes" : "No"} |
| Regressions Found | ${regressionsEmoji} ${report.ai_verification.regressions_found ? "Yes" : "No"} |
`);

		if (report.ai_verification.summary) {
			parts.push(`
### Summary

${report.ai_verification.summary}
`);
		}

		if (report.ai_verification.recommendations.length > 0) {
			parts.push(`
### Recommendations

${report.ai_verification.recommendations.map((r) => `- ${r}`).join("\n")}
`);
		}
	} else {
		parts.push(`
*AI verification was not performed or failed.*
`);
	}

	// Task completion section
	parts.push(`
---

## Task Completion

| Status | Count |
|--------|-------|
| Completed | ${report.tasks.completed} |
| Failed | ${report.tasks.failed} |
| Total | ${report.tasks.total} |

**Completion Rate**: ${report.tasks.total > 0 ? ((report.tasks.completed / report.tasks.total) * 100).toFixed(1) : 0}%
`);

	return parts.join("\n");
}
