/**
 * Exec phase — execute tasks in worktrees.
 * Uses the same PhaseConfig interface as all other phases.
 * Worktree management is handled by the runner.
 */

import { branchExists, getCommittedTaskNumbers } from "../git.ts";
import { buildExecPrompt } from "../prompts/exec.ts";
import type { RunStore } from "../state.ts";
import type { Config, Issue, IssueGroup, PhaseConfig, Task } from "../types.ts";

interface ExecResult {
	issueId: string;
	taskIds: string[];
}

/**
 * Group tasks by issue_id.
 */
function groupTasksByIssue(tasks: Task[], issues: Issue[]): IssueGroup[] {
	const issueMap = new Map(issues.map(i => [i.id, i]));
	const groups = new Map<string, Task[]>();

	for (const task of tasks) {
		const key = task.issue_id || "UNASSIGNED";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(task);
	}

	const result: IssueGroup[] = [];
	for (const [issueId, issueTasks] of groups) {
		const issue = issueMap.get(issueId) ?? {
			id: issueId, type: "task" as const, title: `Work item ${issueId}`,
			rationale: "Derived from tasks", severity: "MEDIUM" as const,
			status: "CONFIRMED" as const, evidence: [],
			created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
		};
		result.push({ issueId, issue, tasks: issueTasks });
	}

	// Sort by severity
	const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
	return result.sort((a, b) => (order[a.issue.severity] ?? 4) - (order[b.issue.severity] ?? 4));
}

export const execPhase: PhaseConfig<IssueGroup, ExecResult> = {
	name: "exec",
	timeout: 20 * 60 * 1000, // 20 min per issue — kill hung processes

	loadItems(store) {
		const tasks = store.loadTasks().filter((t: Task) => t.status === "pending");
		const issues = store.loadIssues().filter((i: Issue) => i.status === "CONFIRMED" || i.status === "PARTIAL");
		return groupTasksByIssue(tasks, issues);
	},

	buildPrompt(item, _store, config) {
		return buildExecPrompt(item, config);
	},

	parseResponse(_response, item) {
		// Exec doesn't parse AI response — success is determined by process exit code
		return { issueId: item.issueId, taskIds: item.tasks.map(t => t.id) };
	},

	async saveResults(results, store) {
		// Batch update: load all tasks once, apply all changes, save once
		const allTasks: Task[] = store.loadTasks();
		const taskMap = new Map<string, Task>(allTasks.map((t: Task) => [t.id, t]));
		let completed = 0;
		let failed = 0;
		const timestamp = new Date().toISOString();

		for (const r of results) {
			const group = r.item as IssueGroup;
			const sorted = [...group.tasks].sort((a, b) => a.parallel_group - b.parallel_group);

			// Build a map from task number (1-indexed) to task id
			const numberToId = new Map<number, string>();
			for (let i = 0; i < sorted.length; i++) {
				numberToId.set(i + 1, sorted[i].id);
			}

			let committedNumbers: Set<number>;

			if (r.success) {
				// Success path: commits are on HEAD after merge
				committedNumbers = await getCommittedTaskNumbers(group.issueId, "HEAD", store.workDir);
			} else {
				// Failure path: check if branch still exists for partial commits
				const branch = `mh/${group.issueId}`;
				const exists = await branchExists(branch, store.workDir);
				committedNumbers = exists
					? await getCommittedTaskNumbers(group.issueId, branch, store.workDir)
					: new Set();
			}

			// Determine which task ids were committed
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
					completed++;
				} else if (r.success) {
					// Success but task wasn't committed — leave as pending
					task.status = "pending";
					task.updated_at = timestamp;
				} else {
					task.status = "failed";
					task.error = r.error;
					task.updated_at = timestamp;
					failed++;
				}
			}
		}

		store.saveTasks(allTasks);
		store.updateStats({ tasks_completed: completed, tasks_failed: failed });
	},
};
