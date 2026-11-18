import { afterEach, describe, expect, it } from "bun:test";
import { formatReport, generateReport } from "../src/report.ts";
import { RunStore } from "../src/state.ts";
import type { Issue, Task } from "../src/types.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
	id,
	type: "bug",
	title: `Title of ${id}`,
	rationale: "r",
	severity: "HIGH",
	status: "CONFIRMED",
	evidence: [],
	...over,
});

const task = (id: string, issue_id: string, over: Partial<Task> = {}): Task => ({
	id,
	issue_id,
	title: id,
	description: "",
	files: [],
	depends_on: [],
	checks: [],
	acceptance: [],
	status: "merged",
	...over,
});

function sampleStore(): RunStore {
	const store = RunStore.create(tempDir(), "fix auth", { branch: "main", sha: "abc" });
	store.saveIssues([
		issue("P1"),
		issue("P2", { status: "FALSE", severity: "LOW" }),
		issue("P3", { severity: "CRITICAL" }),
	]);
	store.saveTasks([
		task("T1", "P1"),
		task("T2", "P1"),
		task("T3", "P3", { status: "failed", error: "tests failed\nmore detail" }),
		task("T4", "P3", { status: "failed", error: "same issue again" }),
	]);
	store.saveCost({ total: 1.5, byPhase: { scan: 0.5, exec: 1 } });
	store.finish("failed");
	return store;
}

describe("generateReport", () => {
	it("counts issues and tasks and lists one failure per issue", () => {
		const report = generateReport(sampleStore());
		expect(report.issues).toEqual({
			total: 3,
			byStatus: { CONFIRMED: 2, FALSE: 1 },
		});
		expect(report.tasks).toEqual({ total: 4, byStatus: { merged: 2, failed: 2 } });
		expect(report.failures).toEqual([{ issue: "Title of P3", error: "tests failed\nmore detail" }]);
		expect(report.cost.total).toBe(1.5);
	});

	it("handles a run with no issues at all", () => {
		const store = RunStore.create(tempDir(), undefined, { branch: "main", sha: "abc" });
		const report = generateReport(store);
		expect(report.issues.total).toBe(0);
		expect(formatReport(report, "terminal")).toContain("0 found: none");
	});
});

describe("formatReport", () => {
	it("prints a compact terminal report", () => {
		const text = formatReport(generateReport(sampleStore()), "terminal");
		expect(text).toContain("(failed)");
		expect(text).toContain("Scope:    fix auth");
		expect(text).toContain("3 found: 2 confirmed, 1 false");
		expect(text).toContain("4 total: 2 merged, 2 failed");
		expect(text).toContain("$1.50 (scan $0.50, exec $1.00)");
		expect(text).toContain("- Title of P3: tests failed"); // first line of the error only
		expect(text).not.toContain("more detail");
	});

	it("prints markdown with headings", () => {
		const text = formatReport(generateReport(sampleStore()), "md");
		expect(text).toContain("# Milhouse run report");
		for (const heading of ["## Issues", "## Tasks", "## Cost", "## Failed"])
			expect(text).toContain(heading);
		expect(text).toContain("**Scope**: fix auth");
	});

	it("omits the failure section when nothing failed", () => {
		const store = sampleStore();
		store.updateTasks(["T3", "T4"], { status: "merged", error: undefined });
		const text = formatReport(generateReport(store), "terminal");
		expect(text).not.toContain("Failed");
	});
});
