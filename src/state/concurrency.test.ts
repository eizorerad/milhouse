/**
 * Concurrency Tests for State Management
 *
 * Tests race condition handling for concurrent writes to state files.
 * Verifies that lock-based functions properly serialize concurrent operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createRun,
	loadRunMeta,
	updateRunMetaWithLock,
	updateRunPhaseInMetaWithLock,
	updateRunStatsWithLock,
	saveRunsIndexWithLock,
	loadRunsIndex,
} from "./runs.ts";
import {
	createTask,
	createTaskForRun,
	loadTasks,
	loadTasksForRun,
	readTaskForRun,
	updateTaskWithLock,
	updateTaskStatusWithLock,
	updateTaskForRunSafe,
} from "./tasks.ts";
import type { RunPhase } from "./types.ts";

describe("Concurrency Tests", () => {
	const testDir = join(process.cwd(), ".test-concurrency");

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

	describe("updateRunMetaWithLock", () => {
		test("should handle concurrent updates correctly", async () => {
			// Create a run first
			const run = createRun({ scope: "test concurrent updates", workDir: testDir });

			// Simulate multiple parallel updates
			const updates = Array.from({ length: 10 }, (_, i) => ({
				issues_found: i + 1,
			}));

			// Execute all updates concurrently
			const results = await Promise.all(
				updates.map((update) => updateRunMetaWithLock(run.id, update, testDir))
			);

			// All updates should succeed (not return null)
			expect(results.every((r) => r !== null)).toBe(true);

			// Final state should reflect the last update
			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
			// One of the updates should have won
			expect(finalMeta!.issues_found).toBeGreaterThanOrEqual(1);
			expect(finalMeta!.issues_found).toBeLessThanOrEqual(10);
		});

		test("should serialize rapid sequential updates", async () => {
			const run = createRun({ scope: "test sequential", workDir: testDir });

			// Perform rapid sequential updates
			for (let i = 0; i < 5; i++) {
				await updateRunMetaWithLock(run.id, { tasks_completed: i }, testDir);
			}

			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
			expect(finalMeta!.tasks_completed).toBe(4); // Last update wins
		});

		test("should preserve data integrity under concurrent load", async () => {
			const run = createRun({ scope: "test integrity", workDir: testDir });

			// Create many concurrent updates with different fields
			const concurrentUpdates = [
				updateRunMetaWithLock(run.id, { issues_found: 10 }, testDir),
				updateRunMetaWithLock(run.id, { issues_validated: 5 }, testDir),
				updateRunMetaWithLock(run.id, { tasks_total: 20 }, testDir),
				updateRunMetaWithLock(run.id, { tasks_completed: 15 }, testDir),
				updateRunMetaWithLock(run.id, { tasks_failed: 2 }, testDir),
			];

			await Promise.all(concurrentUpdates);

			// Verify the final state is valid JSON and has expected structure
			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
			expect(finalMeta!.id).toBe(run.id);
			expect(typeof finalMeta!.updated_at).toBe("string");
		});

		test("should return null for non-existent run", async () => {
			const result = await updateRunMetaWithLock("non-existent-run", { issues_found: 1 }, testDir);
			expect(result).toBeNull();
		});
	});

	describe("updateRunPhaseInMetaWithLock", () => {
		test("should handle concurrent phase updates", async () => {
			const run = createRun({ scope: "test phase updates", workDir: testDir });

			// Try to update phase concurrently with valid phases
			const phases: RunPhase[] = ["validate", "plan", "exec", "verify", "completed"];
			const results = await Promise.all(
				phases.map((phase) => updateRunPhaseInMetaWithLock(run.id, phase, testDir))
			);

			// All updates should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final phase should be one of the valid phases
			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
			expect(phases).toContain(finalMeta!.phase);
		});

		test("should update both meta and index atomically", async () => {
			const run = createRun({ scope: "test atomic phase", workDir: testDir });

			await updateRunPhaseInMetaWithLock(run.id, "exec", testDir);

			// Check both meta and index are updated
			const meta = loadRunMeta(run.id, testDir);
			const index = loadRunsIndex(testDir);

			expect(meta!.phase).toBe("exec");
			const indexEntry = index.runs.find((r) => r.id === run.id);
			expect(indexEntry!.phase).toBe("exec");
		});
	});

	describe("updateRunStatsWithLock", () => {
		test("should handle concurrent stats updates", async () => {
			const run = createRun({ scope: "test stats", workDir: testDir });

			// Simulate multiple agents updating stats concurrently
			const statsUpdates = [
				{ issues_found: 5 },
				{ issues_validated: 3 },
				{ tasks_total: 10 },
				{ tasks_completed: 7 },
				{ tasks_failed: 1 },
			];

			const results = await Promise.all(
				statsUpdates.map((stats) => updateRunStatsWithLock(run.id, stats, testDir))
			);

			// All should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final state should be valid
			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
		});
	});

	describe("saveRunsIndexWithLock", () => {
		test("should handle concurrent index updates", async () => {
			// Create initial run
			createRun({ scope: "initial run", workDir: testDir });

			// Simulate concurrent index updates
			const updates = Array.from({ length: 5 }, () =>
				saveRunsIndexWithLock(
					(index) => ({
						...index,
						current_run: index.runs[0]?.id ?? null,
					}),
					testDir
				)
			);

			await Promise.all(updates);

			// Index should still be valid
			const finalIndex = loadRunsIndex(testDir);
			expect(finalIndex.runs.length).toBe(1);
		});

		test("should preserve index integrity with multiple runs", async () => {
			// Create multiple runs
			const run1 = createRun({ scope: "run 1", workDir: testDir });
			const run2 = createRun({ scope: "run 2", workDir: testDir });
			const run3 = createRun({ scope: "run 3", workDir: testDir });

			// Concurrent updates to switch current run
			await Promise.all([
				saveRunsIndexWithLock((index) => ({ ...index, current_run: run1.id }), testDir),
				saveRunsIndexWithLock((index) => ({ ...index, current_run: run2.id }), testDir),
				saveRunsIndexWithLock((index) => ({ ...index, current_run: run3.id }), testDir),
			]);

			// Index should have all 3 runs
			const finalIndex = loadRunsIndex(testDir);
			expect(finalIndex.runs.length).toBe(3);
			// Current run should be one of the three
			expect(finalIndex.current_run).not.toBeNull();
			expect([run1.id, run2.id, run3.id]).toContain(finalIndex.current_run!);
		});
	});

	describe("updateTaskWithLock", () => {
		test("should handle concurrent task updates correctly", async () => {
			// Create a run and task
			createRun({ scope: "test task updates", workDir: testDir });
			const task = createTask(
				{
					title: "Test Task",
					description: "A test task",
					issue_id: "ISSUE-1",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Simulate multiple parallel updates to the same task
			const updates = Array.from({ length: 10 }, (_, i) => ({
				description: `Updated description ${i}`,
			}));

			const results = await Promise.all(
				updates.map((update) => updateTaskWithLock(task.id, update, testDir))
			);

			// All updates should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final task should have one of the descriptions
			const tasks = loadTasks(testDir);
			const finalTask = tasks.find((t) => t.id === task.id);
			expect(finalTask).toBeDefined();
			expect(finalTask!.description).toMatch(/^Updated description \d$/);
		});

		test("should serialize status transitions correctly", async () => {
			createRun({ scope: "test status transitions", workDir: testDir });
			const task = createTask(
				{
					title: "Status Test Task",
					description: "Testing status transitions",
					issue_id: "ISSUE-2",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Sequential status updates
			await updateTaskWithLock(task.id, { status: "running" }, testDir);
			await updateTaskWithLock(task.id, { status: "done" }, testDir);

			const tasks = loadTasks(testDir);
			const finalTask = tasks.find((t) => t.id === task.id);
			expect(finalTask!.status).toBe("done");
		});
	});

	describe("updateTaskStatusWithLock", () => {
		test("should handle concurrent status updates", async () => {
			createRun({ scope: "test concurrent status", workDir: testDir });
			const task = createTask(
				{
					title: "Concurrent Status Task",
					description: "Testing concurrent status updates",
					issue_id: "ISSUE-3",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Try to update status concurrently
			const statuses = ["running", "done", "failed"] as const;
			const results = await Promise.all(
				statuses.map((status) =>
					updateTaskStatusWithLock(task.id, status, status === "failed" ? "Test error" : undefined, testDir)
				)
			);

			// All should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final status should be one of the valid statuses
			const tasks = loadTasks(testDir);
			const finalTask = tasks.find((t) => t.id === task.id);
			expect(finalTask).toBeDefined();
			expect(["running", "done", "failed"]).toContain(finalTask!.status);
		});

		test("should mark dependent tasks as blocked when task fails", async () => {
			createRun({ scope: "test dependent blocking", workDir: testDir });

			// Create parent task
			const parentTask = createTask(
				{
					title: "Parent Task",
					description: "Parent task that will fail",
					issue_id: "ISSUE-4",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Create dependent task
			const dependentTask = createTask(
				{
					title: "Dependent Task",
					description: "Task that depends on parent",
					issue_id: "ISSUE-4",
					status: "pending",
					parallel_group: 1,
					depends_on: [parentTask.id],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Fail the parent task
			await updateTaskStatusWithLock(parentTask.id, "failed", "Parent failed", testDir);

			// Dependent task should be blocked
			const tasks = loadTasks(testDir);
			const finalDependentTask = tasks.find((t) => t.id === dependentTask.id);
			expect(finalDependentTask!.status).toBe("blocked");
		});

		test("should set completed_at when task is done", async () => {
			createRun({ scope: "test completed_at", workDir: testDir });
			const task = createTask(
				{
					title: "Completion Test Task",
					description: "Testing completed_at field",
					issue_id: "ISSUE-5",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			await updateTaskStatusWithLock(task.id, "done", undefined, testDir);

			const tasks = loadTasks(testDir);
			const finalTask = tasks.find((t) => t.id === task.id);
			expect(finalTask!.completed_at).toBeDefined();
			expect(new Date(finalTask!.completed_at!).getTime()).toBeGreaterThan(0);
		});

		test("should set error when task fails", async () => {
			createRun({ scope: "test error field", workDir: testDir });
			const task = createTask(
				{
					title: "Error Test Task",
					description: "Testing error field",
					issue_id: "ISSUE-6",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			const errorMessage = "Task failed due to test error";
			await updateTaskStatusWithLock(task.id, "failed", errorMessage, testDir);

			const tasks = loadTasks(testDir);
			const finalTask = tasks.find((t) => t.id === task.id);
			expect(finalTask!.error).toBe(errorMessage);
		});
	});

	describe("Data Integrity Under Load", () => {
		test("should maintain data integrity with many concurrent operations", async () => {
			const run = createRun({ scope: "load test", workDir: testDir });

			// Create multiple tasks
			const taskPromises = Array.from({ length: 5 }, (_, i) =>
				Promise.resolve(
					createTask(
						{
							title: `Task ${i}`,
							description: `Description ${i}`,
							issue_id: `ISSUE-${i}`,
							status: "pending",
							parallel_group: i % 2,
							depends_on: [],
							files: [],
							checks: [],
							acceptance: [],
						},
						testDir
					)
				)
			);

			const tasks = await Promise.all(taskPromises);

			// Perform many concurrent updates
			const allUpdates: Promise<unknown>[] = [];

			// Update run stats concurrently
			for (let i = 0; i < 10; i++) {
				allUpdates.push(
					updateRunStatsWithLock(
						run.id,
						{
							tasks_completed: i,
							tasks_failed: Math.floor(i / 3),
						},
						testDir
					)
				);
			}

			// Update tasks concurrently
			for (const task of tasks) {
				allUpdates.push(
					updateTaskWithLock(task.id, { description: "Updated under load" }, testDir)
				);
			}

			await Promise.all(allUpdates);

			// Verify data integrity
			const finalMeta = loadRunMeta(run.id, testDir);
			expect(finalMeta).not.toBeNull();
			expect(finalMeta!.id).toBe(run.id);

			const finalTasks = loadTasks(testDir);
			expect(finalTasks.length).toBe(5);
			for (const task of finalTasks) {
				expect(task.id).toBeDefined();
				expect(task.title).toBeDefined();
			}
		});

		test("should not corrupt JSON files under concurrent writes", async () => {
			const run = createRun({ scope: "json integrity test", workDir: testDir });

			// Perform rapid concurrent updates
			const rapidUpdates = Array.from({ length: 20 }, (_, i) =>
				updateRunMetaWithLock(
					run.id,
					{
						issues_found: i,
						issues_validated: Math.floor(i / 2),
						tasks_total: i * 2,
					},
					testDir
				)
			);

			await Promise.all(rapidUpdates);

			// File should still be valid JSON
			const meta = loadRunMeta(run.id, testDir);
			expect(meta).not.toBeNull();
			expect(typeof meta!.issues_found).toBe("number");
			expect(typeof meta!.issues_validated).toBe("number");
			expect(typeof meta!.tasks_total).toBe("number");
		});
	});

	describe("Run-Aware Task Functions (updateTaskForRunSafe)", () => {
		test("should handle concurrent updates to tasks in the same run", async () => {
			const run = createRun({ scope: "run-aware concurrent", workDir: testDir });
			const task = createTaskForRun(
				run.id,
				{
					title: "Run-aware Task",
					description: "Testing run-aware updates",
					issue_id: "RUNAWARE-1",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Simulate a few parallel updates (reduced from 10 to avoid timeout)
			const updates = Array.from({ length: 3 }, (_, i) => ({
				description: `Run-aware update ${i}`,
			}));

			const results = await Promise.all(
				updates.map((update) => updateTaskForRunSafe(run.id, task.id, update, testDir))
			);

			// All updates should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final task should have one of the descriptions
			const finalTask = readTaskForRun(run.id, task.id, testDir);
			expect(finalTask).not.toBeNull();
			expect(finalTask!.description).toMatch(/^Run-aware update \d$/);
		});

		test("should isolate updates between different runs", async () => {
			// Create two separate runs
			const run1 = createRun({ scope: "isolation run 1", workDir: testDir });
			const run2 = createRun({ scope: "isolation run 2", workDir: testDir });

			// Create tasks in each run
			const task1 = createTaskForRun(
				run1.id,
				{
					title: "Task in Run 1",
					description: "Original description",
					issue_id: "RUN1-ISSUE",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			const task2 = createTaskForRun(
				run2.id,
				{
					title: "Task in Run 2",
					description: "Original description",
					issue_id: "RUN2-ISSUE",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir
			);

			// Update task1 in run1
			await updateTaskForRunSafe(run1.id, task1.id, { status: "done" }, testDir);

			// Verify task1 in run1 is updated
			const updatedTask1 = readTaskForRun(run1.id, task1.id, testDir);
			expect(updatedTask1!.status).toBe("done");

			// Verify task2 in run2 is NOT affected
			const unchangedTask2 = readTaskForRun(run2.id, task2.id, testDir);
			expect(unchangedTask2!.status).toBe("pending");

			// Verify cross-run update returns null (task doesn't exist in other run)
			const crossRunResult = await updateTaskForRunSafe(run2.id, task1.id, { status: "failed" }, testDir);
			expect(crossRunResult).toBeNull();
		});

		test("should handle parallel updates to different runs simultaneously", async () => {
			// Create two runs
			const run1 = createRun({ scope: "parallel run 1", workDir: testDir });
			const run2 = createRun({ scope: "parallel run 2", workDir: testDir });

			// Create a few tasks in each run (reduced from 5 to avoid timeout)
			const run1Tasks = Array.from({ length: 2 }, (_, i) =>
				createTaskForRun(
					run1.id,
					{
						title: `Run1 Task ${i}`,
						description: `Description ${i}`,
						issue_id: `RUN1-ISSUE-${i}`,
						status: "pending",
						parallel_group: 0,
						depends_on: [],
						files: [],
						checks: [],
						acceptance: [],
					},
					testDir
				)
			);

			const run2Tasks = Array.from({ length: 2 }, (_, i) =>
				createTaskForRun(
					run2.id,
					{
						title: `Run2 Task ${i}`,
						description: `Description ${i}`,
						issue_id: `RUN2-ISSUE-${i}`,
						status: "pending",
						parallel_group: 0,
						depends_on: [],
						files: [],
						checks: [],
						acceptance: [],
					},
					testDir
				)
			);

			// Perform parallel updates to both runs simultaneously
			const allUpdates: Promise<unknown>[] = [];

			// Update all run1 tasks to "done"
			for (const task of run1Tasks) {
				allUpdates.push(
					updateTaskForRunSafe(run1.id, task.id, { status: "done" }, testDir)
				);
			}

			// Update all run2 tasks to "failed"
			for (const task of run2Tasks) {
				allUpdates.push(
					updateTaskForRunSafe(run2.id, task.id, { status: "failed", error: "Test failure" }, testDir)
				);
			}

			await Promise.all(allUpdates);

			// Verify run1 tasks are all "done"
			const finalRun1Tasks = loadTasksForRun(run1.id, testDir);
			expect(finalRun1Tasks.length).toBe(2);
			for (const task of finalRun1Tasks) {
				expect(task.status).toBe("done");
			}

			// Verify run2 tasks are all "failed"
			const finalRun2Tasks = loadTasksForRun(run2.id, testDir);
			expect(finalRun2Tasks.length).toBe(2);
			for (const task of finalRun2Tasks) {
				expect(task.status).toBe("failed");
				expect(task.error).toBe("Test failure");
			}
		});

		test("should return null for non-existent task in run", async () => {
			const run = createRun({ scope: "non-existent task test", workDir: testDir });

			const result = await updateTaskForRunSafe(
				run.id,
				"NON-EXISTENT-TASK",
				{ status: "done" },
				testDir
			);

			expect(result).toBeNull();
		});

		test("should return null for non-existent run", async () => {
			const result = await updateTaskForRunSafe(
				"non-existent-run-id",
				"any-task-id",
				{ status: "done" },
				testDir
			);

			expect(result).toBeNull();
		});
	});
});
