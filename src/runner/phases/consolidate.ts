/**
 * Consolidate phase config — Consistency & Dependency Manager (CDM)
 *
 * Single-agent phase that merges WBS plans into a unified Execution Plan
 * with proper dependencies, deduplication, and parallel execution groups.
 */

import pc from "picocolors";
import { type ConsolidateInput, buildConsolidatePrompt } from "../../agents/prompts/consolidate.ts";
import { CONSOLIDATE_SCHEMA } from "../../agents/schemas/consolidate.ts";
import { loadGraphForRun, saveGraphForRunSafe } from "../../state/graph.ts";
import { filterIssues, loadIssuesForRun } from "../../state/issues.ts";
import { logWarn } from "../../ui/logger.ts";
import { writeExecutionPlanForRun } from "../../state/plan-store.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import { loadTasksForRun, saveTasksForRunSafe } from "../../state/tasks.ts";
import type { GraphNode, Issue, RunPhase, Task } from "../../state/types.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import type { PhaseConfig } from "../types.ts";

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
	engineMetadata: { maxTokens: 32000, maxTurns: 15 },
	mode: "single-agent",
	defaultParallel: 1,

	loadItems(ctx) {
		// Idempotency guard: if graph already exists, consolidation already ran.
		// Re-running would apply dedup again and potentially delete legitimate tasks.
		const existingGraph = loadGraphForRun(ctx.runId, ctx.workDir);
		if (existingGraph.length > 0) return [];

		const allIssues = loadIssuesForRun(ctx.runId, ctx.workDir);
		const issues = filterIssues(allIssues, {
			issueIds: ctx.config.issueIds,
			excludeIssueIds: ctx.config.excludeIssueIds,
			severityFilter: ctx.config.severityFilter,
			minSeverity: ctx.config.minSeverity,
		});
		const allowedIssueIds = new Set(issues.map((i) => i.id));

		const allTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		const tasks = allTasks
			.filter((t) => t.status === "pending")
			.filter((t) => !t.issue_id || allowedIssueIds.has(t.issue_id));

		if (tasks.length === 0) return [];

		// Store tasks/issues in context for saveResults
		ctx.store.allTasks = allTasks;
		ctx.store.allIssues = allIssues;

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
				cross_dependencies: Array.isArray(parsed.cross_dependencies)
					? parsed.cross_dependencies
					: [],
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
				// Validate that dup.keep actually exists — prevents dangling dep references
				if (!allTasks.some((t) => t.id === dup.keep)) continue;
				allTasks = allTasks.filter((t) => !dup.remove.includes(t.id));
				duplicatesRemoved += dup.remove.length;
				// Rewrite deps pointing to removed tasks
				allTasks = allTasks.map((t) => ({
					...t,
					depends_on: t.depends_on.map((dep) => (dup.remove.includes(dep) ? dup.keep : dep)),
				}));
			}

			// Apply cross-dependencies (filtering out dangling dep IDs)
			const validTaskIds = new Set(allTasks.map((t) => t.id));
			for (const crossDep of consolidation.cross_dependencies) {
				const idx = allTasks.findIndex((t) => t.id === crossDep.task_id);
				if (idx !== -1) {
					const task = allTasks[idx];
					const filteredCrossDeps = crossDep.depends_on.filter((depId) => {
						if (!validTaskIds.has(depId)) {
							logWarn(`Stripping dangling cross-dependency '${depId}' from task '${crossDep.task_id}'`);
							return false;
						}
						return true;
					});
					const newDeps = [...new Set([...task.depends_on, ...filteredCrossDeps])];
					allTasks = [
						...allTasks.slice(0, idx),
						{ ...task, depends_on: newDeps },
						...allTasks.slice(idx + 1),
					];
				}
			}

			// Apply parallel groups
			for (const pg of consolidation.parallel_groups) {
				for (const taskId of pg.task_ids) {
					const idx = allTasks.findIndex((t) => t.id === taskId);
					if (idx !== -1) {
						allTasks = [
							...allTasks.slice(0, idx),
							{ ...allTasks[idx], parallel_group: pg.group },
							...allTasks.slice(idx + 1),
						];
					}
				}
			}
		}

		// Strip any remaining dangling dependency references
		const allValidIds = new Set(allTasks.map((t) => t.id));
		allTasks = allTasks.map((t) => {
			const filtered = t.depends_on.filter((depId) => {
				if (!allValidIds.has(depId)) {
					logWarn(`Stripping dangling dependency '${depId}' from task '${t.id}'`);
					return false;
				}
				return true;
			});
			return filtered.length !== t.depends_on.length ? { ...t, depends_on: filtered } : t;
		});

		// Assign parallel groups based on dependencies
		allTasks = assignParallelGroups(allTasks);

		// Save updated tasks
		await saveTasksForRunSafe(ctx.runId, allTasks, ctx.workDir);

		// Build and save dependency graph
		const pendingTasks = allTasks.filter((t) => t.status === "pending");
		const graph: GraphNode[] = pendingTasks.map((t) => ({
			id: t.id,
			depends_on: [...t.depends_on],
			parallel_group: t.parallel_group,
		}));
		await saveGraphForRunSafe(ctx.runId, graph, ctx.workDir);

		// Validate graph for missing dependency references (warn-only)
		const graphNodeIds = new Set(graph.map((n) => n.id));
		for (const node of graph) {
			for (const depId of node.depends_on) {
				if (!graphNodeIds.has(depId)) {
					logWarn(`Graph node '${node.id}' references missing dependency '${depId}'`);
				}
			}
		}

		// Generate execution plan markdown
		const markdown = generateExecutionPlanMarkdown(pendingTasks, issues, duplicatesRemoved);
		writeExecutionPlanForRun(ctx.workDir, ctx.runId, markdown);

		await updateRunStatsWithLock(ctx.runId, { tasks_total: pendingTasks.length }, ctx.workDir);
	},

	formatSummary(results, ctx) {
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}
		const startTime = ctx.startTime;
		displayPhaseSummaryHeader(
			"consolidate",
			results,
			totalInput,
			totalOutput,
			ctx.config,
			startTime,
		);

		for (const r of results) {
			if (!r.success) continue;
			const c = r.result;
			const dupsRemoved = c.duplicates.reduce((sum, d) => sum + (d.remove?.length ?? 0), 0);
			const groups = c.parallel_groups.length;
			const orderLen = c.execution_order.length;

			console.log("");
			console.log(`  ${pc.bold("Execution Plan:")}`);
			console.log(`    Duplicates removed: ${pc.cyan(String(dupsRemoved))}`);
			console.log(`    Parallel groups:    ${pc.cyan(String(groups))}`);
			console.log(`    Execution order:    ${pc.cyan(String(orderLen))} tasks`);
		}

		console.log("");
		console.log(`  ${pc.dim("->")} Next: ${pc.cyan("milhouse --exec")}`);
		console.log(pc.dim("═".repeat(47)));
		console.log("");
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
function generateExecutionPlanMarkdown(
	tasks: Task[],
	_issues: Issue[],
	duplicatesRemoved: number,
): string {
	const groups = new Map<number, Task[]>();
	for (const task of tasks) {
		const g = task.parallel_group;
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)?.push(task);
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
