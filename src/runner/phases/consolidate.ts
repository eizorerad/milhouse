/**
 * Consolidate phase config — Consistency & Dependency Manager (CDM)
 *
 * Single-agent phase that merges WBS plans into a unified Execution Plan
 * with proper dependencies, deduplication, and parallel execution groups.
 */

import type { PhaseConfig, PhaseContext, PhaseItemResult } from "../types.ts";
import type { GraphNode, Issue, RunPhase, Task } from "../../state/types.ts";
import { buildConsolidatePrompt, type ConsolidateInput } from "../../agents/prompts/consolidate.ts";
import { CONSOLIDATE_SCHEMA } from "../../agents/schemas/consolidate.ts";
import { loadIssuesForRun } from "../../state/issues.ts";
import { loadTasksForRun, saveTasksForRun } from "../../state/tasks.ts";
import { saveGraphForRun } from "../../state/graph.ts";
import { writeExecutionPlanForRun } from "../../state/plan-store.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";

/** Parsed consolidation response from AI */
interface ConsolidationResult {
	duplicates: Array<{ keep: string; remove: string[]; reason: string }>;
	cross_dependencies: Array<{ task_id: string; depends_on: string[]; reason: string }>;
	parallel_groups: Array<{ group: number; task_ids: string[] }>;
	execution_order: string[];
}

export const consolidatePhaseConfig: PhaseConfig<ConsolidateInput, ConsolidationResult> = {
	name: "consolidate",
	role: "CDM",
	jsonSchema: CONSOLIDATE_SCHEMA as Record<string, unknown>,
	mode: "single-agent",
	defaultParallel: 1,

	loadItems(ctx) {
		const tasks = loadTasksForRun(ctx.runId, ctx.workDir).filter((t) => t.status === "pending");
		const issues = loadIssuesForRun(ctx.runId, ctx.workDir);

		if (tasks.length === 0) return [];

		// Store tasks/issues in context for saveResults
		ctx.store.allTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		ctx.store.allIssues = issues;

		return [{ tasks, issues }];
	},

	buildPrompt(input, ctx) {
		return buildConsolidatePrompt(input, ctx);
	},

	parseResponse(response) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) {
			return { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] };
		}

		try {
			const parsed = JSON.parse(jsonStr);
			return {
				duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
				cross_dependencies: Array.isArray(parsed.cross_dependencies) ? parsed.cross_dependencies : [],
				parallel_groups: Array.isArray(parsed.parallel_groups) ? parsed.parallel_groups : [],
				execution_order: Array.isArray(parsed.execution_order) ? parsed.execution_order : [],
			};
		} catch {
			return { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] };
		}
	},

	async saveResults(results, ctx) {
		let allTasks = (ctx.store.allTasks as Task[]) ?? loadTasksForRun(ctx.runId, ctx.workDir);
		const issues = (ctx.store.allIssues as Issue[]) ?? loadIssuesForRun(ctx.runId, ctx.workDir);
		let duplicatesRemoved = 0;

		for (const r of results) {
			if (!r.success) continue;
			const consolidation = r.result;

			// Apply duplicate removal
			for (const dup of consolidation.duplicates) {
				if (!dup.keep || !Array.isArray(dup.remove)) continue;
				allTasks = allTasks.filter((t) => !dup.remove.includes(t.id));
				duplicatesRemoved += dup.remove.length;
				// Rewrite deps pointing to removed tasks
				allTasks = allTasks.map((t) => ({
					...t,
					depends_on: t.depends_on.map((dep) => (dup.remove.includes(dep) ? dup.keep : dep)),
				}));
			}

			// Apply cross-dependencies
			for (const crossDep of consolidation.cross_dependencies) {
				const idx = allTasks.findIndex((t) => t.id === crossDep.task_id);
				if (idx !== -1) {
					const task = allTasks[idx];
					const newDeps = [...new Set([...task.depends_on, ...crossDep.depends_on])];
					allTasks = [...allTasks.slice(0, idx), { ...task, depends_on: newDeps }, ...allTasks.slice(idx + 1)];
				}
			}

			// Apply parallel groups
			for (const pg of consolidation.parallel_groups) {
				for (const taskId of pg.task_ids) {
					const idx = allTasks.findIndex((t) => t.id === taskId);
					if (idx !== -1) {
						allTasks = [...allTasks.slice(0, idx), { ...allTasks[idx], parallel_group: pg.group }, ...allTasks.slice(idx + 1)];
					}
				}
			}
		}

		// Assign parallel groups based on dependencies
		allTasks = assignParallelGroups(allTasks);

		// Save updated tasks
		saveTasksForRun(ctx.runId, allTasks, ctx.workDir);

		// Build and save dependency graph
		const pendingTasks = allTasks.filter((t) => t.status === "pending");
		const graph: GraphNode[] = pendingTasks.map((t) => ({
			id: t.id,
			depends_on: [...t.depends_on],
			parallel_group: t.parallel_group,
		}));
		saveGraphForRun(ctx.runId, graph, ctx.workDir);

		// Generate execution plan markdown
		const markdown = generateExecutionPlanMarkdown(pendingTasks, issues, duplicatesRemoved);
		writeExecutionPlanForRun(ctx.workDir, ctx.runId, markdown);

		await updateRunStatsWithLock(ctx.runId, { tasks_total: pendingTasks.length }, ctx.workDir);
	},

	nextPhase(): RunPhase {
		return "exec";
	},
};

/** Assign parallel groups based on dependency chains */
function assignParallelGroups(tasks: Task[]): Task[] {
	const groupMap = new Map<string, number>();
	for (const task of tasks) groupMap.set(task.id, 0);

	let changed = true;
	let iterations = 0;
	while (changed && iterations < tasks.length) {
		changed = false;
		iterations++;
		for (const task of tasks) {
			if (task.depends_on.length === 0) continue;
			const maxDepGroup = Math.max(...task.depends_on.map((d) => groupMap.get(d) ?? 0));
			const newGroup = maxDepGroup + 1;
			if (newGroup > (groupMap.get(task.id) ?? 0)) {
				groupMap.set(task.id, newGroup);
				changed = true;
			}
		}
	}

	return tasks.map((t) => ({ ...t, parallel_group: groupMap.get(t.id) ?? t.parallel_group }));
}

/** Generate execution plan markdown */
function generateExecutionPlanMarkdown(tasks: Task[], issues: Issue[], duplicatesRemoved: number): string {
	const groups = new Map<number, Task[]>();
	for (const task of tasks) {
		const g = task.parallel_group;
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)!.push(task);
	}
	const sortedGroups = [...groups.keys()].sort((a, b) => a - b);

	const parts: string[] = [];
	parts.push(`# Execution Plan

> **Total Tasks**: ${tasks.length}
> **Parallel Groups**: ${sortedGroups.length}
> **Duplicates Removed**: ${duplicatesRemoved}

---

## Execution Groups
`);

	for (const group of sortedGroups) {
		const groupTasks = groups.get(group) || [];
		parts.push(`### Group ${group} (${groupTasks.length} tasks)

| Task | Issue | Dependencies |
|------|-------|--------------|
${groupTasks.map((t) => `| ${t.id} | ${t.issue_id || "-"} | ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "-"} |`).join("\n")}
`);
	}

	return parts.join("\n");
}
