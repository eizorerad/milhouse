/** Unit tests for the safety and consistency fixes found by review. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CostTracker, emptyCost } from "../src/cost.ts";
import { buildArgs } from "../src/engine.ts";
import { runChecks } from "../src/gates.ts";
import { addedLines, revParse } from "../src/git.ts";
import { loadGroups, unmetDependencies } from "../src/phases/exec-order.ts";
import { execPhase, rejectionReasons } from "../src/phases/exec.ts";
import { planPhase } from "../src/phases/plan.ts";
import { type Outcome, type PhaseDef, Skip, runPhase } from "../src/runner.ts";
import { RunStore } from "../src/state.ts";
import type { Issue, Task } from "../src/types.ts";
import { stripControl } from "../src/util.ts";
import {
	cleanupTempDirs,
	commitFile,
	git,
	makeRepo,
	resetFakeAgentEnv,
	tempDir,
	testConfig,
	useFakeAgent,
	writeFile,
} from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

const BASE = { branch: "main", sha: "abc" };

const task = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	issue_id: "P1",
	title: id,
	description: "",
	files: [],
	depends_on: [],
	checks: [],
	acceptance: [],
	status: "pending",
	...over,
});

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
	id,
	type: "bug",
	title: id,
	rationale: "r",
	severity: "HIGH",
	status: "CONFIRMED",
	evidence: [],
	...over,
});

describe("unmetDependencies", () => {
	const group = {
		issue: issue("P2"),
		tasks: [task("B1", { issue_id: "P2", depends_on: ["A1", "B0", "ghost"] })],
	};

	it("lists tasks of other issues that are not verified or merged yet", () => {
		const all = [task("A1", { status: "failed" }), group.tasks[0]];
		expect(unmetDependencies(group, all)).toEqual(["A1"]);
		expect(unmetDependencies(group, [task("A1", { status: "pending" }), group.tasks[0]])).toEqual([
			"A1",
		]);
	});

	it("is satisfied by verified and merged tasks, ignores its own tasks and unknown ids", () => {
		expect(unmetDependencies(group, [task("A1", { status: "verified" }), group.tasks[0]])).toEqual(
			[],
		);
		expect(unmetDependencies(group, [task("A1", { status: "merged" }), group.tasks[0]])).toEqual(
			[],
		);
		const own = { ...group, tasks: [task("B1", { depends_on: ["B0"] }), task("B0")] };
		expect(unmetDependencies(own, own.tasks)).toEqual([]);
	});
});

describe("rejectionReasons", () => {
	const tasks = [task("A", { title: "First" }), task("B", { title: "Second" })];

	it("passes only an explicit true", () => {
		const verdicts = [
			{ task_id: "A", passed: true, reason: "fine" },
			{ task_id: "B", passed: "false" as unknown as boolean, reason: "the string is not a pass" },
		];
		expect(rejectionReasons(verdicts, tasks)).toEqual(["[B] Second: the string is not a pass"]);
		expect(
			rejectionReasons(
				[{ task_id: "A", passed: undefined as unknown as boolean, reason: "x" }],
				tasks,
			),
		).toHaveLength(1);
		expect(rejectionReasons([{ task_id: "A", passed: true, reason: "ok" }], tasks)).toEqual([]);
	});
});

describe("planning", () => {
	it("does not plan an issue again, even when consolidate removed all of its tasks", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([
			issue("fresh"),
			issue("planned", { planned: true }),
			issue("false", { status: "FALSE" }),
			issue("misdiagnosed", { status: "MISDIAGNOSED" }),
		]);
		const items = planPhase.loadItems(store, testConfig()) as Issue[];
		expect(items.map((i) => i.id)).toEqual(["fresh", "misdiagnosed"]);
	});

	it("marks the issue as planned when the plan is recorded", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([issue("P1")]);
		const raw = {
			key: "t1",
			title: "Do it",
			description: "",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
		};
		planPhase.record(issue("P1"), { ok: true, value: [raw] }, store);
		expect(store.loadIssues()[0].planned).toBe(true);
		expect(store.loadTasks()).toHaveLength(1);
		expect(planPhase.loadItems(store, testConfig())).toEqual([]);
	});
});

describe("run ids", () => {
	it("only accepts ids that are safe as paths and ref names", () => {
		const dir = tempDir();
		for (const bad of ["../x", "run-/../x", "run-a b", "x", "", "run-é", "run-a/b"]) {
			expect(() => new RunStore(dir, bad)).toThrow(/Invalid run id/);
		}
		expect(new RunStore(dir, "run-20260101-abc_DEF-1").ref).toBe(
			"refs/milhouse/run-20260101-abc_DEF-1",
		);
	});

	it("treats a path-like --run-id as simply not found", () => {
		expect(() => RunStore.byId(tempDir(), "../../etc")).toThrow(/not found/);
	});

	it("takes the id from the directory name, never from the file content, and skips foreign directories", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, "real", BASE);
		const runs = join(dir, ".milhouse", "runs");
		// A repository could ship a run whose meta.json claims another id.
		const fake = join(runs, "run-planted");
		mkdirSync(fake);
		writeFileSync(
			join(fake, "meta.json"),
			JSON.stringify({
				id: "../../../victim",
				status: "completed",
				created_at: "2000-01-01T00:00:00Z",
				done: [],
			}),
		);
		mkdirSync(join(runs, "not-a-run"));
		writeFileSync(join(runs, "not-a-run", "meta.json"), "{}");

		const ids = RunStore.list(dir).map((r) => r.id);
		expect(ids).toEqual(["run-planted", store.runId]);
		expect(RunStore.clean(dir, 1)).toEqual(["run-planted"]); // removes only its own directory
		expect(RunStore.list(dir).map((r) => r.id)).toEqual([store.runId]);
	});

	it("never follows a planted symlink when writing state", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, BASE);
		const victim = join(tempDir(), "victim.txt");
		writeFileSync(victim, "precious");
		const runDir = join(dir, ".milhouse", "runs", store.runId);
		symlinkSync(victim, join(runDir, "tasks.json.tmp"));
		store.saveTasks([task("T1")]);
		expect(store.loadTasks()).toHaveLength(1);
		expect(require("node:fs").readFileSync(victim, "utf-8")).toBe("precious");
	});
});

describe("engine arguments", () => {
	it("never loads the repository's own Claude settings", () => {
		const args = buildArgs({ tools: "read" });
		expect(args.join(" ")).toContain("--setting-sources user");
		expect(buildArgs({ tools: "all" }).join(" ")).toContain("--setting-sources user");
	});
});

describe("stripControl", () => {
	it("removes terminal escape sequences and control characters, keeps text, tabs and newlines", () => {
		expect(stripControl("a\u001b[31mred\u001b[0m\u0007 b\tc\nd\u0085e")).toBe(
			"a[31mred[0m b\tc\nde",
		);
		expect(stripControl("plain ünïcode ✓")).toBe("plain ünïcode ✓");
	});
});

describe("runPhase edge cases", () => {
	function setup(budget = 0) {
		const store = RunStore.create(tempDir(), undefined, BASE);
		const config = testConfig({ budget, phases: { validate: { retries: 2, workers: 1 } } });
		return { store, config, cost: new CostTracker(emptyCost(), budget, () => {}) };
	}
	const phase = (
		run: PhaseDef<number, string>["run"],
		items = [1],
	): PhaseDef<number, string> & { recorded: number[] } => {
		const recorded: number[] = [];
		return {
			name: "validate",
			loadItems: () => items,
			label: (n) => `item ${n}`,
			run,
			record: (item) => {
				recorded.push(item);
			},
			recorded,
		};
	};

	it("leaves a skipped item alone: nothing is recorded and it is not a failure to retry", async () => {
		const { store, config, cost } = setup();
		const def = phase(
			async (n) => {
				if (n === 1) throw new Skip("waiting for something");
				return "done";
			},
			[1, 2],
		);
		const outcomes = await runPhase(def, store, config, cost);
		expect(outcomes[0]).toEqual({ ok: false, error: "waiting for something", skipped: true });
		expect(outcomes[1]).toEqual({ ok: true, value: "done" });
		expect(def.recorded).toEqual([2]);
	});

	it("keeps the real error when the budget runs out between attempts", async () => {
		const { store, config, cost } = setup(0.5);
		const def = phase(async () => {
			cost.add("validate", 1); // this attempt spends the whole budget and fails
			throw new Error("tests failed: boom");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		const error = (outcome as { error: string }).error;
		expect(error).toContain("tests failed: boom");
		expect(error).toContain("budget is used up");
		expect((outcome as { skipped?: boolean }).skipped).toBe(false); // it was attempted: record it
		expect(def.recorded).toEqual([1]);
	});

	it("refuses to start an agent call without budget instead of spawning one that cannot run", async () => {
		const fake = useFakeAgent({});
		const { store, config, cost } = setup(1);
		const def = phase(async (_n, ctx) => {
			cost.add("validate", 1); // budget gone before the call
			return ctx.ask("## Role: Planner");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		expect(fake.journal()).toHaveLength(0);
	});

	it("strips terminal escape sequences from error messages it reports", async () => {
		const { store, config, cost } = setup();
		const def = phase(async () => {
			throw new Error("bad \u001b[2J news");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect((outcome as Outcome<string> & { error: string }).error).toBe("bad [2J news");
	});
});

describe("fixes found by the final review", () => {
	it("treats a timed-out check as a failure even when the shell itself exited 0", async () => {
		const dir = tempDir();
		// The shell exits at once; the background child keeps the output pipe open until it is killed.
		const failure = await runChecks([["test", "sleep 30 & exit 0"]], dir, 300);
		expect(failure).toContain("timed out");
	});

	it("still finds added lines when the user's git config adds diff context", async () => {
		const repo = await makeRepo();
		await git(repo, "config", "diff.interHunkContext", "3");
		await git(repo, "config", "diff.context", "5");
		await commitFile(
			repo,
			"long.txt",
			Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
			"long",
		);
		const base = await revParse(repo, "HEAD");
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		lines[3] = "changed 3";
		lines[6] = "// TODO changed 6";
		writeFile(repo, "long.txt", lines.join("\n"));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "edit");
		expect((await addedLines(repo, base)).map((a) => a.text)).toEqual([
			"changed 3",
			"// TODO changed 6",
		]);
	});

	it("records a plan idempotently: a crash between the tasks and the planned flag cannot duplicate them", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([issue("P1")]);
		const raw = {
			key: "t1",
			title: "Do it",
			description: "",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
		};
		planPhase.record(issue("P1"), { ok: true, value: [raw] }, store);
		planPhase.record(issue("P1"), { ok: true, value: [raw] }, store); // the same plan again
		expect(store.loadTasks()).toHaveLength(1);

		// A task that already moved on is never replaced.
		store.updateTasks([store.loadTasks()[0].id], { status: "verified" });
		planPhase.record(issue("P1"), { ok: true, value: [raw] }, store);
		expect(
			store
				.loadTasks()
				.map((t) => t.status)
				.sort(),
		).toEqual(["pending", "verified"]);
	});

	it("ignores a dependency on an issue that runs later (a cycle between issues)", () => {
		const a = {
			issue: issue("A"),
			tasks: [task("A2", { issue_id: "A", depends_on: ["B1"] })],
			later: ["B"],
		};
		const all = [...a.tasks, task("B1", { issue_id: "B", status: "pending" })];
		expect(unmetDependencies(a, all)).toEqual([]);
		expect(unmetDependencies({ ...a, later: [] }, all)).toEqual(["B1"]);
	});

	it("tells each issue which issues run after it", async () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([issue("A", { severity: "HIGH" }), issue("B", { severity: "LOW" })]);
		store.saveTasks([
			task("A1", { issue_id: "A", depends_on: ["B1"] }),
			task("B1", { issue_id: "B", depends_on: ["A1"] }),
		]);
		const groups = loadGroups(store);
		expect(groups.map((g) => [g.issue.id, g.later])).toEqual([
			["A", ["B"]],
			["B", []],
		]);
	});

	it("keeps the start of a failure message: its prefix tells reviewer outages from real failures", async () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveTasks([task("T1")]);
		const group = { issue: issue("P1"), tasks: [task("T1")] };
		const outage = `The review could not be completed: ${"x".repeat(5000)}`;
		await execPhase.record(group, { ok: false, error: outage }, store);
		const [stored] = store.loadTasks();
		expect(stored.error?.startsWith("The review could not be completed")).toBe(true);
		expect(stored.error).toHaveLength(2000);
	});

	it("records the commit that was accepted for a task", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveTasks([task("T1")]);
		store.updateTasks(["T1"], { sha: "abc123" });
		expect(store.loadTasks()[0].sha).toBe("abc123");
	});
});
