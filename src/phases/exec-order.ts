/** Which issue runs when: dependency order, severity order, and the commits that show progress. */

import type { RunStore } from "../state.ts";
import type { Issue, Severity, Task } from "../types.ts";

export interface IssueGroup {
	issue: Issue;
	/** In dependency order. */
	tasks: Task[];
	/** Issues that run after this one. A dependency on them is circular and cannot be waited for. */
	later?: string[];
}

/**
 * Ids of tasks from other issues that this issue needs but that are not verified yet. A dependency on an
 * issue that runs later is a cycle between issues: it is ignored, the issues run in severity order.
 */
export function unmetDependencies(group: IssueGroup, all: Task[]): string[] {
	const own = new Set(group.tasks.map((t) => t.id));
	const later = new Set(group.later ?? []);
	const byId = new Map(all.map((t) => [t.id, t]));
	return [...new Set(group.tasks.flatMap((t) => t.depends_on))].filter((id) => {
		const dependency = byId.get(id);
		if (!dependency || own.has(id) || later.has(dependency.issue_id)) return false;
		return dependency.status !== "verified" && dependency.status !== "merged";
	});
}

// ─── Ordering ────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Tasks after the tasks they depend on. A cycle falls back to the given order. */
export function orderTasks(tasks: Task[]): Task[] {
	const known = new Set(tasks.map((t) => t.id));
	const placed = new Set<string>();
	const ordered: Task[] = [];
	while (ordered.length < tasks.length) {
		const open = tasks.filter((t) => !placed.has(t.id));
		const next =
			open.find((t) => t.depends_on.every((dep) => placed.has(dep) || !known.has(dep))) ?? open[0];
		ordered.push(next);
		placed.add(next.id);
	}
	return ordered;
}

/** Issues after the issues they depend on, otherwise most severe first. */
export function orderGroups(groups: IssueGroup[]): IssueGroup[] {
	const issueOf = new Map(groups.flatMap((g) => g.tasks.map((t) => [t.id, g.issue.id] as const)));
	const needs = (group: IssueGroup): string[] =>
		group.tasks
			.flatMap((t) => t.depends_on)
			.map((dep) => issueOf.get(dep))
			.filter((id): id is string => id !== undefined && id !== group.issue.id);

	const bySeverity = [...groups].sort(
		(a, b) =>
			SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] ||
			a.issue.id.localeCompare(b.issue.id),
	);
	const byId = new Map(groups.map((g) => [g.issue.id, g]));
	/** True when `group` needs itself, directly or through other issues. */
	const inCycle = (group: IssueGroup): boolean => {
		const seen = new Set<string>();
		const stack = needs(group);
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (id === group.issue.id) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			const next = byId.get(id);
			if (next) stack.push(...needs(next));
		}
		return false;
	};
	const placed = new Set<string>();
	const ordered: IssueGroup[] = [];
	while (ordered.length < groups.length) {
		const open = bySeverity.filter((g) => !placed.has(g.issue.id));
		// Nothing is ready: there is a cycle. Break it at one of its members, never at an issue that
		// merely depends on the cycle.
		const next =
			open.find((g) => needs(g).every((id) => placed.has(id))) ?? open.find(inCycle) ?? open[0];
		ordered.push(next);
		placed.add(next.issue.id);
	}
	return ordered;
}

export function loadGroups(store: RunStore): IssueGroup[] {
	const issues = new Map(store.loadIssues().map((i) => [i.id, i]));
	const tasks = store.loadTasks();
	const open = new Set(
		tasks.filter((t) => t.status === "pending" || t.status === "failed").map((t) => t.issue_id),
	);
	const groups = [...open].flatMap((id) => {
		const issue = issues.get(id);
		return issue ? [{ issue, tasks: orderTasks(tasks.filter((t) => t.issue_id === id)) }] : [];
	});
	const ordered = orderGroups(groups);
	return ordered.map((group, i) => ({
		...group,
		later: ordered.slice(i + 1).map((g) => g.issue.id),
	}));
}

// ─── Progress tracking through commit subjects ───────────────────────

/** Tasks with a commit whose subject starts with `[<task id>]`. Ids are compared as exact strings. */
export function committedTaskIds(subjects: string[], tasks: Task[]): Set<string> {
	const known = new Set(tasks.map((t) => t.id));
	const found = new Set<string>();
	for (const subject of subjects) {
		const id = /^\[([^\]]+)\]/.exec(subject)?.[1];
		if (id && known.has(id)) found.add(id);
	}
	return found;
}
