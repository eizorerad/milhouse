/**
 * Consolidate phase — deduplicate tasks, add cross-dependencies.
 */

import { buildConsolidatePrompt, CONSOLIDATE_SCHEMA } from "../prompts/consolidate.ts";
import type { RunStore } from "../state.ts";
import type { Config, Issue, PhaseConfig, Task } from "../types.ts";
import { extractJson } from "../util.ts";

interface ConsolidateInput { tasks: Task[]; issues: Issue[] }

interface ConsolidateResult {
	duplicates: Array<{ keep: string; remove: string[]; reason: string }>;
	cross_dependencies: Array<{ task_id: string; depends_on: string[]; reason: string }>;
	parallel_groups: Array<{ group: number; task_ids: string[] }>;
	execution_order: string[];
}

export const consolidatePhase: PhaseConfig<ConsolidateInput, ConsolidateResult> = {
	name: "consolidate",
	schema: CONSOLIDATE_SCHEMA as Record<string, unknown>,
	maxTurns: 15,
	timeout: 5 * 60 * 1000, // 5 min

	loadItems(store) {
		const tasks = store.loadTasks();
		const issues = store.loadIssues().filter((i: Issue) => i.status === "CONFIRMED" || i.status === "PARTIAL");
		if (tasks.length === 0) return [];
		return [{ tasks, issues }];
	},

	buildPrompt(item) {
		return buildConsolidatePrompt(item.tasks, item.issues);
	},

	parseResponse(response) {
		const jsonStr = extractJson(response);
		if (!jsonStr) throw new Error("Consolidate: no JSON in response");
		const parsed = JSON.parse(jsonStr);
		return {
			duplicates: parsed.duplicates ?? [],
			cross_dependencies: parsed.cross_dependencies ?? [],
			parallel_groups: parsed.parallel_groups ?? [],
			execution_order: parsed.execution_order ?? [],
		};
	},

	saveResults(results, store) {
		if (!results[0]?.success) return;
		const result = results[0].result;
		const tasks = store.loadTasks();

		// Remove duplicates
		const toRemove = new Set(result.duplicates.flatMap((d: { remove: string[] }) => d.remove));
		const filtered = tasks.filter((t: Task) => !toRemove.has(t.id));

		// Apply cross-dependencies
		for (const dep of result.cross_dependencies) {
			const task = filtered.find((t: Task) => t.id === dep.task_id);
			if (task) {
				task.depends_on = [...new Set([...task.depends_on, ...dep.depends_on])];
			}
		}

		// Apply parallel groups
		for (const group of result.parallel_groups) {
			for (const taskId of group.task_ids) {
				const task = filtered.find((t: Task) => t.id === taskId);
				if (task) task.parallel_group = group.group;
			}
		}

		store.saveTasks(filtered);
		store.refreshStats();
	},
};
