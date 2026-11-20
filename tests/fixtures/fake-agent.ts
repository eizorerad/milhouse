#!/usr/bin/env bun
/**
 * A stand-in for `claude -p` and for `codex exec` (it speaks Codex's event stream when its first argument
 * is `exec`). It answers by the role in the prompt, edits the worktree like an executor would, and
 * journals every call.
 *
 * FAKE_AGENT_STATE: directory for the call journal and counters (required).
 * FAKE_AGENT_SCENARIO: JSON, see `Scenario`.
 */

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface Scenario {
	cost?: number;
	/** Items returned by scan. */
	scan?: Array<{ title: string; severity?: string }>;
	/** Evidence returned by validate, per issue title. */
	evidence?: Record<string, unknown[]>;
	/** Status returned by validate, per issue title. Default CONFIRMED. */
	status?: Record<string, string>;
	/** What exec does, per issue title. Default "ok". */
	exec?: Record<
		string,
		| "ok"
		| "todo-first"
		| "junk-first"
		| "forbidden"
		| "never-commits"
		| "rename-protected"
		| "own-branch"
		| "reset-history"
		| "milhouse-config"
		| "nested-milhouse"
		| "milhouse-link"
	>;
	/** [dependent issue title, base issue title]: the dependent's tasks depend on the base's first task. */
	cross?: Array<[string, string]>;
	/** [dependent task title, base task title]: exact task-to-task dependencies. */
	crossTasks?: Array<[string, string]>;
	/** Reviewer rejects this issue this many times (then approves). Infinity-like: 99. */
	reject?: Record<string, number>;
	/**
	 * Make the call fail like the CLI does (exit 1, is_error) for these roles. `result`: Claude reports it
	 * the way it reports "Not logged in" (the message in `result`), not as an `errors` list.
	 */
	fail?: Record<
		string,
		{ message: string; cost?: number; subtype?: string; times?: number; result?: boolean }
	>;
	/** Return garbage instead of a result event. */
	garbage?: string[];
	/** Answer with prose instead of the JSON that was asked for, on the first call only. */
	proseOnce?: string[];
	/** Sleep this many ms before answering, per role. */
	sleep?: Record<string, number>;
}

const scenario: Scenario = JSON.parse(process.env.FAKE_AGENT_SCENARIO ?? "{}");
const stateDir = process.env.FAKE_AGENT_STATE as string;
mkdirSync(stateDir, { recursive: true });

const prompt = await new Response(Bun.stdin.stream()).text();
const args = process.argv.slice(2);
const codex = args[0] === "exec";
const role = /## Role: (.+)/.exec(prompt)?.[1]?.trim() ?? "unknown";
const issueTitle = /\*\*Title\*\*: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
const issueId = /\*\*ID\*\*: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
const cost = scenario.cost ?? 0.01;

appendFileSync(join(stateDir, "pids"), `${process.pid}\n`);
appendFileSync(
	join(stateDir, "journal.jsonl"),
	`${JSON.stringify({ harness: codex ? "codex" : "claude", role, issueTitle, args, cwd: process.cwd(), prompt })}\n`,
);

/** Calls may run in parallel: take a lock around the read-modify-write. */
function count(key: string): number {
	const lock = join(stateDir, "counters.lock");
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			Bun.sleepSync(2);
		}
	}
	try {
		const file = join(stateDir, "counters.json");
		const counters: Record<string, number> = existsSync(file)
			? JSON.parse(readFileSync(file, "utf-8"))
			: {};
		counters[key] = (counters[key] ?? 0) + 1;
		writeFileSync(file, JSON.stringify(counters));
		return counters[key];
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

const emit = (event: object) => console.log(JSON.stringify(event));

function reply(structured?: unknown, text = "done"): never {
	if (codex) {
		emit({ type: "thread.started", thread_id: "thread-1" });
		emit({ type: "turn.started" });
		emit({
			type: "item.completed",
			item: {
				id: "item_0",
				type: "agent_message",
				text: structured === undefined ? text : JSON.stringify(structured),
			},
		});
		// Codex reports tokens, not dollars: the scenario's cost becomes a token count.
		emit({
			type: "turn.completed",
			usage: {
				input_tokens: Math.round(cost * 100_000),
				cached_input_tokens: 0,
				output_tokens: 100,
			},
		});
		process.exit(0);
	}
	const event = {
		type: "result",
		subtype: "success",
		is_error: false,
		result: structured === undefined ? text : JSON.stringify(structured),
		...(structured === undefined ? {} : { structured_output: structured }),
		total_cost_usd: cost,
	};
	console.log(JSON.stringify(event));
	process.exit(0);
}

function fail(
	message: string,
	failCost = 0,
	subtype = "error_during_execution",
	asResult = false,
): never {
	if (codex) {
		emit({ type: "thread.started", thread_id: "thread-1" });
		emit({ type: "turn.started" });
		emit({ type: "error", message: `Reconnecting... 1/5 (${message})` }); // noise before the end
		emit({ type: "turn.failed", error: { message } });
		process.exit(1);
	}
	emit(
		asResult
			? {
					type: "result",
					subtype: "success",
					is_error: true,
					result: message,
					total_cost_usd: failCost,
				}
			: { type: "result", subtype, is_error: true, errors: [message], total_cost_usd: failCost },
	);
	process.exit(1);
}

const sleepMs = scenario.sleep?.[role];
if (sleepMs) await Bun.sleep(sleepMs);
if (scenario.garbage?.includes(role)) {
	console.log("this is not json");
	process.exit(0);
}
if (scenario.proseOnce?.includes(role) && count(`prose:${role}`) === 1)
	reply(undefined, "Looks fine to me.");
const failure = scenario.fail?.[role];
if (failure && (failure.times === undefined || count(`fail:${role}`) <= failure.times)) {
	fail(failure.message, failure.cost, failure.subtype, failure.result);
}

const git = (...a: string[]) => spawnSync("git", a, { cwd: process.cwd(), encoding: "utf-8" });
const committedBullets = (section: string) => {
	const body = prompt.split(`## ${section}`)[1]?.split(/\n## /)[0] ?? "";
	return [...body.matchAll(/- \[([^\]]+)\] (.+)/g)].map((m) => ({ id: m[1], title: m[2] }));
};
const taskBlocks = (section: string) => {
	const body = prompt.split(`## ${section}`)[1]?.split(/\n## /)[0] ?? "";
	return [...body.matchAll(/### \[([^\]]+)\] (.+)/g)].map((m) => ({ id: m[1], title: m[2] }));
};

switch (role) {
	case "Lead Investigator":
		reply({
			items: (scenario.scan ?? [{ title: "Add greeting" }]).map((item) => ({
				type: "improvement",
				title: item.title,
				rationale: `Because of ${item.title}`,
				severity: item.severity ?? "MEDIUM",
				scope_impact: "src",
				strategy: "do it",
			})),
		});
		break;

	case "Issue Validator":
		reply({
			status: scenario.status?.[issueTitle] ?? "CONFIRMED",
			summary: "ok",
			corrected_description: "",
			evidence: scenario.evidence?.[issueTitle] ?? [
				{ file: "src/app.ts", line_start: 1, line_end: 2, snippet: "export const app = 1;" },
			],
		});
		break;

	case "Planner":
		reply({
			summary: "plan",
			tasks: [
				{
					key: "t1",
					title: `${issueTitle} part 1`,
					description: "first",
					files: ["src/app.ts"],
					depends_on: [],
					checks: [],
					acceptance: ["part 1 exists"],
				},
				{
					key: "t2",
					title: `${issueTitle} part 2`,
					description: "second",
					files: ["src/app.ts"],
					depends_on: ["t1"],
					checks: [],
					acceptance: ["part 2 exists"],
				},
			],
		});
		break;

	case "Consistency Manager": {
		const tasks = taskBlocks("Tasks");
		const cross = (scenario.cross ?? []).flatMap(([dependent, base]) => {
			const target = tasks.find((t) => t.title === `${base} part 1`);
			if (!target) return [];
			return tasks
				.filter((t) => t.title.startsWith(dependent))
				.map((t) => ({ task_id: t.id, depends_on: [target.id], reason: "needs it" }));
		});
		const exact = (scenario.crossTasks ?? []).flatMap(([dependent, base]) => {
			const from = tasks.find((t) => t.title === dependent);
			const to = tasks.find((t) => t.title === base);
			return from && to ? [{ task_id: from.id, depends_on: [to.id], reason: "needs it" }] : [];
		});
		reply({ duplicates: [], cross_dependencies: [...cross, ...exact] });
		break;
	}

	case "Executor": {
		const mode = scenario.exec?.[issueTitle] ?? "ok";
		count(`exec:${issueTitle}`);
		const repairing = prompt.includes("The previous attempt failed");
		const todo = taskBlocks("Tasks to do, in this order");
		const done = committedBullets("Already committed (do not redo)");
		const write = (id: string, text: string) =>
			writeFileSync(join(process.cwd(), `${id}.txt`), `${text}\n`);
		const commit = (id: string, title: string) => {
			git("add", "-A");
			git("commit", "-q", "-m", `[${id}] ${title}`);
		};

		if (mode === "forbidden") writeFileSync(join(process.cwd(), "secrets.env"), "touched\n");
		if (mode === "milhouse-link") {
			mkdirSync(join(process.cwd(), "elsewhere"), { recursive: true });
			writeFileSync(join(process.cwd(), "elsewhere", "config.ts"), "export default {};\n");
			symlinkSync("elsewhere", join(process.cwd(), ".milhouse"));
		}
		if (mode === "nested-milhouse") {
			mkdirSync(join(process.cwd(), "examples", ".milhouse"), { recursive: true });
			writeFileSync(join(process.cwd(), "examples", ".milhouse", "note.txt"), "an example\n");
		}
		if (mode === "milhouse-config") {
			mkdirSync(join(process.cwd(), ".milhouse"), { recursive: true });
			writeFileSync(
				join(process.cwd(), ".milhouse", "config.ts"),
				"export default { gates: {} };\n",
			);
		}
		if (mode === "own-branch") git("checkout", "-q", "-b", `agent-work-${process.pid}`);
		if (mode === "reset-history") {
			git("reset", "-q", "--hard", git("rev-list", "--max-parents=0", "HEAD").stdout.trim());
		}
		if (mode === "rename-protected" && !repairing && todo[0]) {
			git("mv", "src/app.ts", "src/renamed.ts");
			commit(todo[0].id, todo[0].title);
			todo.shift();
		}
		if (repairing && mode === "todo-first") {
			const all = [...done, ...todo];
			for (const task of all) write(task.id, task.title);
			commit(all[0].id, "fix the reported problem");
		} else {
			for (const task of todo) {
				write(task.id, mode === "todo-first" ? "TODO: finish this later" : task.title);
				if (mode !== "never-commits") commit(task.id, task.title);
			}
			if (mode === "junk-first" && !repairing)
				writeFileSync(join(process.cwd(), "junk.txt"), "junk\n");
			if (mode === "junk-first" && repairing)
				rmSync(join(process.cwd(), "junk.txt"), { force: true });
		}
		reply(undefined, "implemented");
		break;
	}

	case "Truth Verifier": {
		const tasks = taskBlocks("Tasks to verify");
		const rejected = (scenario.reject?.[issueTitle] ?? 0) >= count(`review:${issueTitle}`);
		reply({
			summary: rejected ? "rejected" : "approved",
			tasks: tasks.map((t) => ({
				task_id: t.id,
				passed: !rejected,
				reason: rejected ? "criteria not met" : "ok",
			})),
		});
		break;
	}

	default:
		fail(`fake-claude: unknown role "${role}" (issue ${issueId})`);
}
