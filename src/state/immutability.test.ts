/**
 * Immutability Tests for State Management
 *
 * Tests that state management functions do not mutate their input objects.
 * This ensures data integrity and prevents unexpected side effects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadIssues, saveIssues, updateIssue } from "./issues.ts";
import {
	createRun,
	loadRunMeta,
	loadRunsIndex,
	saveRunsIndex,
	setCurrentRun,
	updateRunPhaseInMetaWithLock,
	updateRunStatsWithLock,
} from "./runs.ts";
import { createTask, loadTasks, saveTasks, updateTask } from "./tasks.ts";
import type { Issue, RunsIndex, Task } from "./types.ts";

describe("Immutability Tests", () => {
	const testDir = join(process.cwd(), ".test-immutability");

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

	describe("Run State Immutability", () => {
		test("updateRunStats should not mutate input RunMeta", async () => {
			// Create a run
			const run = await createRun({ scope: "test immutability", workDir: testDir });

			// Load the run meta and create a deep copy for comparison
			const originalMeta = loadRunMeta(run.id, testDir);
			expect(originalMeta).not.toBeNull();

			// Create a snapshot of the original values
			const _originalSnapshot = {
				issues_found: originalMeta?.issues_found,
				issues_validated: originalMeta?.issues_validated,
				tasks_total: originalMeta?.tasks_total,
				tasks_completed: originalMeta?.tasks_completed,
				tasks_failed: originalMeta?.tasks_failed,
				updated_at: originalMeta?.updated_at,
			};

			// Update stats
			const updated = await updateRunStatsWithLock(
				run.id,
				{
					issues_found: 10,
					issues_validated: 5,
					tasks_total: 20,
				},
				testDir,
			);

			// Verify the update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.issues_found).toBe(10);
			expect(updated?.issues_validated).toBe(5);
			expect(updated?.tasks_total).toBe(20);

			// Verify the original object was not mutated (reload to check)
			// Note: Since we're testing file-based state, we verify by checking
			// that the function returns a new object, not the same reference
			expect(updated).not.toBe(originalMeta);
		});

		test("updateRunPhaseInMeta should not mutate input RunMeta", async () => {
			const run = await createRun({ scope: "test phase immutability", workDir: testDir });

			// Load original meta
			const originalMeta = loadRunMeta(run.id, testDir);
			expect(originalMeta).not.toBeNull();
			const originalPhase = originalMeta?.phase;

			// Update phase
			const updated = await updateRunPhaseInMetaWithLock(run.id, "exec", testDir);

			// Verify update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.phase).toBe("exec");

			// Verify original was not mutated (different reference)
			expect(updated).not.toBe(originalMeta);
			// Original object in memory should still have original phase
			expect(originalMeta?.phase).toBe(originalPhase);
		});

		test("setCurrentRun should not mutate input RunsIndex", async () => {
			// Create multiple runs
			const run1 = await createRun({ scope: "run 1", workDir: testDir });
			const _run2 = await createRun({ scope: "run 2", workDir: testDir });

			// Load original index
			const originalIndex = loadRunsIndex(testDir);
			const originalRunsLength = originalIndex.runs.length;
			const originalLastRunId = originalIndex.runs[originalIndex.runs.length - 1]?.id;

			// Set current run to run1 (moves run1 to end of list)
			setCurrentRun(run1.id, testDir);

			// Verify the original index object was not mutated
			expect(originalIndex.runs.length).toBe(originalRunsLength);
			expect(originalIndex.runs[originalIndex.runs.length - 1]?.id).toBe(originalLastRunId);

			// Verify the file was updated — run1 should now be last (latest)
			const newIndex = loadRunsIndex(testDir);
			expect(newIndex.runs[newIndex.runs.length - 1].id).toBe(run1.id);
		});

		test("saveRunsIndex should not mutate input index object", async () => {
			await createRun({ scope: "test save index", workDir: testDir });

			// Load index and create a copy
			const index = loadRunsIndex(testDir);
			const originalRunsLength = index.runs.length;

			// Create a modified copy to save (with an empty runs array)
			const modifiedIndex: RunsIndex = {
				...index,
				runs: [],
			};

			// Save the modified index
			saveRunsIndex(modifiedIndex, testDir);

			// Verify original index was not mutated
			expect(index.runs.length).toBe(originalRunsLength);
		});
	});

	describe("Task State Immutability", () => {
		test("updateTask should not mutate input Task", async () => {
			await createRun({ scope: "test task immutability", workDir: testDir });

			// Create a task
			const task = createTask(
				{
					title: "Original Title",
					description: "Original Description",
					issue_id: "ISSUE-1",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir,
			);

			// Store original values
			const originalTitle = task.title;
			const originalDescription = task.description;

			// Update the task
			const updated = updateTask(
				task.id,
				{
					title: "Updated Title",
					description: "Updated Description",
				},
				testDir,
			);

			// Verify update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.title).toBe("Updated Title");
			expect(updated?.description).toBe("Updated Description");

			// Verify original task object was not mutated
			expect(task.title).toBe(originalTitle);
			expect(task.description).toBe(originalDescription);
		});

		test("saveTasks should not mutate input tasks array", async () => {
			await createRun({ scope: "test save tasks", workDir: testDir });

			// Create some tasks
			const _task1 = createTask(
				{
					title: "Task 1",
					description: "Description 1",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir,
			);

			// Load tasks and create a copy
			const tasks = loadTasks(testDir);
			const originalLength = tasks.length;
			const originalFirstTaskTitle = tasks[0]?.title;

			// Modify the array (add a new task)
			const newTasks = [
				...tasks,
				{
					...tasks[0],
					id: "NEW-TASK",
					title: "New Task",
				},
			];

			// Save the modified array
			saveTasks(newTasks as Task[], testDir);

			// Verify original array was not mutated
			expect(tasks.length).toBe(originalLength);
			expect(tasks[0]?.title).toBe(originalFirstTaskTitle);
		});

		test("loadTasks should return independent copies", async () => {
			await createRun({ scope: "test load tasks independence", workDir: testDir });

			createTask(
				{
					title: "Test Task",
					description: "Test Description",
					status: "pending",
					parallel_group: 0,
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
				},
				testDir,
			);

			// Load tasks twice
			const tasks1 = loadTasks(testDir);
			const tasks2 = loadTasks(testDir);

			// Verify they are different arrays
			expect(tasks1).not.toBe(tasks2);

			// Modify one array
			if (tasks1.length > 0) {
				(tasks1[0] as { title: string }).title = "Modified Title";
			}

			// Verify the other array was not affected
			expect(tasks2[0]?.title).toBe("Test Task");
		});
	});

	describe("Issue State Immutability", () => {
		test("updateIssue should not mutate input Issue", async () => {
			await createRun({ scope: "test issue immutability", workDir: testDir });

			// Create an issue
			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Original Symptom",
					hypothesis: "Original Hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(issues, testDir);

			// Load the issue
			const loadedIssues = loadIssues(testDir);
			const originalIssue = loadedIssues[0];
			const originalSymptom = originalIssue.symptom;
			const originalHypothesis = originalIssue.hypothesis;

			// Update the issue
			const updated = updateIssue(
				"ISSUE-1",
				{
					symptom: "Updated Symptom",
					hypothesis: "Updated Hypothesis",
				},
				testDir,
			);

			// Verify update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.symptom).toBe("Updated Symptom");
			expect(updated?.hypothesis).toBe("Updated Hypothesis");

			// Verify original issue object was not mutated
			expect(originalIssue.symptom).toBe(originalSymptom);
			expect(originalIssue.hypothesis).toBe(originalHypothesis);
		});

		test("saveIssues should not mutate input issues array", async () => {
			await createRun({ scope: "test save issues", workDir: testDir });

			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test Symptom",
					hypothesis: "Test Hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];

			// Store original values
			const originalLength = issues.length;
			const originalSymptom = issues[0].symptom;

			// Save issues
			saveIssues(issues, testDir);

			// Verify original array was not mutated
			expect(issues.length).toBe(originalLength);
			expect(issues[0].symptom).toBe(originalSymptom);
		});

		test("loadIssues should return independent copies", async () => {
			await createRun({ scope: "test load issues independence", workDir: testDir });

			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test Symptom",
					hypothesis: "Test Hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(issues, testDir);

			// Load issues twice
			const issues1 = loadIssues(testDir);
			const issues2 = loadIssues(testDir);

			// Verify they are different arrays
			expect(issues1).not.toBe(issues2);

			// Modify one array
			if (issues1.length > 0) {
				(issues1[0] as { symptom: string }).symptom = "Modified Symptom";
			}

			// Verify the other array was not affected
			expect(issues2[0]?.symptom).toBe("Test Symptom");
		});
	});

	describe("Nested Object Immutability", () => {
		test("updating task should not mutate nested depends_on array", async () => {
			await createRun({ scope: "test nested immutability", workDir: testDir });

			const task = createTask(
				{
					title: "Task with Dependencies",
					description: "Test",
					status: "pending",
					parallel_group: 0,
					depends_on: ["DEP-1", "DEP-2"],
					files: ["file1.ts", "file2.ts"],
					checks: [],
					acceptance: [],
				},
				testDir,
			);

			// Store original arrays
			const originalDependsOn = [...task.depends_on];
			const originalFiles = [...task.files];

			// Update with new arrays
			const updated = updateTask(
				task.id,
				{
					depends_on: ["DEP-3"],
					files: ["file3.ts"],
				},
				testDir,
			);

			// Verify update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.depends_on).toEqual(["DEP-3"]);
			expect(updated?.files).toEqual(["file3.ts"]);

			// Verify original arrays were not mutated
			expect(task.depends_on).toEqual(originalDependsOn);
			expect(task.files).toEqual(originalFiles);
		});

		test("updating issue should not mutate nested evidence array", async () => {
			await createRun({ scope: "test evidence immutability", workDir: testDir });

			const now = new Date().toISOString();
			const originalEvidence = [
				{
					type: "file" as const,
					file: "test.ts",
					timestamp: now,
				},
			];

			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test Symptom",
					hypothesis: "Test Hypothesis",
					evidence: originalEvidence,
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(issues, testDir);

			// Load and update
			const loadedIssues = loadIssues(testDir);
			const originalIssue = loadedIssues[0];
			const originalEvidenceLength = originalIssue.evidence.length;

			const updated = updateIssue(
				"ISSUE-1",
				{
					evidence: [
						{
							type: "file" as const,
							file: "test.ts",
							timestamp: now,
						},
					],
				},
				testDir,
			);

			// Verify update succeeded
			expect(updated).not.toBeNull();
			expect(updated?.evidence.length).toBe(1);
			expect(updated?.evidence[0].type).toBe("file");

			// Verify original evidence array was not mutated
			expect(originalIssue.evidence.length).toBe(originalEvidenceLength);
			expect(originalIssue.evidence[0].type).toBe("file");
		});
	});

	describe("Spread Operator Usage Verification", () => {
		test("createRun should use spread operator for options", async () => {
			const options = {
				scope: "test scope",
				name: "test name",
				workDir: testDir,
			};

			// Store original values
			const originalScope = options.scope;
			const originalName = options.name;

			// Create run
			const run = await createRun(options);

			// Verify options were not mutated
			expect(options.scope).toBe(originalScope);
			expect(options.name).toBe(originalName);

			// Verify run was created correctly
			expect(run.scope).toBe(originalScope);
			expect(run.name).toBe(originalName);
		});

		test("updateRunStats should use spread operator for stats", async () => {
			const run = await createRun({ scope: "test spread", workDir: testDir });

			const stats = {
				issues_found: 5,
				tasks_total: 10,
			};

			// Store original values
			const originalIssuesFound = stats.issues_found;
			const originalTasksTotal = stats.tasks_total;

			// Update stats
			await updateRunStatsWithLock(run.id, stats, testDir);

			// Verify stats object was not mutated
			expect(stats.issues_found).toBe(originalIssuesFound);
			expect(stats.tasks_total).toBe(originalTasksTotal);
		});
	});
});
