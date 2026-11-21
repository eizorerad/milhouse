/** Run report, derived from the state files. */

import { formatCost } from "./cost.ts";
import type { RunStore } from "./state.ts";
import type { Issue, RunCost, RunMeta, Task, TaskStatus } from "./types.ts";
import { formatDuration } from "./ui.ts";

export const REPORT_FORMATS = ["terminal", "md", "json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** One issue with what was decided about it and what became of its tasks. */
export interface IssueReport {
	title: string;
	severity: Issue["severity"];
	status: Issue["status"];
	/** The validator's reason for the status. */
	reason?: string;
	tasks: Array<{ title: string; status: TaskStatus; sha?: string }>;
}

export interface RunReport {
	meta: RunMeta;
	issues: { total: number; byStatus: Record<string, number> };
	/** Every issue with its tasks, in the order the scan reported them. */
	details: IssueReport[];
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
	const tasksOf = (issueId: string): Task[] => tasks.filter((t) => t.issue_id === issueId);
	return {
		meta,
		issues: {
			total: issues.length,
			byStatus: countBy(issues, (i) => i.status),
		},
		details: issues.map((issue) => ({
			title: issue.title,
			severity: issue.severity,
			status: issue.status,
			...(issue.verdict_reason ? { reason: issue.verdict_reason } : {}),
			tasks: tasksOf(issue.id).map(({ title, status, sha }) => ({
				title,
				status,
				...(sha ? { sha } : {}),
			})),
		})),
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

/** An issue and its tasks, as lines of the report. */
function issueLines(
	{ title, severity, status, reason, tasks }: IssueReport,
	md: boolean,
): string[] {
	const why = reason ? `: ${reason.replace(/\s+/g, " ").trim()}` : "";
	const head = `[${severity}] ${title} (${status.toLowerCase()}${why})`;
	const commit = (sha?: string) =>
		sha ? ` ${md ? `\`${sha.slice(0, 8)}\`` : sha.slice(0, 8)}` : "";
	return [
		md ? `- ${head}` : `  ${head}`,
		...tasks.map((t) =>
			md
				? `  - ${t.status}: ${t.title}${commit(t.sha)}`
				: `      ${t.status.padEnd(8)} ${t.title}${commit(t.sha)}`,
		),
	];
}

export function formatReport(report: RunReport, format: ReportFormat): string {
	if (format === "json") return JSON.stringify(report, null, 2);
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
		...report.details.flatMap((issue) => issueLines(issue, md)),
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
