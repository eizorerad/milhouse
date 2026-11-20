/** plan: break each actionable issue into small tasks in execution order. */

import { context, describeIssue, feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import { arrayOf, object } from "../schema.ts";
import { ACTIONABLE, type Config, type Issue, type Task } from "../types.ts";
import { generateId, parseJson, stringList, stripControl } from "../util.ts";

/** The prompt asks for 1-5; this only keeps a runaway answer from flooding the later phases. */
const MAX_TASKS = 10;

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

const PLAN_SCHEMA = object({
	summary: { type: "string" },
	tasks: arrayOf(
		object({
			key: { type: "string" },
			title: { type: "string" },
			description: { type: "string" },
			files: strings,
			depends_on: strings,
			checks: strings,
			acceptance: strings,
		}),
	),
});

function planPrompt(issue: Issue, config: Config, lastError?: string): string {
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
				"Start with the code that already owns this behaviour. Prefer the direct change that fits the project; add a dependency, configuration option or abstraction only when a current requirement calls for it.",
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

/**
 * The planner's tasks, checked here (not later, where a failure would not be retried): what the pipeline
 * needs must be there, what a model left out is filled in.
 */
export function parseTasks(text: string): RawTask[] {
	const { tasks } = parseJson<{ tasks?: unknown }>(text, "Plan");
	if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Plan: the plan has no tasks");
	const parsed = tasks.slice(0, MAX_TASKS).map((raw, index): RawTask => {
		const task = (raw ?? {}) as Record<string, unknown>;
		const title = typeof task.title === "string" ? stripControl(task.title.trim()) : "";
		const key = typeof task.key === "string" ? task.key.trim() : "";
		if (!title) throw new Error(`Plan: task ${index + 1} needs a title`);
		if (!key) throw new Error(`Plan: task ${index + 1} ("${title}") needs a key`);
		return {
			key,
			title,
			description: typeof task.description === "string" ? task.description : "",
			files: stringList(task.files),
			depends_on: stringList(task.depends_on),
			checks: stringList(task.checks),
			acceptance: stringList(task.acceptance),
		};
	});
	if (new Set(parsed.map((t) => t.key)).size !== parsed.length) {
		throw new Error("Plan: task keys must be unique");
	}
	return parsed;
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
		});
		return parseTasks(text);
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
