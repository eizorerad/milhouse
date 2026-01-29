/**
 * @fileoverview Validation Report Module
 *
 * Functions for generating and saving validation reports:
 * - getValidationReportsDir: Get validation reports directory
 * - saveValidationReport: Save a deep validation report
 * - updateValidationIndex: Update validation-index.json
 * - generateMarkdownReport: Generate markdown report from deep validation
 *
 * @module cli/commands/utils/validation-report
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateEvents } from "../../../state/events.ts";
import { getMilhouseDir } from "../../../state/manager.ts";
import { getCurrentRunId, getRunDir } from "../../../state/runs.ts";
import type {
	DeepValidationReport,
	ValidationIndex,
	ValidationIndexEntry,
} from "./validation-types.ts";

/**
 * Get validation reports directory
 */
export function getValidationReportsDir(workDir: string): string {
	const dir = join(getMilhouseDir(workDir), "validation-reports");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Save a deep validation report with run_id and update validation-index.json
 *
 * @param report - The deep validation report to save
 * @param workDir - Working directory
 * @param runId - Optional explicit run ID. If not provided, falls back to getCurrentRunId().
 *                Providing an explicit runId is recommended to avoid race conditions
 *                when multiple milhouse processes run in parallel.
 * @returns Path to the saved report file
 */
export function saveValidationReport(
	report: DeepValidationReport,
	workDir: string,
	runId?: string,
): string {
	const reportsDir = getValidationReportsDir(workDir);
	const filename = `${report.issue_id}.json`;
	const filepath = join(reportsDir, filename);

	// Add run_id and created_at to the report
	// Use explicit runId if provided, otherwise fall back to getCurrentRunId()
	const effectiveRunId = runId ?? getCurrentRunId(workDir);
	const now = new Date().toISOString();
	const enrichedReport: DeepValidationReport = {
		...report,
		run_id: effectiveRunId || undefined,
		created_at: now,
	};

	writeFileSync(filepath, JSON.stringify(enrichedReport, null, 2));

	// Update validation-index.json in the run directory if we have an active run
	if (effectiveRunId) {
		updateValidationIndex(effectiveRunId, {
			issue_id: report.issue_id,
			report_path: filepath,
			created_at: now,
			status: report.status,
		}, workDir);

		// Emit validation:report:created event
		stateEvents.emitValidationReportCreated(
			effectiveRunId,
			filename,
			report.issue_id,
			report.status,
		);
	}

	return filepath;
}

/**
 * Update validation-index.json in the run directory
 */
export function updateValidationIndex(
	runId: string,
	entry: ValidationIndexEntry,
	workDir: string,
): void {
	const runDir = getRunDir(runId, workDir);
	const indexPath = join(runDir, "validation-index.json");

	// Load existing index or create new one
	let index: ValidationIndex;
	if (existsSync(indexPath)) {
		try {
			const content = readFileSync(indexPath, "utf-8");
			index = JSON.parse(content) as ValidationIndex;
		} catch {
			index = { run_id: runId, reports: [] };
		}
	} else {
		index = { run_id: runId, reports: [] };
	}

	// Update or add entry (replace if same issue_id exists)
	const existingIndex = index.reports.findIndex((r) => r.issue_id === entry.issue_id);
	if (existingIndex !== -1) {
		index.reports[existingIndex] = entry;
	} else {
		index.reports.push(entry);
	}

	// Save updated index
	writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Generate markdown report from deep validation
 */
export function generateMarkdownReport(report: DeepValidationReport): string {
	const statusEmoji = {
		CONFIRMED: "🔴",
		FALSE: "✅",
		PARTIAL: "🟡",
		MISDIAGNOSED: "🟠",
		UNVALIDATED: "⚪",
	};

	const parts: string[] = [];

	parts.push(`# Validation Report: ${report.issue_id}

> **Status**: ${statusEmoji[report.status]} ${report.status}
> **Confidence**: ${report.confidence}
> **Severity**: ${report.impact_assessment.actual_severity || "N/A"}

## Summary

${report.summary}

---

## Investigation Details

### Files Examined
${report.investigation.files_examined.map((f) => `- \`${f}\``).join("\n") || "No files examined"}

### Commands Run
${report.investigation.commands_run.map((c) => `- \`${c}\``).join("\n") || "No commands run"}

### Patterns Found
${report.investigation.patterns_found.map((p) => `- ${p}`).join("\n") || "No patterns documented"}

### Related Code
${
	report.investigation.related_code
		.map(
			(c) => `
#### ${c.file}:${c.line_start}-${c.line_end}
**Relevance**: ${c.relevance}
${c.code_snippet ? `\`\`\`\n${c.code_snippet}\n\`\`\`` : ""}
`,
		)
		.join("\n") || "No related code documented"
}

---

## Root Cause Analysis

${report.root_cause_analysis.confirmed_cause ? `**Confirmed Cause**: ${report.root_cause_analysis.confirmed_cause}` : ""}

${
	report.root_cause_analysis.alternative_causes?.length
		? `**Alternative Causes Considered**:
${report.root_cause_analysis.alternative_causes.map((c) => `- ${c}`).join("\n")}`
		: ""
}

${report.root_cause_analysis.why_not_false_positive ? `**Why Not False Positive**: ${report.root_cause_analysis.why_not_false_positive}` : ""}

---

## Impact Assessment

| Aspect | Assessment |
|--------|------------|
| Severity Confirmed | ${report.impact_assessment.severity_confirmed ? "Yes" : "No"} |
| Actual Severity | ${report.impact_assessment.actual_severity || "N/A"} |
| Affected Components | ${report.impact_assessment.affected_components.join(", ") || "N/A"} |
| User Impact | ${report.impact_assessment.user_impact || "N/A"} |
| Security Implications | ${report.impact_assessment.security_implications || "None identified"} |

---

## Reproduction

**Reproducible**: ${report.reproduction.reproducible ? "Yes" : "No"}

${
	report.reproduction.steps?.length
		? `**Steps**:
${report.reproduction.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
		: ""
}

${report.reproduction.conditions ? `**Conditions**: ${report.reproduction.conditions}` : ""}

---

## Recommendations

**Fix Approach**: ${report.recommendations.fix_approach}

**Estimated Complexity**: ${report.recommendations.estimated_complexity}

${
	report.recommendations.prerequisites?.length
		? `**Prerequisites**:
${report.recommendations.prerequisites.map((p) => `- ${p}`).join("\n")}`
		: ""
}

${report.recommendations.test_strategy ? `**Test Strategy**: ${report.recommendations.test_strategy}` : ""}

---

## Evidence

${
	report.evidence
		.map(
			(e) => `
### ${e.type}: ${e.file || e.command || e.probe_id || "N/A"}
${e.line_start ? `**Lines**: ${e.line_start}-${e.line_end || e.line_start}` : ""}
${e.output ? `\`\`\`\n${e.output}\n\`\`\`` : ""}
`,
		)
		.join("\n") || "No evidence collected"
}

${report.corrected_description ? `---\n\n## Corrected Description\n\n${report.corrected_description}` : ""}
`);

	return parts.join("\n");
}
