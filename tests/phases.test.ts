import { describe, expect, it } from "bun:test";
import { applyConsolidation } from "../src/phases/consolidate.ts";
import {
	type IssueGroup,
	committedTaskIds,
	orderGroups,
	orderTasks,
} from "../src/phases/exec-order.ts";
import { execPrompt, reviewPrompt } from "../src/phases/exec-prompts.ts";
import { parseVerdicts } from "../src/phases/exec.ts";
import { type RawTask, buildTasks } from "../src/phases/plan.ts";
import { context, describeIssue } from "../src/prompts.ts";
import type { Issue, Severity, Task } from "../src/types.ts";
import { testConfig } from "./helpers.ts";

const task = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	issue_id: "P1",
	title: `Title ${id}`,
	description: "",
	files: [],
	depends_on: [],
	checks: [],
	acceptance: [],
	status: "pending",
	...over,
});

const issue = (id: string, severity: Severity = "MEDIUM"): Issue => ({
	id,
	type: "bug",
	title: `Issue ${id}`,
	rationale: "because",
	severity,
	status: "CONFIRMED",
	evidence: [],
});

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

describe("applyConsolidation", () => {
	const none = { duplicates: [], cross_dependencies: [] };

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
