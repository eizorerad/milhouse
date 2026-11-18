/** plan: break each actionable issue into small tasks in execution order. */

import { context, describeIssue, feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import { ACTIONABLE, type Config, type Issue, type Task } from "../types.ts";
import { generateId, parseJson } from "../util.ts";

const MINUTE = 60_000;

export interface RawTask {
	key: string;
	title: string;
	description: string;
	files: string[];
	depends_on: string[];
	checks: string[];
	acceptance: string[];
}

const strings = { type: "array", items: { type: "string" } } as const;

export const PLAN_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					key: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
					files: strings,
					depends_on: strings,
					checks: strings,
					acceptance: strings,
				},
				required: ["key", "title", "description", "files", "depends_on", "checks", "acceptance"],
				additionalProperties: false,
			},
		},
	},
	required: ["summary", "tasks"],
	additionalProperties: false,
} as const;

export function planPrompt(issue: Issue, config: Config, lastError?: string): string {
	return prompt(
		role(
			"Planner",
			"You break one validated work item into a small, ordered work breakdown. You can only read files.",
		),
		describeIssue(issue),
		context(config),
		section(
			"Task",
			[
				"Break the issue into as few small tasks as will do (1-5), in execution order. Each task is one logical change that fits in one commit. A fix and its test belong in the same task.",
				"Every task must leave the repository green: the build, lint and tests pass after its commit. Never plan a task whose purpose is a failing test, a red/green split or any broken intermediate state.",
				"- key: a short local name such as t1, t2",
				"- depends_on: keys of EARLIER tasks it needs (never later ones)",
				"- files: every file the task will change",
				"- checks: shell commands that EXIT 0 when the task is done (never negated checks)",
				"- acceptance: 1-3 short, observable outcomes in the final code or behaviour that a reviewer can verify by reading the diff. Do not write process steps (which commands to run, what to stage), do not dictate commit messages (Milhouse sets them), and do not pin exact line numbers or counts.",
			].join("\n"),
		),
		feedback(lastError),
	);
}

/** Turn the planner's tasks into stored tasks: local keys become ids, dependencies only point backwards. */
export function buildTasks(issueId: string, raw: RawTask[]): Task[] {
	const ids = new Map(raw.map((task) => [task.key, generateId("T")]));
	return raw.map((task, index) => {
		const earlier = new Set(raw.slice(0, index).map((t) => t.key));
		return {
			id: ids.get(task.key) as string,
			issue_id: issueId,
			title: task.title.trim(),
			description: task.description,
			files: task.files,
			depends_on: task.depends_on
				.filter((key) => earlier.has(key))
				.map((key) => ids.get(key) as string),
			checks: task.checks,
			acceptance: task.acceptance,
			status: "pending",
		};
	});
}

export const planPhase: PhaseDef<Issue, RawTask[]> = {
	name: "plan",

	loadItems(store) {
		return store.loadIssues().filter((i) => ACTIONABLE.includes(i.status) && !i.planned);
	},

	label: (issue) => issue.title.slice(0, 50),

	async run(issue, ctx) {
		const text = await ctx.ask(planPrompt(issue, ctx.config, ctx.lastError), {
			schema: PLAN_SCHEMA,
			maxTurns: 30,
			timeoutMs: 5 * MINUTE,
		});
		const { tasks } = parseJson<{ tasks?: RawTask[] }>(text, "Plan");
		if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Plan: the plan has no tasks");
		if (tasks.some((t) => !t.title?.trim())) throw new Error("Plan: every task needs a title");
		if (new Set(tasks.map((t) => t.key)).size !== tasks.length)
			throw new Error("Plan: task keys must be unique");
		return tasks;
	},

	record(issue, outcome, store) {
		if (!outcome.ok) return;
		// Replacing (not appending) keeps this idempotent if a crash left the issue unmarked.
		const others = store
			.loadTasks()
			.filter((t) => t.issue_id !== issue.id || t.status !== "pending");
		store.saveTasks([...others, ...buildTasks(issue.id, outcome.value)]);
		store.updateIssue(issue.id, { planned: true });
	},
};
