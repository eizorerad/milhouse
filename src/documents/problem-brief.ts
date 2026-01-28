import { initializeDir } from "../state/manager.ts";
import { loadIssues } from "../state/issues.ts";
import { getCurrentRun } from "../state/runs.ts";
import { createPlanMetadataHeader, syncLegacyPlansView, writeProblemBrief } from "../state/plan-store.ts";
import { type Issue, type IssueStatus, type RunMeta, type RunState, type Severity } from "../state/types.ts";

/**
 * Options for generating Problem Brief
 */
export interface ProblemBriefOptions {
	/** Filter issues by status (default: all) */
	statusFilter?: IssueStatus[];
	/** Filter issues by severity (default: all) */
	severityFilter?: Severity[];
	/** Include evidence details (default: true) */
	includeEvidence?: boolean;
	/** Include related task IDs (default: true) */
	includeRelatedTasks?: boolean;
	/** Custom title (default: "Problem Brief") */
	title?: string;
	/** Custom version suffix (default: "v0" for unvalidated, "v1" for validated) */
	version?: string;
}

/**
 * Result of Problem Brief generation
 */
export interface ProblemBriefResult {
	/** Whether generation was successful */
	success: boolean;
	/** Path to the generated file */
	filePath?: string;
	/** Generated markdown content */
	content?: string;
	/** Number of issues included */
	issueCount: number;
	/** Error message if generation failed */
	error?: string;
}

/**
 * Issue counts by status
 */
interface IssueCountsByStatus {
	total: number;
	unvalidated: number;
	confirmed: number;
	partial: number;
	false: number;
	misdiagnosed: number;
}

/**
 * Count issues by status
 */
function countIssuesByStatus(issues: Issue[]): IssueCountsByStatus {
	return {
		total: issues.length,
		unvalidated: issues.filter((i) => i.status === "UNVALIDATED").length,
		confirmed: issues.filter((i) => i.status === "CONFIRMED").length,
		partial: issues.filter((i) => i.status === "PARTIAL").length,
		false: issues.filter((i) => i.status === "FALSE").length,
		misdiagnosed: issues.filter((i) => i.status === "MISDIAGNOSED").length,
	};
}

/**
 * Count issues by severity
 */
function countIssuesBySeverity(issues: Issue[]): Record<Severity, number> {
	return {
		CRITICAL: issues.filter((i) => i.severity === "CRITICAL").length,
		HIGH: issues.filter((i) => i.severity === "HIGH").length,
		MEDIUM: issues.filter((i) => i.severity === "MEDIUM").length,
		LOW: issues.filter((i) => i.severity === "LOW").length,
	};
}

/**
 * Determine overall status based on issue statuses
 */
function determineOverallStatus(issues: Issue[]): string {
	if (issues.length === 0) {
		return "NO ISSUES";
	}

	const counts = countIssuesByStatus(issues);

	if (counts.unvalidated === counts.total) {
		return "UNVALIDATED";
	}

	if (counts.unvalidated > 0) {
		return "PARTIALLY VALIDATED";
	}

	if (counts.confirmed > 0 || counts.partial > 0) {
		return "VALIDATED";
	}

	return "NO ACTIONABLE ISSUES";
}

/**
 * Format evidence for markdown display
 */
function formatEvidence(issue: Issue): string {
	if (issue.evidence.length === 0) {
		return "No evidence collected yet.";
	}

	const parts: string[] = [];

	for (const ev of issue.evidence) {
		switch (ev.type) {
			case "file":
				if (ev.file && ev.line_start) {
					const lineRange = ev.line_end ? `${ev.line_start}-${ev.line_end}` : String(ev.line_start);
					parts.push(`- **File**: \`${ev.file}:${lineRange}\``);
				} else if (ev.file) {
					parts.push(`- **File**: \`${ev.file}\``);
				}
				break;
			case "probe":
				parts.push(`- **Probe**: \`${ev.probe_id}\``);
				if (ev.output) {
					parts.push(
						`  - Output: ${ev.output.slice(0, 200)}${ev.output.length > 200 ? "..." : ""}`,
					);
				}
				break;
			case "log":
				parts.push(
					`- **Log**: ${ev.output?.slice(0, 200) || "N/A"}${(ev.output?.length || 0) > 200 ? "..." : ""}`,
				);
				break;
			case "command":
				parts.push(`- **Command**: \`${ev.command}\``);
				if (ev.output) {
					parts.push(
						`  - Output: ${ev.output.slice(0, 200)}${ev.output.length > 200 ? "..." : ""}`,
					);
				}
				break;
		}
	}

	return parts.length > 0 ? parts.join("\n") : "Evidence format not recognized.";
}

/**
 * Generate the markdown content for a single issue
 */
function generateIssueMarkdown(issue: Issue, options: ProblemBriefOptions): string {
	const parts: string[] = [];

	parts.push(`### ${issue.id}: ${issue.symptom}

| Field | Value |
|-------|-------|
| **Status** | ${issue.status} |
| **Severity** | ${issue.severity} |
| **Hypothesis** | ${issue.hypothesis} |`);

	if (issue.frequency) {
		parts.push(`| **Frequency** | ${issue.frequency} |`);
	}

	if (issue.blast_radius) {
		parts.push(`| **Blast Radius** | ${issue.blast_radius} |`);
	}

	if (issue.strategy) {
		parts.push(`| **Strategy** | ${issue.strategy} |`);
	}

	if (issue.corrected_description) {
		parts.push(`| **Corrected Description** | ${issue.corrected_description} |`);
	}

	parts.push(`| **Created** | ${issue.created_at} |`);

	if (issue.validated_by) {
		parts.push(`| **Validated By** | ${issue.validated_by} |`);
	}

	// Add evidence if enabled
	if (options.includeEvidence !== false && issue.evidence.length > 0) {
		parts.push(`

**Evidence:**

${formatEvidence(issue)}`);
	}

	// Add related tasks if enabled
	if (options.includeRelatedTasks !== false && issue.related_task_ids.length > 0) {
		parts.push(`

**Related Tasks:** ${issue.related_task_ids.join(", ")}`);
	}

	parts.push("\n\n---\n");

	return parts.join("\n");
}

/**
 * Generate the full Problem Brief markdown document
 */
export function generateProblemBriefMarkdown(
	issues: Issue[],
	runState: RunMeta | RunState | null,
	options: ProblemBriefOptions = {},
	workDir = process.cwd(),
): string {
	const timestamp = new Date().toISOString();
	const title = options.title || "Problem Brief";
	const overallStatus = determineOverallStatus(issues);
	const version = options.version || (overallStatus === "UNVALIDATED" ? "v0" : "v1");
	const counts = countIssuesByStatus(issues);
	const severityCounts = countIssuesBySeverity(issues);

	const parts: string[] = [];

	// Add metadata header at the very top
	parts.push(createPlanMetadataHeader(workDir).trimEnd());

	// Get run ID from either RunMeta (id) or RunState (run_id)
	const runId = runState ? ("id" in runState ? runState.id : runState.run_id) : undefined;

	// Header
	parts.push(`# ${title} ${version}

> **Status**: ${overallStatus}
${runId ? `> **Run ID**: ${runId}` : ""}
> **Generated**: ${timestamp}
> **Issues Found**: ${issues.length}

---

## Overview

This Problem Brief was generated by the Lead Investigator (LI) agent during the scan phase.
${overallStatus === "UNVALIDATED" ? "All issues are currently **UNVALIDATED** and require probe validation before planning." : "Issues have been validated with probes and are ready for planning."}`);

	// Summary statistics
	parts.push(`

## Summary

### By Status

| Status | Count |
|--------|-------|
| UNVALIDATED | ${counts.unvalidated} |
| CONFIRMED | ${counts.confirmed} |
| PARTIAL | ${counts.partial} |
| FALSE | ${counts.false} |
| MISDIAGNOSED | ${counts.misdiagnosed} |
| **Total** | **${counts.total}** |

### By Severity

| Severity | Count |
|----------|-------|
| CRITICAL | ${severityCounts.CRITICAL} |
| HIGH | ${severityCounts.HIGH} |
| MEDIUM | ${severityCounts.MEDIUM} |
| LOW | ${severityCounts.LOW} |

---

## Issues
`);

	// Issue details
	if (issues.length === 0) {
		parts.push("No significant issues were identified during the scan.\n");
	} else {
		// Group issues by severity for better organization
		const severityOrder: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

		for (const severity of severityOrder) {
			const severityIssues = issues.filter((i) => i.severity === severity);

			if (severityIssues.length > 0) {
				parts.push(`\n### ${severity} Severity (${severityIssues.length})\n`);

				for (const issue of severityIssues) {
					parts.push(generateIssueMarkdown(issue, options));
				}
			}
		}
	}

	// Next steps
	parts.push(`## Next Steps
`);

	if (overallStatus === "UNVALIDATED") {
		parts.push(`1. Run \`milhouse validate\` to validate each issue with probes
2. Issues will be marked as CONFIRMED, FALSE, PARTIAL, or MISDIAGNOSED
3. Run \`milhouse plan\` to generate WBS for confirmed issues
`);
	} else if (counts.confirmed > 0 || counts.partial > 0) {
		parts.push(`1. Run \`milhouse plan\` to generate WBS for confirmed issues
2. Run \`milhouse consolidate\` to create unified Execution Plan
3. Run \`milhouse exec\` to execute tasks
`);
	} else {
		parts.push(`No actionable issues found. The repository appears to be in good health.

To re-scan with different parameters, run:
\`\`\`bash
milhouse scan --scope <different-scope>
\`\`\`
`);
	}

	parts.push(`
---

*Generated by Milhouse CLI*
`);

	return parts.join("\n");
}

/**
 * Generate Problem Brief from issues and save to file
 */
export function generateProblemBrief(
	issues: Issue[],
	runId: string,
	options: ProblemBriefOptions = {},
): string {
	// Create a mock run state for backward compatibility
	const mockRunState: RunState = {
		run_id: runId,
		started_at: new Date().toISOString(),
		phase: "scanning",
		issues_found: issues.length,
		issues_validated: 0,
		tasks_total: 0,
		tasks_completed: 0,
		tasks_failed: 0,
	};

	return generateProblemBriefMarkdown(issues, mockRunState, options);
}

/**
 * Generate and save Problem Brief to the plans directory
 */
export function saveProblemBrief(
	workDir: string,
	options: ProblemBriefOptions = {},
): ProblemBriefResult {
	// Ensure directory structure exists
	initializeDir(workDir);

	// Load issues
	let issues = loadIssues(workDir);

	// Apply status filter if provided
	if (options.statusFilter && options.statusFilter.length > 0) {
		issues = issues.filter((i) => options.statusFilter?.includes(i.status));
	}

	// Apply severity filter if provided
	if (options.severityFilter && options.severityFilter.length > 0) {
		issues = issues.filter((i) => options.severityFilter?.includes(i.severity));
	}

	// Load run state
	const runState = getCurrentRun(workDir);

	// Generate markdown
	const content = generateProblemBriefMarkdown(issues, runState, options, workDir);

	// Write file using PlanStore
	try {
		const filePath = writeProblemBrief(workDir, content);

		// Sync legacy plans view
		syncLegacyPlansView(workDir);

		return {
			success: true,
			filePath,
			content,
			issueCount: issues.length,
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);

		return {
			success: false,
			issueCount: issues.length,
			error: `Failed to write Problem Brief: ${errorMsg}`,
		};
	}
}

/**
 * Regenerate Problem Brief from current state
 *
 * This is useful after validation to update the document
 * with validated statuses.
 */
export function regenerateProblemBrief(
	workDir: string,
	options: ProblemBriefOptions = {},
): ProblemBriefResult {
	// Load current issues to determine version
	const issues = loadIssues(workDir);
	const hasUnvalidated = issues.some((i) => i.status === "UNVALIDATED");

	// Set appropriate version based on validation state
	const updatedOptions: ProblemBriefOptions = {
		...options,
		version: options.version || (hasUnvalidated ? "v0" : "v1"),
		title: options.title || "Problem Brief",
	};

	return saveProblemBrief(workDir, updatedOptions);
}
