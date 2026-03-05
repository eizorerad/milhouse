/**
 * Comprehensive unit tests for exec phase loadItems filtering
 *
 * Tests that loadItems() correctly filters tasks by status:
 * - Includes: pending, failed, merge_error
 * - Excludes: done, skipped, running, blocked
 *
 * @module tests/unit/runner/phases/exec-load-items.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execPhaseConfig } from "../../../../src/runner/phases/exec.ts";
import { createRun } from "../../../../src/state/runs.ts";
import { createTaskForRun } from "../../../../src/state/tasks.ts";
import type { Task } from "../../../../src/state/types.ts";
import { createMockPhaseContext } from "../helpers.ts";

describe("execPhaseConfig.loadItems", () => {
	const testDir = join(process.cwd(), ".test-exec-load-items");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	function createTestTaskData(
		issueId: string,
		overrides: Partial<Omit<Task, "id" | "created_at" | "updated_at">> = {},
	): Omit<Task, "id" | "created_at" | "updated_at"> {
		return {
			title: `Task for ${issueId}`,
			issue_id: issueId,
			status: "pending",
			parallel_group: 0,
			depends_on: [],
			files: [],
			checks: [],
			acceptance: [],
			...overrides,
		};
	}

	// ============================================================================
	// Individual status tests
	// ============================================================================

	it("includes pending tasks", async () => {
		const run = await createRun({ scope: "pending test", workDir: testDir });
		const t1 = createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "pending" }), testDir);
		const t2 = createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "pending" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(2);
		expect(items.map((t) => t.id)).toContain(t1.id);
		expect(items.map((t) => t.id)).toContain(t2.id);
		expect(items.every((t) => t.status === "pending")).toBe(true);
	});

	it("includes failed tasks", async () => {
		const run = await createRun({ scope: "failed test", workDir: testDir });
		const t1 = createTaskForRun(
			run.id,
			createTestTaskData("ISS-1", { status: "failed", error: "Test error" }),
			testDir,
		);
		const t2 = createTaskForRun(
			run.id,
			createTestTaskData("ISS-2", { status: "failed", error: "Another error" }),
			testDir,
		);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(2);
		expect(items.map((t) => t.id)).toContain(t1.id);
		expect(items.map((t) => t.id)).toContain(t2.id);
		expect(items.every((t) => t.status === "failed")).toBe(true);
	});

	it("includes merge_error tasks", async () => {
		const run = await createRun({ scope: "merge_error test", workDir: testDir });
		const t1 = createTaskForRun(
			run.id,
			createTestTaskData("ISS-1", { status: "merge_error", error: "Merge conflict" }),
			testDir,
		);
		const t2 = createTaskForRun(
			run.id,
			createTestTaskData("ISS-2", { status: "merge_error", error: "Another merge issue" }),
			testDir,
		);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(2);
		expect(items.map((t) => t.id)).toContain(t1.id);
		expect(items.map((t) => t.id)).toContain(t2.id);
		expect(items.every((t) => t.status === "merge_error")).toBe(true);
	});

	it("excludes done tasks", async () => {
		const run = await createRun({ scope: "done exclusion", workDir: testDir });
		createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "done" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "done" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(0);
	});

	it("excludes skipped tasks", async () => {
		const run = await createRun({ scope: "skipped exclusion", workDir: testDir });
		createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "skipped" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "skipped" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(0);
	});

	it("excludes running tasks", async () => {
		const run = await createRun({ scope: "running exclusion", workDir: testDir });
		createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "running" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "running" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(0);
	});

	it("excludes blocked tasks", async () => {
		const run = await createRun({ scope: "blocked exclusion", workDir: testDir });
		createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "blocked" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "blocked" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(0);
	});

	// ============================================================================
	// Mixed status tests
	// ============================================================================

	it("includes pending, failed, and merge_error while excluding all others", async () => {
		const run = await createRun({ scope: "mixed status test", workDir: testDir });

		// Tasks that SHOULD be included
		const t1 = createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "pending" }), testDir);
		const t2 = createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "failed" }), testDir);
		const t3 = createTaskForRun(run.id, createTestTaskData("ISS-3", { status: "merge_error" }), testDir);

		// Tasks that should be EXCLUDED
		createTaskForRun(run.id, createTestTaskData("ISS-4", { status: "done" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-5", { status: "skipped" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-6", { status: "running" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-7", { status: "blocked" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(3);
		expect(items.map((t) => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
		expect(items.map((t) => t.status).sort()).toEqual(["pending", "failed", "merge_error"].sort());
	});

	it("returns only executable tasks from a larger set", async () => {
		const run = await createRun({ scope: "large mixed set", workDir: testDir });

		// Create 5 pending, 3 failed, 2 merge_error
		const pending = Array.from({ length: 5 }, (_, i) =>
			createTaskForRun(run.id, createTestTaskData(`PEND-${i}`, { status: "pending" }), testDir),
		);
		const failed = Array.from({ length: 3 }, (_, i) =>
			createTaskForRun(run.id, createTestTaskData(`FAIL-${i}`, { status: "failed" }), testDir),
		);
		const mergeError = Array.from({ length: 2 }, (_, i) =>
			createTaskForRun(run.id, createTestTaskData(`MERGE-${i}`, { status: "merge_error" }), testDir),
		);

		// Create 10 tasks in non-executable states
		Array.from({ length: 10 }, (_, i) =>
			createTaskForRun(
				run.id,
				createTestTaskData(`OTHER-${i}`, { status: i % 2 === 0 ? "done" : "skipped" }),
				testDir,
			),
		);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(10); // 5 + 3 + 2
		expect(items.filter((t) => t.status === "pending").length).toBe(5);
		expect(items.filter((t) => t.status === "failed").length).toBe(3);
		expect(items.filter((t) => t.status === "merge_error").length).toBe(2);
	});

	// ============================================================================
	// Grouping by issue_id
	// ============================================================================

	it("returns tasks from multiple issues with mixed statuses", async () => {
		const run = await createRun({ scope: "multi-issue test", workDir: testDir });

		// Issue 1: pending and failed
		const i1t1 = createTaskForRun(run.id, createTestTaskData("ISSUE-1", { status: "pending" }), testDir);
		const i1t2 = createTaskForRun(run.id, createTestTaskData("ISSUE-1", { status: "failed" }), testDir);

		// Issue 2: merge_error and done (done excluded)
		const i2t1 = createTaskForRun(run.id, createTestTaskData("ISSUE-2", { status: "merge_error" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISSUE-2", { status: "done" }), testDir);

		// Issue 3: all done (all excluded)
		createTaskForRun(run.id, createTestTaskData("ISSUE-3", { status: "done" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(3);
		expect(items.map((t) => t.id).sort()).toEqual([i1t1.id, i1t2.id, i2t1.id].sort());

		// Verify issue grouping
		const issue1Tasks = items.filter((t) => t.issue_id === "ISSUE-1");
		const issue2Tasks = items.filter((t) => t.issue_id === "ISSUE-2");
		const issue3Tasks = items.filter((t) => t.issue_id === "ISSUE-3");

		expect(issue1Tasks.length).toBe(2);
		expect(issue2Tasks.length).toBe(1);
		expect(issue3Tasks.length).toBe(0);
	});

	// ============================================================================
	// Edge cases
	// ============================================================================

	it("returns empty array when no tasks exist", async () => {
		const run = await createRun({ scope: "empty test", workDir: testDir });
		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items).toEqual([]);
	});

	it("returns empty array when all tasks are in non-executable states", async () => {
		const run = await createRun({ scope: "all non-executable", workDir: testDir });
		createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "done" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "skipped" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-3", { status: "running" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-4", { status: "blocked" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(0);
	});

	it("handles tasks without issue_id", async () => {
		const run = await createRun({ scope: "no issue_id", workDir: testDir });
		const t1 = createTaskForRun(
			run.id,
			createTestTaskData("", { status: "pending", issue_id: undefined }),
			testDir,
		);
		const t2 = createTaskForRun(
			run.id,
			createTestTaskData("", { status: "failed", issue_id: undefined }),
			testDir,
		);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		expect(items.length).toBe(2);
		expect(items.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
	});

	// ============================================================================
	// Consistency with customExecute
	// ============================================================================

	it("filters the same tasks as customExecute would (pending + failed + merge_error)", async () => {
		const run = await createRun({ scope: "customExecute consistency", workDir: testDir });

		// Create various task statuses
		const pending1 = createTaskForRun(run.id, createTestTaskData("ISS-1", { status: "pending" }), testDir);
		const pending2 = createTaskForRun(run.id, createTestTaskData("ISS-2", { status: "pending" }), testDir);
		const failed1 = createTaskForRun(run.id, createTestTaskData("ISS-3", { status: "failed" }), testDir);
		const mergeErr1 = createTaskForRun(run.id, createTestTaskData("ISS-4", { status: "merge_error" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-5", { status: "done" }), testDir);
		createTaskForRun(run.id, createTestTaskData("ISS-6", { status: "skipped" }), testDir);

		const ctx = createMockPhaseContext({ runId: run.id, workDir: testDir });
		const items = execPhaseConfig.loadItems(ctx);

		// loadItems should return the same tasks that customExecute filters on line 443
		expect(items.length).toBe(4);
		const ids = items.map((t) => t.id).sort();
		expect(ids).toEqual([pending1.id, pending2.id, failed1.id, mergeErr1.id].sort());

		// Verify each returned task has an executable status
		expect(items.every((t) => ["pending", "failed", "merge_error"].includes(t.status))).toBe(true);
	});
});
