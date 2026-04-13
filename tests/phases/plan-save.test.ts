/**
 * Tests for plan phase idempotency.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPhase } from "../../src/phases/plan.ts";
import { RunStore } from "../../src/state.ts";
import type { Issue, PhaseResult } from "../../src/types.ts";

function makeIssue(id: string): Issue {
	const timestamp = "2026-01-01T00:00:00Z";
	return {
		id,
		type: "bug",
		title: `Issue ${id}`,
		rationale: "",
		severity: "HIGH",
		status: "CONFIRMED",
		evidence: [],
		created_at: timestamp,
		updated_at: timestamp,
	};
}

function makePlanResult(
	issue: Issue,
	title: string,
): PhaseResult<{
	issue_id: string;
	summary: string;
	tasks: Array<{ title: string; files?: string[] }>;
}> {
	return {
		item: issue,
		result: {
			issue_id: issue.id,
			summary: "Plan summary",
			tasks: [{ title, files: ["src/app.ts"] }],
		},
		success: true,
		tokens: { response: "", inputTokens: 0, outputTokens: 0 },
	};
}

describe("plan saveResults", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-plan-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("skips issues that already have tasks", () => {
		const store = RunStore.create(tmpDir, "scope");
		const issue = makeIssue("P-1");

		store.saveIssues([issue]);
		store.saveTasks([
			{
				id: "T-existing",
				issue_id: issue.id,
				title: "Existing task",
				files: [],
				depends_on: [],
				checks: [],
				acceptance: [],
				parallel_group: 0,
				status: "pending",
				created_at: issue.created_at,
				updated_at: issue.updated_at,
			},
		]);

		expect(planPhase.loadItems(store, {} as never)).toEqual([]);
	});

	it("replaces tasks for the same issue instead of appending duplicates", () => {
		const store = RunStore.create(tmpDir, "scope");
		const issue = makeIssue("P-1");

		store.saveIssues([issue]);

		planPhase.saveResults([makePlanResult(issue, "Task A")], store);
		const firstTasks = store.loadTasks();
		expect(firstTasks).toHaveLength(1);
		expect(firstTasks[0].title).toBe("Task A");

		planPhase.saveResults([makePlanResult(issue, "Task B")], store);
		const secondTasks = store.loadTasks();

		expect(secondTasks).toHaveLength(1);
		expect(secondTasks[0].title).toBe("Task B");
		expect(secondTasks[0].issue_id).toBe(issue.id);
		expect(store.loadMeta()).toMatchObject({ tasks_total: 1 });
	});
});
