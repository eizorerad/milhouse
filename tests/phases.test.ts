import { afterEach, describe, expect, it } from "bun:test";
import { applyConsolidation, parseConsolidation } from "../src/phases/consolidate.ts";
import {
	type IssueGroup,
	committedTaskIds,
	loadGroups,
	orderGroups,
	orderTasks,
	unmetDependencies,
} from "../src/phases/exec-order.ts";
import { execPrompt, reviewPrompt } from "../src/phases/exec-prompts.ts";
import { execPhase, parseVerdicts, rejectionReasons } from "../src/phases/exec.ts";
import { type RawTask, buildTasks, parseTasks, planPhase } from "../src/phases/plan.ts";
import { parseItems } from "../src/phases/scan.ts";
import { context, describeIssue } from "../src/prompts.ts";
import { RunStore } from "../src/state.ts";
import type { Issue, Severity, Task } from "../src/types.ts";
import { BASE, cleanupTempDirs, makeIssue, makeTask, tempDir, testConfig } from "./helpers.ts";

afterEach(cleanupTempDirs);

/** Tasks titled "Title <id>"; issues titled "Issue <id>", of MEDIUM severity unless a test says so. */
const task = (id: string, over: Partial<Task> = {}) =>
	makeTask(id, { title: `Title ${id}`, ...over });
const issue = (id: string, severity: Severity = "MEDIUM") =>
	makeIssue(id, { title: `Issue ${id}`, rationale: "because", severity });

const none = { duplicates: [], cross_dependencies: [] };

const group = (id: string, tasks: Task[], severity: Severity = "MEDIUM"): IssueGroup => ({
	issue: issue(id, severity),
	tasks,
});

describe("buildTasks", () => {
	const raw = (key: string, deps: string[] = []): RawTask => ({
		key,
		title: ` ${key} title `,
		description: "d",
		files: ["a.ts"],
		depends_on: deps,
		checks: ["bun test"],
		acceptance: ["works"],
	});

	it("maps local keys to generated ids and starts every task as pending", () => {
		const tasks = buildTasks("P1", [raw("t1"), raw("t2", ["t1"]), raw("t3", ["t1", "t2"])]);
		expect(new Set(tasks.map((t) => t.id)).size).toBe(3);
		expect(tasks[1].depends_on).toEqual([tasks[0].id]);
		expect(tasks[2].depends_on).toEqual([tasks[0].id, tasks[1].id]);
		expect(tasks.every((t) => t.status === "pending" && t.issue_id === "P1")).toBe(true);
		expect(tasks[0].title).toBe("t1 title");
	});

	it("drops dependencies on later, unknown or its own key (no cycles, no dangling ids)", () => {
		const tasks = buildTasks("P1", [raw("t1", ["t2", "t1", "ghost"]), raw("t2", ["t1"])]);
		expect(tasks[0].depends_on).toEqual([]);
		expect(tasks[1].depends_on).toEqual([tasks[0].id]);
	});
});

describe("parseTasks (the planner's answer is checked before it is used)", () => {
	const answer = (tasks: unknown) => JSON.stringify({ summary: "s", tasks });

	it("fills in what a model left out and keeps the rest", () => {
		const [task] = parseTasks(answer([{ key: "t1", title: " Fix it " }]));
		expect(task).toEqual({
			key: "t1",
			title: "Fix it",
			description: "",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
		});
	});

	it("rejects answers the rest of the pipeline could not use, so the planner is asked again", () => {
		expect(() => parseTasks(answer([]))).toThrow(/no tasks/);
		expect(() => parseTasks(answer([{ key: "t1" }]))).toThrow(/task 1 needs a title/);
		expect(() => parseTasks(answer([{ title: "x" }]))).toThrow(/needs a key/);
		expect(() => parseTasks(answer([null]))).toThrow(/needs a title/);
		expect(() =>
			parseTasks(
				answer([
					{ key: "t1", title: "a" },
					{ key: "t1", title: "b" },
				]),
			),
		).toThrow(/unique/);
		expect(() => parseTasks("no json here")).toThrow(/no JSON/);
	});

	it("ignores entries that are not strings and caps the number of tasks", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, title: `Task ${i}` }));
		expect(parseTasks(answer(many))).toHaveLength(10);
		const [task] = parseTasks(
			answer([{ key: "t1", title: "x", files: ["a.ts", 3, null], checks: "no" }]),
		);
		expect(task.files).toEqual(["a.ts"]);
		expect(task.checks).toEqual([]);
	});
});

describe("planning", () => {
	/** The planner's answer for issue P1: a plan of one task. */
	const raw: RawTask = {
		key: "t1",
		title: "Do it",
		description: "",
		files: [],
		depends_on: [],
		checks: [],
		acceptance: [],
	};

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
		planPhase.record(makeIssue("P1"), { ok: true, value: [raw] }, store);
		expect(store.loadIssues()[0].planned).toBe(true);
		expect(store.loadTasks()).toHaveLength(1);
		expect(planPhase.loadItems(store, testConfig())).toEqual([]);
	});

	it("records a plan idempotently: a crash between the tasks and the planned flag cannot duplicate them", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveIssues([makeIssue("P1")]);
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
});

describe("parseItems (the scanner's answer)", () => {
	it("keeps real items, repairs odd severities and types, and caps the list", () => {
		const items = parseItems(
			JSON.stringify({
				items: [
					{ type: "bug", title: " Real bug ", rationale: "r", severity: "high" },
					{ title: "No other fields" },
					{ title: "   " },
					null,
					{ type: "weird", title: "Odd type", severity: "URGENT" },
				],
			}),
		);
		expect(items.map((i) => i.title)).toEqual(["Real bug", "No other fields", "Odd type"]);
		expect(items[0]).toMatchObject({ type: "bug", severity: "HIGH", rationale: "r" });
		expect(items[1]).toMatchObject({ type: "task", severity: "MEDIUM", rationale: "" });
		expect(items[2]).toMatchObject({ type: "task", severity: "MEDIUM" });
		const many = { items: Array.from({ length: 40 }, (_, i) => ({ title: `Item ${i}` })) };
		expect(parseItems(JSON.stringify(many))).toHaveLength(10);
	});

	it("fails when there is no list", () => {
		expect(() => parseItems(JSON.stringify({ result: "nothing" }))).toThrow(/no `items` list/);
	});
});

describe("parseConsolidation", () => {
	it("needs both lists, even when they are empty", () => {
		expect(() => parseConsolidation("{}")).toThrow(/`duplicates` and `cross_dependencies`/);
		expect(() => parseConsolidation(JSON.stringify({ duplicates: [] }))).toThrow(
			/cross_dependencies/,
		);
		expect(parseConsolidation(JSON.stringify({ duplicates: [], cross_dependencies: [] }))).toEqual(
			none,
		);
	});

	it("drops malformed entries instead of crashing later", () => {
		const parsed = parseConsolidation(
			JSON.stringify({
				duplicates: [null, { keep: "A", remove: ["B", 7] }, { remove: ["C"] }, "x"],
				cross_dependencies: [
					{ task_id: "B", depends_on: "A" },
					{ task_id: "C", depends_on: ["A"] },
					5,
				],
			}),
		);
		expect(parsed.duplicates).toEqual([{ keep: "A", remove: ["B"] }]);
		expect(parsed.cross_dependencies).toEqual([
			{ task_id: "B", depends_on: [] },
			{ task_id: "C", depends_on: ["A"] },
		]);
	});
});

describe("applyConsolidation", () => {
	it("removes duplicates and redirects their dependents; the survivor keeps only its own criteria", () => {
		const tasks = [
			task("A", { acceptance: ["a1"] }),
			task("B", { acceptance: ["b1 (contradicts a1)"] }),
			task("C", { depends_on: ["B"] }),
		];
		const result = applyConsolidation(tasks, {
			...none,
			duplicates: [{ keep: "A", remove: ["B"] }],
		});
		expect(result.map((t) => t.id)).toEqual(["A", "C"]);
		expect(result[0].acceptance).toEqual(["a1"]);
		expect(result[1].depends_on).toEqual(["A"]);
	});

	it("follows chains of duplicates and ignores unknown ids and self-removal", () => {
		const tasks = [task("A"), task("B"), task("C", { depends_on: ["A"] })];
		const result = applyConsolidation(tasks, {
			...none,
			duplicates: [
				{ keep: "A", remove: ["A", "ghost"] },
				{ keep: "B", remove: ["A"] },
			],
		});
		expect(result.map((t) => t.id)).toEqual(["B", "C"]);
		expect(result[1].depends_on).toEqual(["B"]);
	});

	it("adds cross dependencies but never a self edge, an unknown id or a cycle", () => {
		const tasks = [
			task("A", { issue_id: "P1" }),
			task("B", { issue_id: "P2" }),
			task("C", { issue_id: "P3", depends_on: ["B"] }),
		];
		const result = applyConsolidation(tasks, {
			...none,
			cross_dependencies: [
				{ task_id: "B", depends_on: ["A", "B", "ghost"] },
				{ task_id: "A", depends_on: ["C"] }, // C -> B -> A already: would close a cycle
			],
		});
		const byId = Object.fromEntries(result.map((t) => [t.id, t.depends_on]));
		expect(byId).toEqual({ A: [], B: ["A"], C: ["B"] });
	});

	it("survives a malformed answer", () => {
		const tasks = [task("A")];
		expect(applyConsolidation(tasks, {} as never)).toEqual(tasks);
	});
});

describe("ordering", () => {
	it("orders tasks after their dependencies and falls back to the given order on a cycle", () => {
		const ordered = orderTasks([
			task("C", { depends_on: ["B"] }),
			task("B", { depends_on: ["A"] }),
			task("A"),
		]);
		expect(ordered.map((t) => t.id)).toEqual(["A", "B", "C"]);
		const cycle = orderTasks([task("X", { depends_on: ["Y"] }), task("Y", { depends_on: ["X"] })]);
		expect(cycle.map((t) => t.id)).toEqual(["X", "Y"]);
	});

	it("ignores dependencies on tasks outside the issue", () => {
		expect(
			orderTasks([task("B", { depends_on: ["elsewhere"] }), task("A")]).map((t) => t.id),
		).toEqual(["B", "A"]);
	});

	it("runs issues by severity, but after the issues they depend on", () => {
		const low = group("low", [task("t-low", { issue_id: "low" })], "LOW");
		const critical = group(
			"critical",
			[task("t-crit", { issue_id: "critical", depends_on: ["t-low"] })],
			"CRITICAL",
		);
		const high = group("high", [task("t-high", { issue_id: "high" })], "HIGH");
		expect(orderGroups([low, critical, high]).map((g) => g.issue.id)).toEqual([
			"high",
			"low",
			"critical",
		]);
		expect(orderGroups([low, high]).map((g) => g.issue.id)).toEqual(["high", "low"]);
	});

	it("does not hang on dependency cycles between issues", () => {
		const a = group("a", [task("ta", { issue_id: "a", depends_on: ["tb"] })], "HIGH");
		const b = group("b", [task("tb", { issue_id: "b", depends_on: ["ta"] })], "LOW");
		expect(orderGroups([b, a]).map((g) => g.issue.id)).toEqual(["a", "b"]);
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
});

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
});

describe("committedTaskIds", () => {
	const tasks = [task("T-1"), task("T-2"), task("T-10")];

	it("matches the exact id in the subject prefix", () => {
		const found = committedTaskIds(["[T-1] first", "[T-10] tenth", "unrelated"], tasks);
		expect([...found].sort()).toEqual(["T-1", "T-10"]);
	});

	it("is not fooled by other brackets, ids of other issues or ids in the middle of a subject", () => {
		const found = committedTaskIds(
			["[T-99] other issue", "fix [T-2] later", "[WIP] [T-2] x", "[T-1 ] spaced"],
			tasks,
		);
		expect([...found]).toEqual([]);
	});
});

describe("parseVerdicts", () => {
	const tasks = [task("A"), task("B")];
	const answer = (verdicts: unknown[]) => JSON.stringify({ summary: "s", tasks: verdicts });
	const verdict = (task_id: string, passed = true) => ({ task_id, passed, reason: "r" });

	it("accepts exactly one verdict per task", () => {
		expect(parseVerdicts(answer([verdict("A"), verdict("B", false)]), tasks)).toHaveLength(2);
	});

	it("rejects missing, unknown and duplicate verdicts and malformed answers", () => {
		expect(() => parseVerdicts(answer([verdict("A")]), tasks)).toThrow(/no verdict for B/);
		expect(() => parseVerdicts(answer([verdict("A"), verdict("B"), verdict("Z")]), tasks)).toThrow(
			/unknown task id Z/,
		);
		expect(() => parseVerdicts(answer([verdict("A"), verdict("A"), verdict("B")]), tasks)).toThrow(
			/two verdicts/,
		);
		expect(() => parseVerdicts(JSON.stringify({ summary: "s" }), tasks)).toThrow(/no `tasks` list/);
		expect(() => parseVerdicts("not json", tasks)).toThrow(/no JSON/);
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

describe("execPhase.record", () => {
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

describe("prompts", () => {
	const config = testConfig({
		project: { name: "demo", language: "TypeScript" },
		commands: { test: "bun test" },
		rules: ["Use tabs"],
		neverTouch: ["migrations/**"],
	});

	it("injects project info, commands, rules and forbidden paths", () => {
		const text = context(config);
		for (const expected of ["demo, TypeScript", "test: `bun test`", "Use tabs", "`migrations/**`"])
			expect(text).toContain(expected);
	});

	it("is empty for an empty config (no stray headings)", () => {
		expect(context(testConfig())).toBe("");
	});

	it("describes an issue with its corrected description and evidence", () => {
		const text = describeIssue({
			...issue("P1"),
			corrected_description: "really this",
			evidence: [{ file: "a.ts", line_start: 3, line_end: 5, snippet: "x" }],
		});
		expect(text).toContain("really this");
		expect(text).toContain("`a.ts:3-5`");
	});

	it("tells the executor what is left, what is done and what failed before", () => {
		const t1 = task("T-1", { title: "First", checks: ["bun test"], acceptance: ["it works"] });
		const t2 = task("T-2", { title: "Second" });
		const text = execPrompt(group("P1", [t1, t2]), [t1], config, "tests failed: boom");
		expect(text).toContain("### [T-2] Second");
		expect(text).not.toContain("### [T-1] First");
		expect(text).toContain("- [T-1] First"); // listed as already committed
		expect(text).toContain("tests failed: boom");
		expect(text).toContain("`[<task id>] <task title>`");
	});

	it("handles an executor prompt where everything is committed and only a fix is left", () => {
		const t1 = task("T-1");
		const text = execPrompt(group("P1", [t1]), [t1], config, "review said no");
		expect(text).toContain("Every task is committed already");
		expect(text).toContain("review said no");
	});

	it("gives the reviewer the diff, truncating huge ones", () => {
		const g = group("P1", [task("T-1", { acceptance: ["does x"] })]);
		const small = reviewPrompt(g, " a.ts | 1 +", "+added", config);
		expect(small).toContain("+added");
		expect(small).toContain("does x");
		expect(small).not.toContain("truncated");
		const huge = reviewPrompt(g, "stat", "+".repeat(200_000), config);
		expect(huge).toContain("truncated");
		expect(huge.length).toBeLessThan(150_000);
	});
});
