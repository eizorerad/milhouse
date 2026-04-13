/**
 * Exec phase — execute tasks in worktrees.
 * Uses the same PhaseConfig interface as all other phases.
 * Worktree management is handled by the runner.
 */

import { branchExists, getCommittedTaskNumbers } from "../git.ts";
import { buildExecPrompt } from "../prompts/exec.ts";
import type { Issue, IssueGroup, PhaseConfig, Task } from "../types.ts";
import { log } from "../ui.ts";

interface ExecResult {
	issueId: string;
	taskIds: string[];
}

/**
 * Group tasks by issue_id.
 */
function groupTasksByIssue(tasks: Task[], issues: Issue[]): IssueGroup[] {
	const issueMap = new Map(issues.map((i) => [i.id, i]));
	const groups = new Map<string, Task[]>();

	for (const task of tasks) {
		const key = task.issue_id || "UNASSIGNED";
		if (!groups.has(key)) groups.set(key, []);
		const issueTasks = groups.get(key);
		if (issueTasks) issueTasks.push(task);
	}

	const result: IssueGroup[] = [];
	for (const [issueId, issueTasks] of groups) {
		const issue = issueMap.get(issueId) ?? {
			id: issueId,
			type: "task" as const,
			title: `Work item ${issueId}`,
			rationale: "Derived from tasks",
			severity: "MEDIUM" as const,
			status: "CONFIRMED" as const,
			evidence: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		result.push({ issueId, issue, tasks: issueTasks });
	}

	// Sort by severity
	const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
	return result.sort((a, b) => (order[a.issue.severity] ?? 4) - (order[b.issue.severity] ?? 4));
}

export function hasCrossIssueDeps(groups: IssueGroup[]): boolean {
	const taskToIssue = new Map<string, string>();
	for (const group of groups) {
		for (const task of group.tasks) {
			taskToIssue.set(task.id, group.issueId);
		}
	}
	for (const group of groups) {
		for (const task of group.tasks) {
			for (const depId of task.depends_on) {
				const depIssue = taskToIssue.get(depId);
				if (depIssue && depIssue !== group.issueId) return true;
			}
		}
	}
	return false;
}

/**
 * Topological sort of issue groups based on cross-issue task dependencies.
 * Falls back to original order for groups without cross-issue deps.
 */
function topoSortGroups(groups: IssueGroup[]): IssueGroup[] {
	if (!hasCrossIssueDeps(groups)) return groups;

	const taskToIssue = new Map<string, string>();
	for (const group of groups) {
		for (const task of group.tasks) {
			taskToIssue.set(task.id, group.issueId);
		}
	}

	const deps = new Map<string, Set<string>>();
	for (const group of groups) {
		for (const task of group.tasks) {
			for (const depId of task.depends_on) {
				const depIssue = taskToIssue.get(depId);
				if (depIssue && depIssue !== group.issueId) {
					if (!deps.has(group.issueId)) deps.set(group.issueId, new Set());
					deps.get(group.issueId)?.add(depIssue);
				}
			}
		}
	}

	// Kahn's algorithm
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const g of groups) {
		inDegree.set(g.issueId, 0);
		adj.set(g.issueId, []);
	}
	for (const [issueId, depSet] of deps) {
		inDegree.set(issueId, (inDegree.get(issueId) ?? 0) + depSet.size);
		for (const dep of depSet) {
			adj.get(dep)?.push(issueId);
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	const sorted: string[] = [];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		sorted.push(current);
		for (const next of adj.get(current) ?? []) {
			const newDeg = (inDegree.get(next) ?? 1) - 1;
			inDegree.set(next, newDeg);
			if (newDeg === 0) queue.push(next);
		}
	}

	if (sorted.length < groups.length) {
		log.warn("Circular cross-issue dependencies detected — using severity-based order.");
		return groups;
	}

	const orderMap = new Map(sorted.map((id, idx) => [id, idx]));
	return [...groups].sort(
		(a, b) => (orderMap.get(a.issueId) ?? 0) - (orderMap.get(b.issueId) ?? 0),
	);
}

export const execPhase: PhaseConfig<IssueGroup, ExecResult> = {
	name: "exec",
	timeout: 20 * 60 * 1000, // 20 min per issue — kill hung processes

	loadItems(store) {
		const tasks = store.loadTasks().filter((t: Task) => t.status === "pending");
		const issues = store
			.loadIssues()
			.filter((i: Issue) => i.status === "CONFIRMED" || i.status === "PARTIAL");
		return topoSortGroups(groupTasksByIssue(tasks, issues));
	},

	buildPrompt(item, _store, config) {
		return buildExecPrompt(item, config);
	},

	parseResponse(_response, item) {
		// Exec doesn't parse AI response — success is determined by process exit code
		return { issueId: item.issueId, taskIds: item.tasks.map((t) => t.id) };
	},

	async saveResults(results, store) {
		// Batch update: load all tasks once, apply all changes, save once
		const allTasks: Task[] = store.loadTasks();
		const taskMap = new Map<string, Task>(allTasks.map((t: Task) => [t.id, t]));
		const timestamp = new Date().toISOString();

		for (const r of results) {
			const group = r.item as IssueGroup;
			const sorted = [...group.tasks].sort((a, b) => a.parallel_group - b.parallel_group);

			const numberToId = new Map<number, string>();
			for (let i = 0; i < sorted.length; i++) {
				numberToId.set(i + 1, sorted[i].id);
			}

			let committedNumbers: Set<number>;

			if (r.success) {
				committedNumbers = await getCommittedTaskNumbers(group.issueId, "HEAD", store.workDir);
			} else {
				const branch = `mh/${group.issueId}`;
				const exists = await branchExists(branch, store.workDir);
				committedNumbers = exists
					? await getCommittedTaskNumbers(group.issueId, branch, store.workDir)
					: new Set();
			}

			const committedIds = new Set<string>();
			for (const [num, id] of numberToId) {
				if (committedNumbers.has(num)) committedIds.add(id);
			}

			for (const groupTask of group.tasks) {
				const task = taskMap.get(groupTask.id);
				if (!task) continue;
				if (committedIds.has(groupTask.id)) {
					task.status = "done";
					task.updated_at = timestamp;
				} else if (r.success) {
					task.status = "pending";
					task.updated_at = timestamp;
				} else {
					task.status = "failed";
					task.error = r.error;
					task.updated_at = timestamp;
				}
			}
		}

		store.saveTasks(allTasks);
		store.refreshStats();
	},
};
