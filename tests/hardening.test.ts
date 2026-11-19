/** Unit tests for the safety and consistency fixes found by review. */

import { afterEach, describe, expect, it } from "bun:test";
import { loadGroups, unmetDependencies } from "../src/phases/exec-order.ts";
import { execPhase, rejectionReasons } from "../src/phases/exec.ts";
import { planPhase } from "../src/phases/plan.ts";
import { RunStore } from "../src/state.ts";
import type { Issue } from "../src/types.ts";
import { BASE, cleanupTempDirs, makeIssue, makeTask, tempDir, testConfig } from "./helpers.ts";

afterEach(cleanupTempDirs);

describe("unmetDependencies", () => {
	const group = {
		issue: makeIssue("P2"),
		tasks: [makeTask("B1", { issue_id: "P2", depends_on: ["A1", "B0", "ghost"] })],
	};

	it("lists tasks of other issues that are not verified or merged yet", () => {
		const all = [makeTask("A1", { status: "failed" }), group.tasks[0]];
		expect(unmetDependencies(group, all)).toEqual(["A1"]);
		expect(
			unmetDependencies(group, [makeTask("A1", { status: "pending" }), group.tasks[0]]),
		).toEqual(["A1"]);
	});

	it("is satisfied by verified and merged tasks, ignores its own tasks and unknown ids", () => {
		expect(
			unmetDependencies(group, [makeTask("A1", { status: "verified" }), group.tasks[0]]),
		).toEqual([]);
		expect(
			unmetDependencies(group, [makeTask("A1", { status: "merged" }), group.tasks[0]]),
		).toEqual([]);
		const own = { ...group, tasks: [makeTask("B1", { depends_on: ["B0"] }), makeTask("B0")] };
		expect(unmetDependencies(own, own.tasks)).toEqual([]);
	});
});

describe("rejectionReasons", () => {
	const tasks = [makeTask("A", { title: "First" }), makeTask("B", { title: "Second" })];

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
			makeIssue("fresh"),
			makeIssue("planned", { planned: true }),
			makeIssue("false", { status: "FALSE" }),
			makeIssue("misdiagnosed", { status: "MISDIAGNOSED" }),
		]);
		const items = planPhase.loadItems(store, testConfig()) as Issue[];
		expect(items.map((i) => i.id)).toEqual(["fresh", "misdiagnosed"]);
	});

	it("marks the issue as planned when the plan is recorded", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([makeIssue("P1")]);
		const raw = {
			key: "t1",
			title: "Do it",
			description: "",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
		};
		planPhase.record(makeIssue("P1"), { ok: true, value: [raw] }, store);
		expect(store.loadIssues()[0].planned).toBe(true);
		expect(store.loadTasks()).toHaveLength(1);
		expect(planPhase.loadItems(store, testConfig())).toEqual([]);
	});
});

describe("fixes found by the final review", () => {
	it("records a plan idempotently: a crash between the tasks and the planned flag cannot duplicate them", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([makeIssue("P1")]);
		const raw = {
			key: "t1",
			title: "Do it",
			description: "",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
		};
		planPhase.record(makeIssue("P1"), { ok: true, value: [raw] }, store);
		planPhase.record(makeIssue("P1"), { ok: true, value: [raw] }, store); // the same plan again
		expect(store.loadTasks()).toHaveLength(1);

		// A task that already moved on is never replaced.
		store.updateTasks([store.loadTasks()[0].id], { status: "verified" });
		planPhase.record(makeIssue("P1"), { ok: true, value: [raw] }, store);
		expect(
			store
				.loadTasks()
				.map((t) => t.status)
				.sort(),
		).toEqual(["pending", "verified"]);
	});

	it("ignores a dependency on an issue that runs later (a cycle between issues)", () => {
		const a = {
			issue: makeIssue("A"),
			tasks: [makeTask("A2", { issue_id: "A", depends_on: ["B1"] })],
			later: ["B"],
		};
		const all = [...a.tasks, makeTask("B1", { issue_id: "B", status: "pending" })];
		expect(unmetDependencies(a, all)).toEqual([]);
		expect(unmetDependencies({ ...a, later: [] }, all)).toEqual(["B1"]);
	});

	it("tells each issue which issues run after it", async () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([makeIssue("A", { severity: "HIGH" }), makeIssue("B", { severity: "LOW" })]);
		store.saveTasks([
			makeTask("A1", { issue_id: "A", depends_on: ["B1"] }),
			makeTask("B1", { issue_id: "B", depends_on: ["A1"] }),
		]);
		const groups = loadGroups(store);
		expect(groups.map((g) => [g.issue.id, g.later])).toEqual([
			["A", ["B"]],
			["B", []],
		]);
	});

	it("keeps the start of a failure message: its prefix tells reviewer outages from real failures", async () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveTasks([makeTask("T1")]);
		const group = { issue: makeIssue("P1"), tasks: [makeTask("T1")] };
		const outage = `The review could not be completed: ${"x".repeat(5000)}`;
		await execPhase.record(group, { ok: false, error: outage }, store);
		const [stored] = store.loadTasks();
		expect(stored.error?.startsWith("The review could not be completed")).toBe(true);
		expect(stored.error).toHaveLength(2000);
	});
});
