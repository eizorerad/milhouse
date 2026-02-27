/**
 * Plan phase config — Planner (PL)
 *
 * Each CONFIRMED or PARTIAL issue gets a dedicated planner agent that
 * creates a Work Breakdown Structure (WBS) with tasks, dependencies,
 * and acceptance criteria.
 */

import pc from "picocolors";
import { buildPlanPrompt } from "../../agents/prompts/plan.ts";
import { PLAN_SCHEMA } from "../../agents/schemas/plan.ts";
import { filterIssues, loadIssuesForRun, updateIssueForRun } from "../../state/issues.ts";
import { writeIssueWbsJsonForRun, writeIssueWbsPlanForRun } from "../../state/plan-store.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import { createTaskForRun, loadTasksForRun } from "../../state/tasks.ts";
import type { DoDCriteria, Issue, RunPhase } from "../../state/types.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import type { PhaseConfig } from "../types.ts";

/** Parsed WBS task from AI response */
interface ParsedWBSTask {
	title: string;
	description?: string;
	files: string[];
	depends_on: string[];
	checks: string[];
	acceptance: DoDCriteria[];
	risk?: string;
	rollback?: string;
	parallel_group?: number;
}

/** Plan result — parsed WBS */
interface PlanResult {
	issue_id: string;
	summary: string;
	tasks: ParsedWBSTask[];
}

export const planPhaseConfig: PhaseConfig<Issue, PlanResult> = {
	name: "plan",
	role: "PL",
	jsonSchema: PLAN_SCHEMA as Record<string, unknown>,
	mode: "per-item",
	defaultParallel: 5,

	// Limit turns to prevent Claude from asking clarifying questions
	// and hanging indefinitely. Plan agents need 2-3 turns at most
	// (read files + generate JSON response).
	engineMetadata: { maxTurns: 15 },

	// Retry: if an item fails (e.g. CLI hang timeout), retry it
	isRetryable: true,
	maxRetryRounds: 1,

	loadItems(ctx) {
		const issues = loadIssuesForRun(ctx.runId, ctx.workDir);
		// Check tasks on disk (not just related_task_ids) to handle crash between
		// createTaskForRun and updateIssueForRun — prevents orphan duplicates on resume
		const existingTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		const issuesWithTasks = new Set(existingTasks.map((t) => t.issue_id).filter(Boolean));

		const filtered = filterIssues(issues, {
			issueIds: ctx.config.issueIds,
			excludeIssueIds: ctx.config.excludeIssueIds,
			severityFilter: ctx.config.severityFilter,
			minSeverity: ctx.config.minSeverity,
			statusFilter: ["CONFIRMED", "PARTIAL"],
		});
		return filtered.filter((i) => !issuesWithTasks.has(i.id));
	},

	buildPrompt(issue, ctx) {
		return buildPlanPrompt(issue, ctx);
	},

	parseResponse(response, item) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) {
			return { issue_id: item.id, summary: "Failed to parse WBS", tasks: [] };
		}

		try {
			const parsed = JSON.parse(jsonStr);

			if (typeof parsed.summary !== "string" || !Array.isArray(parsed.tasks)) {
				return { issue_id: item.id, summary: "Invalid WBS structure", tasks: [] };
			}

			const tasks: ParsedWBSTask[] = parsed.tasks
				.filter(
					(t: unknown) =>
						typeof t === "object" &&
						t !== null &&
						typeof (t as Record<string, unknown>).title === "string",
				)
				.map((t: Record<string, unknown>) => ({
					title: t.title as string,
					description: typeof t.description === "string" ? t.description : undefined,
					files: Array.isArray(t.files)
						? (t.files as string[]).filter((f) => typeof f === "string")
						: [],
					depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]).map(String) : [],
					checks: Array.isArray(t.checks)
						? (t.checks as string[]).filter((c) => typeof c === "string")
						: [],
					acceptance: Array.isArray(t.acceptance)
						? (t.acceptance as Array<Record<string, unknown>>).map((a) => ({
								description: typeof a.description === "string" ? a.description : "Unknown",
								check_command: typeof a.check_command === "string" ? a.check_command : undefined,
								verified: false,
							}))
						: [],
					risk: typeof t.risk === "string" ? t.risk : undefined,
					rollback: typeof t.rollback === "string" ? t.rollback : undefined,
					parallel_group: typeof t.parallel_group === "number" ? t.parallel_group : 0,
				}));

			return {
				issue_id: item.id,
				summary: parsed.summary,
				tasks,
			};
		} catch {
			return { issue_id: item.id, summary: "Failed to parse WBS JSON", tasks: [] };
		}
	},

	retryFilter(items, results) {
		// Retry items that failed or produced no tasks (e.g. CLI hang, parse failure)
		const failedIds = new Set(
			results
				.filter((r) => !r.success || r.result.tasks.length === 0)
				.map((r) => (r.item as Issue).id),
		);
		return items.filter((i) => failedIds.has(i.id));
	},

	async saveResults(results, ctx) {
		let totalTasks = 0;

		for (const r of results) {
			if (!r.success || r.result.tasks.length === 0) continue;

			const issue = r.item as Issue;
			const wbs = r.result;

			// Save WBS markdown and JSON
			const markdown = generateWBSMarkdown(issue, wbs);
			writeIssueWbsPlanForRun(ctx.workDir, ctx.runId, issue.id, markdown);
			writeIssueWbsJsonForRun(ctx.workDir, ctx.runId, issue.id, wbs);

			// Create tasks in state
			const createdTaskIds: string[] = [];
			const createdTaskTitles: string[] = [];
			for (const wbsTask of wbs.tasks) {
				// Convert depends_on to task IDs — supports both numeric indices and title matches
				const dependsOn = wbsTask.depends_on
					.map((dep) => {
						// Try numeric index first
						const depIndex = Number.parseInt(dep, 10);
						if (!Number.isNaN(depIndex) && depIndex >= 0 && depIndex < createdTaskIds.length) {
							return createdTaskIds[depIndex];
						}
						// Fallback: match by task title
						const titleIdx = createdTaskTitles.indexOf(dep);
						if (titleIdx >= 0) return createdTaskIds[titleIdx];
						return null;
					})
					.filter((id): id is string => id !== null);

				const task = createTaskForRun(
					ctx.runId,
					{
						issue_id: issue.id,
						title: wbsTask.title,
						description: wbsTask.description,
						files: wbsTask.files,
						depends_on: dependsOn,
						checks: wbsTask.checks,
						acceptance: wbsTask.acceptance.map((a) => ({
							description: a.description,
							check_command: a.check_command,
							verified: false,
						})),
						risk: wbsTask.risk,
						rollback: wbsTask.rollback,
						parallel_group: wbsTask.parallel_group ?? 0,
						status: "pending",
					},
					ctx.workDir,
				);
				createdTaskIds.push(task.id);
				createdTaskTitles.push(wbsTask.title);
			}

			// Update issue with related task IDs
			updateIssueForRun(
				ctx.runId,
				issue.id,
				{ related_task_ids: [...issue.related_task_ids, ...createdTaskIds] },
				ctx.workDir,
			);

			totalTasks += createdTaskIds.length;
		}

		if (totalTasks > 0) {
			const allTasks = loadTasksForRun(ctx.runId, ctx.workDir);
			await updateRunStatsWithLock(ctx.runId, { tasks_total: allTasks.length }, ctx.workDir);
		}
	},

	formatSummary(results, ctx) {
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}
		const startTime = ctx.startTime;
		displayPhaseSummaryHeader("plan", results, totalInput, totalOutput, ctx.config, startTime);

		let totalTasks = 0;
		const issueBreakdown: Array<{ issueId: string; taskCount: number }> = [];
		for (const r of results) {
			if (!r.success) continue;
			const issue = r.item as Issue;
			const taskCount = r.result.tasks.length;
			totalTasks += taskCount;
			issueBreakdown.push({ issueId: issue.id, taskCount });
		}

		if (issueBreakdown.length > 0) {
			console.log("");
			console.log(`  ${pc.bold("Work Breakdown:")}`);
			for (const { issueId, taskCount } of issueBreakdown) {
				console.log(`    ${issueId}: ${pc.cyan(String(taskCount))} tasks`);
			}
			console.log(`    ${pc.bold("Total:")} ${pc.cyan(String(totalTasks))} tasks`);
		}

		console.log("");
		console.log(`  ${pc.dim("->")} Next: ${pc.cyan("milhouse --consolidate")}`);
		console.log(pc.dim("═".repeat(47)));
		console.log("");
	},

	nextPhase(results): RunPhase {
		const hasPlans = results.some((r) => r.success && r.result.tasks.length > 0);
		return hasPlans ? "consolidate" : "completed";
	},
};

/** Generate simple WBS markdown */
function generateWBSMarkdown(issue: Issue, wbs: PlanResult): string {
	const title = issue.title ?? issue.symptom;
	const parts: string[] = [];

	parts.push(`# WBS: ${issue.id}

> **Title**: ${title}
> **Type**: ${issue.type ?? "bug"}
> **Severity**: ${issue.severity}
> **Tasks**: ${wbs.tasks.length}

## Summary

${wbs.summary}

## Tasks
`);

	for (let i = 0; i < wbs.tasks.length; i++) {
		const task = wbs.tasks[i];
		parts.push(`### ${issue.id}-T${i + 1}: ${task.title}

${task.description || "No description provided."}

- **Files**: ${task.files.length > 0 ? task.files.map((f) => `\`${f}\``).join(", ") : "None"}
- **Dependencies**: ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "None"}
- **Risk**: ${task.risk || "Not assessed"}

---
`);
	}

	return parts.join("\n");
}
