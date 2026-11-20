/** Run report, derived from the state files. */

import { formatCost } from "./cost.ts";
import type { RunStore } from "./state.ts";
import type { RunCost, RunMeta, TaskStatus } from "./types.ts";
import { formatDuration } from "./ui.ts";

export interface RunReport {
	meta: RunMeta;
	issues: { total: number; byStatus: Record<string, number> };
	/** `checked`: accepted tasks (verified or merged) for which a project command passed. */
	tasks: { total: number; byStatus: Record<string, number>; checked: number };
	/** One entry per issue with failed tasks. */
	failures: Array<{ issue: string; error: string }>;
	cost: RunCost;
	durationMs: number;
}

const ACCEPTED: TaskStatus[] = ["verified", "merged"];

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
	return counts;
}

export function generateReport(store: RunStore): RunReport {
	const meta = store.loadMeta();
	const issues = store.loadIssues();
	const tasks = store.loadTasks();
	const titles = new Map(issues.map((i) => [i.id, i.title]));

	const failed = new Map<string, string>();
	for (const task of tasks) {
		if (task.status === "failed" && !failed.has(task.issue_id))
			failed.set(task.issue_id, task.error ?? "failed");
	}
	return {
		meta,
		issues: {
			total: issues.length,
			byStatus: countBy(issues, (i) => i.status),
		},
		tasks: {
			total: tasks.length,
			byStatus: countBy(tasks, (t) => t.status),
			checked: tasks.filter((t) => ACCEPTED.includes(t.status) && t.checks_passed).length,
		},
		failures: [...failed].map(([id, error]) => ({ issue: titles.get(id) ?? id, error })),
		cost: store.loadCost(),
		durationMs: new Date(meta.updated_at).getTime() - new Date(meta.created_at).getTime(),
	};
}

const counts = (byKey: Record<string, number>): string =>
	Object.entries(byKey)
		.map(([key, n]) => `${n} ${key.toLowerCase()}`)
		.join(", ") || "none";

export function formatReport(report: RunReport, format: "terminal" | "md"): string {
	const { meta, issues, tasks, failures, cost } = report;
	const md = format === "md";
	const accepted = (tasks.byStatus.verified ?? 0) + (tasks.byStatus.merged ?? 0);
	const heading = (text: string) => (md ? `\n## ${text}\n` : `\n${text}:`);
	const lines = [
		md ? "# Milhouse run report" : `Run ${meta.id} (${meta.status})`,
		md ? `\n**Run**: ${meta.id} (${meta.status})` : "",
		meta.scope ? `${md ? "**Scope**: " : "Scope:    "}${meta.scope}` : "",
		`${md ? "**Duration**: " : "Duration: "}${formatDuration(report.durationMs)}`,
		heading("Issues"),
		`${issues.total} found: ${counts(issues.byStatus)}`,
		heading("Tasks"),
		`${tasks.total} total: ${counts(tasks.byStatus)}`,
		accepted > 0 ? `${tasks.checked} of ${accepted} accepted tasks passed a project check` : "",
		heading("Cost"),
		formatCost(cost),
	];
	if (failures.length > 0) {
		lines.push(heading("Failed"));
		for (const { issue, error } of failures) lines.push(`- ${issue}: ${error.split("\n")[0]}`);
	}
	return lines.filter((line) => line !== "").join("\n");
}
