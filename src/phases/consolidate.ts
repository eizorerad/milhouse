/** consolidate: remove duplicate tasks across issues and add dependencies between issues. */

import { feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import type { Task } from "../types.ts";
import { log } from "../ui.ts";
import { MINUTE, parseJson, stringList } from "../util.ts";

export interface Consolidation {
	duplicates: Array<{ keep: string; remove: string[] }>;
	cross_dependencies: Array<{ task_id: string; depends_on: string[] }>;
}

const ids = { type: "array", items: { type: "string" } } as const;

const CONSOLIDATE_SCHEMA = {
	type: "object",
	properties: {
		duplicates: {
			type: "array",
			items: {
				type: "object",
				properties: { keep: { type: "string" }, remove: ids, reason: { type: "string" } },
				required: ["keep", "remove", "reason"],
				additionalProperties: false,
			},
		},
		cross_dependencies: {
			type: "array",
			items: {
				type: "object",
				properties: { task_id: { type: "string" }, depends_on: ids, reason: { type: "string" } },
				required: ["task_id", "depends_on", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["duplicates", "cross_dependencies"],
	additionalProperties: false,
} as const;

function consolidatePrompt(tasks: Task[], lastError?: string): string {
	const list = tasks
		.map(
			(t) =>
				`### [${t.id}] ${t.title}\n- issue: ${t.issue_id}\n- files: ${t.files.join(", ") || "none"}\n- depends on: ${t.depends_on.join(", ") || "none"}`,
		)
		.join("\n\n");
	return prompt(
		role(
			"Consistency Manager",
			"You reconcile the task lists of several issues into one execution plan. Issues are executed one after another; everything an earlier issue built is in place when the next one starts. You can only read files.",
		),
		section("Tasks", list),
		section(
			"Task",
			[
				"1. duplicates: tasks that do the same work (usually in different issues). Keep one, list the others in `remove`.",
				"2. cross_dependencies: a task that needs the result of a task from ANOTHER issue: shared files, shared interfaces, or tests that only pass once the other issue's fix is in. This decides which issue runs first, so declare every such link.",
				"Use only the ids listed above. Return empty lists when nothing applies.",
			].join("\n"),
		),
		feedback(lastError),
	);
}

/** The consolidator's answer. Both lists must be there (empty when nothing applies); malformed entries are dropped. */
export function parseConsolidation(text: string): Consolidation {
	const result = parseJson<{ duplicates?: unknown; cross_dependencies?: unknown }>(
		text,
		"Consolidate",
	);
	if (!Array.isArray(result.duplicates) || !Array.isArray(result.cross_dependencies)) {
		throw new Error(
			"Consolidate: the answer needs `duplicates` and `cross_dependencies` lists (empty when nothing applies)",
		);
	}
	const entries = (list: unknown[]): Array<Record<string, unknown>> =>
		list.filter(
			(entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
		);
	return {
		duplicates: entries(result.duplicates)
			.filter((d) => typeof d.keep === "string")
			.map((d) => ({ keep: d.keep as string, remove: stringList(d.remove) })),
		cross_dependencies: entries(result.cross_dependencies)
			.filter((d) => typeof d.task_id === "string")
			.map((d) => ({ task_id: d.task_id as string, depends_on: stringList(d.depends_on) })),
	};
}

/** Follow `from -> to` redirects to the final id. A redirect only joins the ends of two chains, so there is no cycle. */
function resolveId(redirect: Map<string, string>, id: string): string {
	let current = id;
	while (redirect.has(current)) current = redirect.get(current) as string;
	return current;
}

/** True when `from` depends on `target`, directly or through other tasks. */
function dependsOn(tasks: Task[], from: string, target: string, seen = new Set<string>()): boolean {
	if (seen.has(from)) return false;
	seen.add(from);
	const deps = tasks.find((t) => t.id === from)?.depends_on ?? [];
	return deps.includes(target) || deps.some((dep) => dependsOn(tasks, dep, target, seen));
}

/**
 * Apply the consolidator's answer defensively: unknown ids and self references are ignored,
 * dependents of a removed task move to the task that was kept, and no dependency may close a cycle.
 */
export function applyConsolidation(tasks: Task[], result: Consolidation): Task[] {
	const known = new Set(tasks.map((t) => t.id));
	const redirect = new Map<string, string>();
	for (const { keep, remove } of result.duplicates ?? []) {
		if (!known.has(keep) || redirect.has(keep)) continue;
		for (const id of remove) {
			if (id !== keep && known.has(id) && !redirect.has(id)) redirect.set(id, keep);
		}
	}

	// The survivor keeps its own acceptance criteria: criteria of two differently worded plans for the
	// same work tend to contradict each other when merged.
	let current = tasks
		.filter((t) => !redirect.has(t.id))
		.map((t) => ({
			...t,
			depends_on: [
				...new Set(
					t.depends_on
						.map((dep) => resolveId(redirect, dep))
						.filter((dep) => dep !== t.id && known.has(dep)),
				),
			],
		}));

	for (const { task_id, depends_on } of result.cross_dependencies ?? []) {
		const taskId = resolveId(redirect, task_id);
		for (const dep of depends_on.map((id) => resolveId(redirect, id))) {
			const task = current.find((t) => t.id === taskId);
			const exists = current.some((t) => t.id === dep);
			if (!task || !exists || dep === taskId || task.depends_on.includes(dep)) continue;
			if (dependsOn(current, dep, taskId)) continue; // would close a cycle
			current = current.map((t) =>
				t.id === taskId ? { ...t, depends_on: [...t.depends_on, dep] } : t,
			);
		}
	}
	return current;
}

export const consolidatePhase: PhaseDef<Task[], Consolidation> = {
	name: "consolidate",

	loadItems(store) {
		const pending = store.loadTasks().filter((t) => t.status === "pending");
		return pending.length > 1 ? [pending] : [];
	},

	label: () => "consolidate",

	async run(tasks, ctx) {
		const text = await ctx.ask(consolidatePrompt(tasks, ctx.lastError), {
			schema: CONSOLIDATE_SCHEMA,
			maxTurns: 20,
			timeoutMs: 5 * MINUTE,
		});
		return parseConsolidation(text);
	},

	record(_tasks, outcome, store) {
		if (!outcome.ok) return;
		const before = store.loadTasks();
		const after = applyConsolidation(before, outcome.value);
		store.saveTasks(after);
		log.info(`consolidate: ${before.length - after.length} duplicate task(s) removed`);
	},
};
