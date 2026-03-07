/**
 * Plan phase — generate WBS for each validated issue.
 */

import { buildPlanPrompt, PLAN_SCHEMA } from "../prompts/plan.ts";
import type { RunStore } from "../state.ts";
import type { Issue, PhaseConfig, Task } from "../types.ts";
import { extractJson, generateId, now } from "../util.ts";

interface PlanResult {
	issue_id: string;
	summary: string;
	tasks: Array<{
		title: string; description?: string; files?: string[];
		depends_on?: string[]; checks?: string[];
		acceptance?: Array<{ description: string; check_command?: string }>;
		risk?: string; rollback?: string; parallel_group?: number;
	}>;
}

export const planPhase: PhaseConfig<Issue, PlanResult> = {
	name: "plan",
	schema: PLAN_SCHEMA as Record<string, unknown>,
	maxTurns: 15,
	timeout: 5 * 60 * 1000, // 5 min per issue

	loadItems(store) {
		const plannedIssueIds = new Set(store.loadTasks().map((task: Task) => task.issue_id));
		return store.loadIssues().filter(
			(i: Issue) =>
				(i.status === "CONFIRMED" || i.status === "PARTIAL") &&
				!plannedIssueIds.has(i.id),
		);
	},

	buildPrompt(issue) {
		return buildPlanPrompt(issue);
	},

	parseResponse(response, item) {
		const jsonStr = extractJson(response);
		if (!jsonStr) throw new Error(`Plan: no JSON for ${item.id}`);
		const parsed = JSON.parse(jsonStr);
		return {
			issue_id: item.id,
			summary: parsed.summary ?? "",
			tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
		};
	},

	saveResults(results, store) {
		const timestamp = now();
		const allTasks: Task[] = [];
		const plannedIssueIds = new Set<string>();

		for (const r of results) {
			if (!r.success) continue;
			const issue = r.item as Issue;
			const plan = r.result;
			plannedIssueIds.add(issue.id);

			// Save plan markdown
			store.savePlan(issue.id, `# Plan: ${issue.title}\n\n${plan.summary}\n\n${plan.tasks.map((t, i) => `## Task ${i + 1}: ${t.title}\n${t.description ?? ""}`).join("\n\n")}`);

			// Create tasks
			for (const raw of plan.tasks) {
				allTasks.push({
					id: generateId("T"),
					issue_id: issue.id,
					title: raw.title,
					description: raw.description,
					files: raw.files ?? [],
					depends_on: raw.depends_on ?? [],
					checks: raw.checks ?? [],
					acceptance: raw.acceptance ?? [],
					parallel_group: raw.parallel_group ?? 0,
					status: "pending",
					created_at: timestamp,
					updated_at: timestamp,
				});
			}

		}

		if (plannedIssueIds.size > 0) {
			const existing = store.loadTasks().filter((task: Task) => !plannedIssueIds.has(task.issue_id));
			store.saveTasks([...existing, ...allTasks]);
			store.refreshStats();
		}
	},
};
