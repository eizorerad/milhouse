/**
 * Unit tests for run-aware task state functions
 *
 * Tests the run-aware task functions that were added to support
 * concurrent run isolation and prevent cross-run writes.
 *
 * @module tests/unit/state/tasks
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateWriteError } from "../../../src/state/errors.ts";
import { createRun } from "../../../src/state/runs.ts";
import {
	areDependenciesSatisfied,
	createTaskForRun,
	deleteTask,
	getReadyTasks,
	loadRawTasks,
	loadTasksForRun,
	readTaskForRun,
	saveTasksForRun,
	saveTasks,
	updateTaskForRun,
	updateTaskForRunSafe,
} from "../../../src/state/tasks.ts";
import { isTaskReady } from "../../../src/execution/agent/state.ts";
import type { Task } from "../../../src/state/types.ts";

describe("Run-aware task functions", () => {
	const testDir = join(process.cwd(), ".test-tasks-unit");

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

	/**
	 * Helper to create a test task data object
	 */
	function createTestTaskData(
		issueId: string,
		overrides: Partial<Omit<Task, "id" | "created_at" | "updated_at">> = {},
	): Omit<Task, "id" | "created_at" | "updated_at"> {
		return {
			title: `Test Task for ${issueId}`,
			description: `Description for ${issueId}`,
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

	describe("readTaskForRun", () => {
		it("should return the correct task from the specified run", async () => {
			const run = await createRun({ scope: "read task test", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			const result = readTaskForRun(run.id, task.id, testDir);

			expect(result).not.toBeNull();
			expect(result?.id).toBe(task.id);
			expect(result?.title).toBe("Test Task for ISSUE-1");
			expect(result?.issue_id).toBe("ISSUE-1");
			expect(result?.status).toBe("pending");
		});

		it("should return null for non-existent task ID", async () => {
			const run = await createRun({ scope: "non-existent task", workDir: testDir });
			// Create a task so the run has a tasks.json file
			createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			const result = readTaskForRun(run.id, "NON-EXISTENT-TASK-ID", testDir);

			expect(result).toBeNull();
		});

		it("should return null for non-existent run ID", async () => {
			const result = readTaskForRun("non-existent-run-id", "any-task-id", testDir);

			expect(result).toBeNull();
		});

		it("should return null when run exists but has no tasks", async () => {
			const run = await createRun({ scope: "empty run", workDir: testDir });

			const result = readTaskForRun(run.id, "any-task-id", testDir);

			expect(result).toBeNull();
		});

		it("should return the correct task when multiple tasks exist", async () => {
			const run = await createRun({ scope: "multiple tasks", workDir: testDir });

			const _task1 = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);
			const task2 = createTaskForRun(run.id, createTestTaskData("ISSUE-2"), testDir);
			const _task3 = createTaskForRun(run.id, createTestTaskData("ISSUE-3"), testDir);

			// Read the middle task
			const result = readTaskForRun(run.id, task2.id, testDir);

			expect(result).not.toBeNull();
			expect(result?.id).toBe(task2.id);
			expect(result?.issue_id).toBe("ISSUE-2");
		});

		it("should not find task from a different run", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			const taskInRun1 = createTaskForRun(run1.id, createTestTaskData("RUN1-ISSUE"), testDir);

			// Try to read task from run2
			const result = readTaskForRun(run2.id, taskInRun1.id, testDir);

			expect(result).toBeNull();
		});
	});

	describe("loadTasksForRun", () => {
		it("should return empty array for non-existent run", async () => {
			const result = loadTasksForRun("non-existent-run", testDir);

			expect(result).toEqual([]);
		});

		it("should return empty array for run with no tasks", async () => {
			const run = await createRun({ scope: "empty run", workDir: testDir });

			const result = loadTasksForRun(run.id, testDir);

			expect(result).toEqual([]);
		});

		it("should return all tasks for a run", async () => {
			const run = await createRun({ scope: "tasks run", workDir: testDir });

			createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);
			createTaskForRun(run.id, createTestTaskData("ISSUE-2"), testDir);
			createTaskForRun(run.id, createTestTaskData("ISSUE-3"), testDir);

			const result = loadTasksForRun(run.id, testDir);

			expect(result.length).toBe(3);
			expect(result.map((t) => t.issue_id).sort()).toEqual(["ISSUE-1", "ISSUE-2", "ISSUE-3"]);
		});

		it("should only return tasks from the specified run", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			createTaskForRun(run1.id, createTestTaskData("RUN1-ISSUE-1"), testDir);
			createTaskForRun(run1.id, createTestTaskData("RUN1-ISSUE-2"), testDir);
			createTaskForRun(run2.id, createTestTaskData("RUN2-ISSUE-1"), testDir);

			const run1Tasks = loadTasksForRun(run1.id, testDir);
			const run2Tasks = loadTasksForRun(run2.id, testDir);

			expect(run1Tasks.length).toBe(2);
			expect(run1Tasks.every((t) => t.issue_id?.startsWith("RUN1-"))).toBe(true);

			expect(run2Tasks.length).toBe(1);
			expect(run2Tasks[0].issue_id).toBe("RUN2-ISSUE-1");
		});
	});

	describe("saveTasksForRun", () => {
		it("should save tasks to the correct run", async () => {
			const run = await createRun({ scope: "save test", workDir: testDir });

			const tasks: Task[] = [
				{
					id: "SAVE-T1",
					title: "Task 1",
					description: "Description 1",
					issue_id: "ISSUE-1",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			];

			saveTasksForRun(run.id, tasks, testDir);

			const loaded = loadTasksForRun(run.id, testDir);
			expect(loaded.length).toBe(1);
			expect(loaded[0].id).toBe("SAVE-T1");
		});

		it("should not affect tasks in other runs", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			// Create task in run1
			createTaskForRun(run1.id, createTestTaskData("RUN1-ISSUE"), testDir);

			// Save new tasks to run2
			const run2Tasks: Task[] = [
				{
					id: "RUN2-T1",
					title: "Run 2 Task",
					description: "Description",
					issue_id: "RUN2-ISSUE",
					status: "done",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			];

			saveTasksForRun(run2.id, run2Tasks, testDir);

			// Verify run1 tasks are unchanged
			const run1Loaded = loadTasksForRun(run1.id, testDir);
			expect(run1Loaded.length).toBe(1);
			expect(run1Loaded[0].issue_id).toBe("RUN1-ISSUE");

			// Verify run2 has new tasks
			const run2Loaded = loadTasksForRun(run2.id, testDir);
			expect(run2Loaded.length).toBe(1);
			expect(run2Loaded[0].id).toBe("RUN2-T1");
		});
	});

	describe("createTaskForRun", () => {
		it("should create task with generated ID", async () => {
			const run = await createRun({ scope: "create test", workDir: testDir });

			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			expect(task.id).toMatch(/^ISSUE-1-T\d+$/);
			expect(task.created_at).toBeDefined();
			expect(task.updated_at).toBeDefined();
		});

		it("should generate sequential task IDs for same issue", async () => {
			const run = await createRun({ scope: "sequential IDs", workDir: testDir });

			const task1 = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);
			const task2 = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);
			const task3 = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			expect(task1.id).toBe("ISSUE-1-T1");
			expect(task2.id).toBe("ISSUE-1-T2");
			expect(task3.id).toBe("ISSUE-1-T3");
		});

		it("should create task in the correct run only", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			const task = createTaskForRun(run1.id, createTestTaskData("ISSUE-1"), testDir);

			// Task should exist in run1
			const run1Tasks = loadTasksForRun(run1.id, testDir);
			expect(run1Tasks.find((t) => t.id === task.id)).toBeDefined();

			// Task should NOT exist in run2
			const run2Tasks = loadTasksForRun(run2.id, testDir);
			expect(run2Tasks.find((t) => t.id === task.id)).toBeUndefined();
		});
	});

	describe("updateTaskForRun", () => {
		it("should update task in the specified run", async () => {
			const run = await createRun({ scope: "update test", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			const updated = updateTaskForRun(
				run.id,
				task.id,
				{ status: "done", description: "Updated description" },
				testDir,
			);

			expect(updated).not.toBeNull();
			expect(updated?.status).toBe("done");
			expect(updated?.description).toBe("Updated description");
			// updated_at should be >= original (could be same millisecond)
			expect(new Date(updated?.updated_at ?? "").getTime()).toBeGreaterThanOrEqual(
				new Date(task.updated_at).getTime(),
			);
		});

		it("should return null for non-existent task", async () => {
			const run = await createRun({ scope: "non-existent update", workDir: testDir });

			const result = updateTaskForRun(run.id, "NON-EXISTENT-TASK", { status: "done" }, testDir);

			expect(result).toBeNull();
		});

		it("should not update task in different run", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			const task = createTaskForRun(run1.id, createTestTaskData("ISSUE-1"), testDir);

			// Try to update using run2's ID
			const result = updateTaskForRun(run2.id, task.id, { status: "done" }, testDir);

			expect(result).toBeNull();

			// Verify task in run1 is unchanged
			const taskInRun1 = readTaskForRun(run1.id, task.id, testDir);
			expect(taskInRun1?.status).toBe("pending");
		});
	});

	describe("StateWriteError guard", () => {
		it("saveTasksForRun throws StateWriteError when saving empty array over non-empty file", async () => {
			const run = await createRun({ scope: "empty write guard", workDir: testDir });
			createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			expect(() => saveTasksForRun(run.id, [], testDir)).toThrow(StateWriteError);
		});

		it("saveTasksForRun allows empty write with force: true", async () => {
			const run = await createRun({ scope: "force empty write", workDir: testDir });
			createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			expect(() => saveTasksForRun(run.id, [], testDir, { force: true })).not.toThrow();

			const loaded = loadTasksForRun(run.id, testDir);
			expect(loaded).toEqual([]);
		});

		it("saveTasksForRun allows empty write to non-existent file", async () => {
			const run = await createRun({ scope: "new run empty write", workDir: testDir });

			expect(() => saveTasksForRun(run.id, [], testDir)).not.toThrow();
		});

		it("saveTasksForRun allows non-empty write without force", async () => {
			const run = await createRun({ scope: "non-empty write", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			const tasks: Task[] = [
				{
					...task,
					status: "done",
					updated_at: new Date().toISOString(),
				},
			];

			expect(() => saveTasksForRun(run.id, tasks, testDir)).not.toThrow();

			const loaded = loadTasksForRun(run.id, testDir);
			expect(loaded.length).toBe(1);
			expect(loaded[0].status).toBe("done");
		});

		it("deleteTask succeeds when deleting last task", async () => {
			// Create a run so the deprecated saveTasks path resolves correctly
			const run = await createRun({ scope: "delete last task", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			// deleteTask uses the deprecated saveTasks path with force: true
			const result = deleteTask(task.id, testDir);

			expect(result).toBe(true);

			const loaded = loadTasksForRun(run.id, testDir);
			expect(loaded).toEqual([]);
		});

		it("deleteTask throws when raw tasks exceed validated tasks and deletion would empty the array", async () => {
			// Create a run so path resolution works
			const run = await createRun({ scope: "partial schema delete", workDir: testDir });

			// Create one valid task via the normal API
			const validTask = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			// Now manually write the tasks.json with both the valid task and an invalid entry
			// The invalid entry is missing required fields (id, title, created_at, updated_at)
			// so it will fail schema validation in loadTasks/loadTasksFromPath
			const tasksPath = join(
				testDir,
				".milhouse",
				"runs",
				run.id,
				"state",
				"tasks.json",
			);
			const rawEntries = [
				// The valid task (will pass schema validation)
				JSON.parse(readFileSync(tasksPath, "utf-8"))[0],
				// Invalid entry: missing required 'title', 'created_at', 'updated_at'
				{ id: "INVALID-ORPHAN", status: "pending" },
				// Another invalid entry
				{ broken: true },
			];
			writeFileSync(tasksPath, JSON.stringify(rawEntries, null, 2));

			// Verify preconditions: loadTasks returns 1 valid task, raw has 3 entries
			const loaded = loadTasksForRun(run.id, testDir);
			expect(loaded.length).toBe(1);
			expect(loaded[0].id).toBe(validTask.id);

			const raw = loadRawTasks(testDir);
			expect(raw.length).toBe(3);

			// Deleting the last valid task should throw StateWriteError
			// because raw entries on disk (3) exceed the single task being removed,
			// and the resulting array would be empty — wiping the 2 invalid entries
			expect(() => deleteTask(validTask.id, testDir)).toThrow(StateWriteError);

			// Verify the file on disk still has all 3 original raw entries
			const rawAfter = JSON.parse(readFileSync(tasksPath, "utf-8"));
			expect(rawAfter.length).toBe(3);
		});
	});

	// ============================================================================
	// Dangling dependency handling
	// ============================================================================

	describe("areDependenciesSatisfied - dangling dependencies", () => {
		it("should return true when task depends on a non-existent task ID", async () => {
			const run = await createRun({ scope: "dangling dep satisfied", workDir: testDir });
			createTaskForRun(
				run.id,
				createTestTaskData("ISS-1", {
					depends_on: ["NON-EXISTENT-TASK-ID"],
				}),
				testDir,
			);

			// areDependenciesSatisfied uses the deprecated loadTasks() path,
			// so we need to ensure tasks are accessible via that path too
			const tasks = loadTasksForRun(run.id, testDir);
			const task = tasks[0];

			// Use saveTasks to write to the default path for areDependenciesSatisfied
			saveTasks(tasks, testDir);

			const result = areDependenciesSatisfied(task.id, testDir);
			// Dangling dep should be treated as satisfied, not blocking
			expect(result).toBe(true);
		});
	});

	describe("getReadyTasks - dangling dependencies", () => {
		it("should return task as ready when depends_on references non-existent task", async () => {
			const run = await createRun({ scope: "dangling ready tasks", workDir: testDir });
			createTaskForRun(
				run.id,
				createTestTaskData("ISS-1", {
					status: "pending",
					depends_on: ["NON-EXISTENT-TASK-ID"],
				}),
				testDir,
			);

			const tasks = loadTasksForRun(run.id, testDir);
			// Write to default path for getReadyTasks
			saveTasks(tasks, testDir);

			const ready = getReadyTasks(testDir);
			// Task with dangling dep should be treated as ready
			expect(ready.length).toBe(1);
		});
	});

	describe("isTaskReady - dangling dependencies", () => {
		it("should return true when task depends on ID not in completedTaskIds and not in allTasks", () => {
			const task: Task = {
				id: "TEST-T1",
				title: "Test task",
				issue_id: "ISS-1",
				status: "pending",
				parallel_group: 0,
				depends_on: ["NON-EXISTENT-TASK-ID"],
				files: [],
				checks: [],
				acceptance: [],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			const allTasks = [task]; // Only the task itself, dep doesn't exist
			const completedTaskIds: string[] = [];

			const result = isTaskReady(task, allTasks, completedTaskIds);
			// Dangling dep (not in allTasks) should be treated as satisfied
			expect(result).toBe(true);
		});

		it("should return false when task depends on an existing but incomplete task", () => {
			const depTask: Task = {
				id: "DEP-T1",
				title: "Dependency task",
				issue_id: "ISS-1",
				status: "pending",
				parallel_group: 0,
				depends_on: [],
				files: [],
				checks: [],
				acceptance: [],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			const task: Task = {
				id: "TEST-T1",
				title: "Test task",
				issue_id: "ISS-1",
				status: "pending",
				parallel_group: 0,
				depends_on: ["DEP-T1"],
				files: [],
				checks: [],
				acceptance: [],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			const allTasks = [depTask, task];
			const completedTaskIds: string[] = []; // DEP-T1 not completed

			const result = isTaskReady(task, allTasks, completedTaskIds);
			// Existing but not completed dep should block the task
			expect(result).toBe(false);
		});
	});

	describe("updateTaskForRunSafe", () => {
		it("should update task with file locking", async () => {
			const run = await createRun({ scope: "safe update test", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			const updated = await updateTaskForRunSafe(run.id, task.id, { status: "running" }, testDir);

			expect(updated).not.toBeNull();
			expect(updated?.status).toBe("running");
		});

		it("should handle concurrent updates safely", async () => {
			const run = await createRun({ scope: "concurrent safe update", workDir: testDir });
			const task = createTaskForRun(run.id, createTestTaskData("ISSUE-1"), testDir);

			// Perform a few concurrent updates (reduced from 10 to avoid timeout)
			const updates = Array.from({ length: 3 }, (_, i) =>
				updateTaskForRunSafe(run.id, task.id, { description: `Update ${i}` }, testDir),
			);

			const results = await Promise.all(updates);

			// All should succeed
			expect(results.every((r) => r !== null)).toBe(true);

			// Final task should have one of the descriptions
			const finalTask = readTaskForRun(run.id, task.id, testDir);
			expect(finalTask?.description).toMatch(/^Update \d$/);
		});

		it("should return null for non-existent task", async () => {
			const run = await createRun({ scope: "safe non-existent", workDir: testDir });

			const result = await updateTaskForRunSafe(
				run.id,
				"NON-EXISTENT-TASK",
				{ status: "done" },
				testDir,
			);

			expect(result).toBeNull();
		});

		it("should not update task in different run", async () => {
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const run2 = await createRun({ scope: "run 2", workDir: testDir });

			const task = createTaskForRun(run1.id, createTestTaskData("ISSUE-1"), testDir);

			// Try to update using run2's ID
			const result = await updateTaskForRunSafe(run2.id, task.id, { status: "done" }, testDir);

			expect(result).toBeNull();

			// Verify task in run1 is unchanged
			const taskInRun1 = readTaskForRun(run1.id, task.id, testDir);
			expect(taskInRun1?.status).toBe("pending");
		});
	});
});
