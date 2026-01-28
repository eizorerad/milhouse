/**
 * @fileoverview Problem Brief Generation Module
 *
 * Functions for generating problem brief documents:
 * - generateValidatedProblemBrief: Generate updated Problem Brief markdown after validation
 * - formatIssueSection: Format a single issue section for the Problem Brief
 *
 * @module cli/commands/utils/problem-brief
 */

import type { Issue } from "../../../state/types.ts";

/**
 * Generate updated Problem Brief markdown after validation
 */
export function generateValidatedProblemBrief(issues: Issue[], runId: string): string {
	const timestamp = new Date().toISOString();
	const confirmed = issues.filter((i) => i.status === "CONFIRMED").length;
	const falsePart = issues.filter((i) => i.status === "FALSE").length;
	const partial = issues.filter((i) => i.status === "PARTIAL").length;
	const misdiagnosed = issues.filter((i) => i.status === "MISDIAGNOSED").length;
	const unvalidated = issues.filter((i) => i.status === "UNVALIDATED").length;

	const parts: string[] = [];

	parts.push(`# Problem Brief v1

> **Status**: VALIDATED
> **Run ID**: ${runId}
> **Generated**: ${timestamp}
> **Total Issues**: ${issues.length}
> **Confirmed**: ${confirmed} | **False**: ${falsePart} | **Partial**: ${partial} | **Misdiagnosed**: ${misdiagnosed} | **Unvalidated**: ${unvalidated}

---

## Overview

This Problem Brief has been validated by Issue Validator (IV) agents.
Each issue has been investigated with evidence to confirm or refute the initial hypothesis.

---

## Summary

| Status | Count |
|--------|-------|
| CONFIRMED | ${confirmed} |
| FALSE | ${falsePart} |
| PARTIAL | ${partial} |
| MISDIAGNOSED | ${misdiagnosed} |
| UNVALIDATED | ${unvalidated} |

---

## Confirmed Issues (Ready for Planning)
`);

	const confirmedIssues = issues.filter((i) => i.status === "CONFIRMED");
	if (confirmedIssues.length === 0) {
		parts.push("No confirmed issues.\n");
	} else {
		for (const issue of confirmedIssues) {
			parts.push(formatIssueSection(issue));
		}
	}

	parts.push(`---

## Partial Issues (May Need Refinement)
`);

	const partialIssues = issues.filter((i) => i.status === "PARTIAL");
	if (partialIssues.length === 0) {
		parts.push("No partial issues.\n");
	} else {
		for (const issue of partialIssues) {
			parts.push(formatIssueSection(issue));
		}
	}

	parts.push(`---

## Misdiagnosed Issues (Different Root Cause)
`);

	const misdiagnosedIssues = issues.filter((i) => i.status === "MISDIAGNOSED");
	if (misdiagnosedIssues.length === 0) {
		parts.push("No misdiagnosed issues.\n");
	} else {
		for (const issue of misdiagnosedIssues) {
			parts.push(formatIssueSection(issue));
		}
	}

	parts.push(`---

## False Positives (Dismissed)
`);

	const falseIssues = issues.filter((i) => i.status === "FALSE");
	if (falseIssues.length === 0) {
		parts.push("No false positives.\n");
	} else {
		for (const issue of falseIssues) {
			parts.push(`### ${issue.id}: ${issue.symptom}

**Status**: FALSE - Issue was not validated
${issue.validated_by ? `**Validated By**: ${issue.validated_by}` : ""}

---
`);
		}
	}

	parts.push(`## Next Steps

1. Run \`milhouse plan\` to generate WBS for confirmed issues
2. Review partial/misdiagnosed issues manually if needed
3. Run \`milhouse consolidate\` to merge plans into unified Execution Plan
`);

	return parts.join("\n");
}

/**
 * Format a single issue section for the Problem Brief
 */
export function formatIssueSection(issue: Issue): string {
	let section = `### ${issue.id}: ${issue.symptom}

| Field | Value |
|-------|-------|
| **Status** | ${issue.status} |
| **Severity** | ${issue.severity} |
| **Hypothesis** | ${issue.hypothesis} |
${issue.corrected_description ? `| **Corrected Description** | ${issue.corrected_description} |` : ""}
${issue.frequency ? `| **Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}
${issue.validated_by ? `| **Validated By** | ${issue.validated_by} |` : ""}
| **Updated** | ${issue.updated_at} |

`;

	if (issue.evidence.length > 0) {
		section += "#### Evidence\n\n";
		for (const ev of issue.evidence) {
			if (ev.type === "file" && ev.file) {
				section += `- **File**: \`${ev.file}\``;
				if (ev.line_start) {
					section += `:${ev.line_start}`;
					if (ev.line_end && ev.line_end !== ev.line_start) {
						section += `-${ev.line_end}`;
					}
				}
				section += "\n";
			} else if (ev.type === "command" && ev.command) {
				section += `- **Command**: \`${ev.command}\`\n`;
				if (ev.output) {
					section += `  - Output: ${ev.output.slice(0, 200)}${ev.output.length > 200 ? "..." : ""}\n`;
				}
			} else if (ev.type === "probe" && ev.probe_id) {
				section += `- **Probe**: ${ev.probe_id}\n`;
			}
		}
		section += "\n";
	}

	section += "---\n";
	return section;
}
