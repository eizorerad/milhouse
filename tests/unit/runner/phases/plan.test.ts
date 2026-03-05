/**
 * Unit tests for plan phase config (planPhaseConfig)
 *
 * Tests parseResponse, retryFilter, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/plan.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { planPhaseConfig } from "../../../../src/runner/phases/plan.ts";
import * as issuesModule from "../../../../src/state/issues.ts";
import * as planStoreModule from "../../../../src/state/plan-store.ts";
import * as runsModule from "../../../../src/state/runs.ts";
import * as tasksModule from "../../../../src/state/tasks.ts";
import * as logger from "../../../../src/ui/logger.ts";
import { createMockIssue, createMockPhaseContext, createMockTask } from "../helpers.ts";

// ============================================================================
// parseResponse
// ============================================================================

describe("planPhaseConfig", () => {
	describe("parseResponse", () => {
		const ctx = createMockPhaseContext();
		const item = createMockIssue({ id: "PLAN-001" });

		it("parses valid WBS JSON with summary and tasks array", () => {
			const response = JSON.stringify({
				summary: "Fix authentication bug",
				tasks: [
					{
						title: "Update auth middleware",
						description: "Fix the token validation",
						files: ["src/auth.ts"],
						depends_on: [],
						checks: ["bun test"],
						acceptance: [{ description: "Auth works", check_command: "bun test auth" }],
						risk: "Low",
						rollback: "Revert commit",
						parallel_group: 0,
					},
				],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issue_id).toBe("PLAN-001");
			expect(result.summary).toBe("Fix authentication bug");
			expect(result.tasks.length).toBe(1);
			expect(result.tasks[0].title).toBe("Update auth middleware");
			expect(result.tasks[0].files).toEqual(["src/auth.ts"]);
			expect(result.tasks[0].checks).toEqual(["bun test"]);
			expect(result.tasks[0].acceptance.length).toBe(1);
			expect(result.tasks[0].acceptance[0].description).toBe("Auth works");
			expect(result.tasks[0].acceptance[0].verified).toBe(false);
			expect(result.tasks[0].risk).toBe("Low");
			expect(result.tasks[0].rollback).toBe("Revert commit");
			expect(result.tasks[0].parallel_group).toBe(0);
		});

		it("throws when summary missing (invalid WBS structure)", () => {
			const response = JSON.stringify({ tasks: [{ title: "T1" }] });
			expect(() => planPhaseConfig.parseResponse(response, item, ctx)).toThrow("Plan [PLAN-001]: AI response has invalid WBS structure (missing summary or tasks array)");
		});

		it("throws when tasks array missing (invalid WBS structure)", () => {
			const response = JSON.stringify({ summary: "Has summary" });
			expect(() => planPhaseConfig.parseResponse(response, item, ctx)).toThrow("Plan [PLAN-001]: AI response has invalid WBS structure (missing summary or tasks array)");
		});

		it("filters out tasks without title", () => {
			const response = JSON.stringify({
				summary: "Test WBS",
				tasks: [
					{ title: "Valid task", files: [], depends_on: [], checks: [], acceptance: [] },
					{ description: "No title task", files: [] },
					{ title: "", files: [] }, // empty title is still a string, so it passes typeof check
				],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			// The filter checks typeof title === "string", empty string passes
			expect(result.tasks.length).toBe(2);
			expect(result.tasks[0].title).toBe("Valid task");
		});

		it("handles depends_on with numeric indices", () => {
			const response = JSON.stringify({
				summary: "Dep test",
				tasks: [
					{ title: "T1", depends_on: ["0", "1"] },
				],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].depends_on).toEqual(["0", "1"]);
		});

		it("handles depends_on with non-numeric strings", () => {
			const response = JSON.stringify({
				summary: "Dep test",
				tasks: [
					{ title: "T1", depends_on: ["some-task-id", "other-task"] },
				],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].depends_on).toEqual(["some-task-id", "other-task"]);
		});

		it("normalizes acceptance criteria", () => {
			const response = JSON.stringify({
				summary: "Test",
				tasks: [
					{
						title: "T1",
						acceptance: [
							{ description: "Criteria 1", check_command: "test cmd" },
							{ description: "Criteria 2" },
							{ notDescription: "missing" },
						],
					},
				],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].acceptance.length).toBe(3);
			expect(result.tasks[0].acceptance[0].description).toBe("Criteria 1");
			expect(result.tasks[0].acceptance[0].check_command).toBe("test cmd");
			expect(result.tasks[0].acceptance[0].verified).toBe(false);
			expect(result.tasks[0].acceptance[1].description).toBe("Criteria 2");
			expect(result.tasks[0].acceptance[1].check_command).toBeUndefined();
			expect(result.tasks[0].acceptance[2].description).toBe("Unknown");
		});

		it("defaults parallel_group to 0 when missing", () => {
			const response = JSON.stringify({
				summary: "Test",
				tasks: [{ title: "T1" }],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].parallel_group).toBe(0);
		});

		it("preserves parallel_group when present as number", () => {
			const response = JSON.stringify({
				summary: "Test",
				tasks: [{ title: "T1", parallel_group: 3 }],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].parallel_group).toBe(3);
		});

		it("throws for no JSON extractable", () => {
			expect(() => planPhaseConfig.parseResponse("Just plain text", item, ctx)).toThrow("Plan [PLAN-001]: AI response contained no extractable JSON");
		});

		it("throws for malformed JSON", () => {
			expect(() => planPhaseConfig.parseResponse("{bad json", item, ctx)).toThrow("Plan [PLAN-001]:");
		});

		it("defaults missing files/checks/acceptance/depends_on to empty arrays", () => {
			const response = JSON.stringify({
				summary: "Test",
				tasks: [{ title: "Minimal task" }],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].files).toEqual([]);
			expect(result.tasks[0].checks).toEqual([]);
			expect(result.tasks[0].acceptance).toEqual([]);
			expect(result.tasks[0].depends_on).toEqual([]);
		});

		it("defaults missing optional string fields to undefined", () => {
			const response = JSON.stringify({
				summary: "Test",
				tasks: [{ title: "Minimal" }],
			});
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.tasks[0].description).toBeUndefined();
			expect(result.tasks[0].risk).toBeUndefined();
			expect(result.tasks[0].rollback).toBeUndefined();
		});
	});

	// ============================================================================
	// retryFilter
	// ============================================================================

	describe("retryFilter", () => {
		it("retries items that failed (success=false)", () => {
			const issue1 = createMockIssue({ id: "ISS-1" });
			const issue2 = createMockIssue({ id: "ISS-2" });
			const items = [issue1, issue2];

			const results = [
				{
					item: issue1,
					result: { issue_id: "ISS-1", summary: "", tasks: [] as never[] },
					success: false,
					error: "Engine failed",
					inputTokens: 0,
					outputTokens: 0,
				},
				{
					item: issue2,
					result: { issue_id: "ISS-2", summary: "OK", tasks: [{ title: "T1" }] as never[] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = planPhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(1);
			expect(retryItems[0].id).toBe("ISS-1");
		});

		it("retries items that produced zero tasks", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];

			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", summary: "Empty", tasks: [] as never[] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = planPhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(1);
		});

		it("does not retry items with successful tasks", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];

			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", summary: "OK", tasks: [{ title: "T1" }] as never[] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = planPhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(0);
		});
	});

	// ============================================================================
	// nextPhase
	// ============================================================================

	describe("nextPhase", () => {
		const ctx = createMockPhaseContext();

		it("returns 'consolidate' when any result has tasks", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", summary: "OK", tasks: [{ title: "T1" }] as never[] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(planPhaseConfig.nextPhase!(results, ctx)).toBe("consolidate");
		});

		it("returns 'completed' when no tasks produced", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", summary: "Empty", tasks: [] as never[] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(planPhaseConfig.nextPhase!(results, ctx)).toBe("completed");
		});

		it("returns 'completed' when all results failed", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", summary: "", tasks: [] as never[] },
					success: false,
					error: "Failed",
					inputTokens: 0,
					outputTokens: 0,
				},
			];
			expect(planPhaseConfig.nextPhase!(results, ctx)).toBe("completed");
		});
	});

	// ============================================================================
	// saveResults — updateIssueForRun null guard
	// ============================================================================

	describe("saveResults", () => {
		let logWarnSpy: ReturnType<typeof spyOn>;
		let updateIssueSpy: ReturnType<typeof spyOn>;
		let createTaskSpy: ReturnType<typeof spyOn>;
		let loadTasksSpy: ReturnType<typeof spyOn>;
		let updateRunStatsSpy: ReturnType<typeof spyOn>;
		let writeWbsPlanSpy: ReturnType<typeof spyOn>;
		let writeWbsJsonSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			logWarnSpy = spyOn(logger, "logWarn").mockImplementation(() => {});
			writeWbsPlanSpy = spyOn(planStoreModule, "writeIssueWbsPlanForRun").mockImplementation(() => {});
			writeWbsJsonSpy = spyOn(planStoreModule, "writeIssueWbsJsonForRun").mockImplementation(() => {});
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue([]);
			updateRunStatsSpy = spyOn(runsModule, "updateRunStatsWithLock").mockResolvedValue(undefined as never);
		});

		afterEach(() => {
			logWarnSpy?.mockRestore();
			updateIssueSpy?.mockRestore();
			createTaskSpy?.mockRestore();
			loadTasksSpy?.mockRestore();
			updateRunStatsSpy?.mockRestore();
			writeWbsPlanSpy?.mockRestore();
			writeWbsJsonSpy?.mockRestore();
		});

		it("logs warning when updateIssueForRun returns null but tasks are still created", async () => {
			const task = createMockTask({ id: "T-1", issue_id: "ISS-PLAN-NULL" });
			createTaskSpy = spyOn(tasksModule, "createTaskForRunSafe").mockResolvedValue(task);
			updateIssueSpy = spyOn(issuesModule, "updateIssueForRun").mockReturnValue(null);
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue([task]);

			const issue = createMockIssue({ id: "ISS-PLAN-NULL", status: "CONFIRMED" });
			const ctx = createMockPhaseContext({ runId: "run-plan-null" });

			const results = [
				{
					item: issue,
					result: {
						issue_id: "ISS-PLAN-NULL",
						summary: "Fix the bug",
						tasks: [
							{
								title: "Task 1",
								description: "Do something",
								files: ["src/a.ts"],
								depends_on: [] as string[],
								checks: ["bun test"],
								acceptance: [{ description: "It works", check_command: "bun test", verified: false }],
								risk: "Low",
								rollback: "Revert",
								parallel_group: 0,
							},
						],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			await planPhaseConfig.saveResults(results, ctx);

			// Task was still created
			expect(createTaskSpy).toHaveBeenCalledTimes(1);

			// updateIssueForRun was called
			expect(updateIssueSpy).toHaveBeenCalledTimes(1);

			// logWarn was called with the issue ID
			const warnCalls = logWarnSpy.mock.calls.map((c: unknown[]) => c[0] as string);
			const nullWarning = warnCalls.find((m: string) => m.includes("ISS-PLAN-NULL") && m.includes("null"));
			expect(nullWarning).toBeDefined();

			// totalTasks counting still works — updateRunStatsWithLock should have been called
			expect(updateRunStatsSpy).toHaveBeenCalledTimes(1);
		});

		it("does not log warning when updateIssueForRun returns an issue", async () => {
			const issue = createMockIssue({ id: "ISS-PLAN-OK", status: "CONFIRMED" });
			const task = createMockTask({ id: "T-2", issue_id: "ISS-PLAN-OK" });
			createTaskSpy = spyOn(tasksModule, "createTaskForRunSafe").mockResolvedValue(task);
			updateIssueSpy = spyOn(issuesModule, "updateIssueForRun").mockReturnValue(issue);
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue([task]);

			const ctx = createMockPhaseContext({ runId: "run-plan-ok" });

			const results = [
				{
					item: issue,
					result: {
						issue_id: "ISS-PLAN-OK",
						summary: "Fix the bug",
						tasks: [
							{
								title: "Task 1",
								description: "Do something",
								files: ["src/a.ts"],
								depends_on: [] as string[],
								checks: ["bun test"],
								acceptance: [{ description: "It works", check_command: "bun test", verified: false }],
								risk: "Low",
								rollback: "Revert",
								parallel_group: 0,
							},
						],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			await planPhaseConfig.saveResults(results, ctx);

			// No null-related warnings
			const warnCalls = logWarnSpy.mock.calls.map((c: unknown[]) => c[0] as string);
			const nullWarning = warnCalls.find((m: string) => m.includes("null"));
			expect(nullWarning).toBeUndefined();
		});

		it("is idempotent - calling saveResults twice doesn't create duplicate tasks", async () => {
			const issue = createMockIssue({ id: "ISS-IDEM-1", status: "CONFIRMED", related_task_ids: [] });
			let taskIdCounter = 1;
			const createdTasks: typeof tasksModule.Task[] = [];

			// Mock saveTasksForRunSafe to track saved tasks
			let saveTasksSpy: ReturnType<typeof spyOn>;
			saveTasksSpy = spyOn(tasksModule, "saveTasksForRunSafe").mockImplementation(async (runId, tasks) => {
				// Store the tasks that were saved
				createdTasks.length = 0;
				createdTasks.push(...tasks);
			});

			// Mock createTaskForRunSafe to generate unique task IDs
			createTaskSpy = spyOn(tasksModule, "createTaskForRunSafe").mockImplementation(async (runId, taskData) => {
				const newTask = createMockTask({
					id: `T-${taskIdCounter++}`,
					issue_id: taskData.issue_id,
					title: taskData.title,
					status: "pending",
				});
				return newTask;
			});

			// Mock updateIssueForRun to return the updated issue
			updateIssueSpy = spyOn(issuesModule, "updateIssueForRun").mockReturnValue(issue);

			// First call: no existing tasks
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue([]);

			const ctx = createMockPhaseContext({ runId: "run-idem-1" });
			const results = [
				{
					item: issue,
					result: {
						issue_id: "ISS-IDEM-1",
						summary: "Fix the bug",
						tasks: [
							{
								title: "Task 1",
								description: "First task",
								files: ["src/a.ts"],
								depends_on: [] as string[],
								checks: ["bun test"],
								acceptance: [{ description: "It works", check_command: "bun test", verified: false }],
								risk: "Low",
								rollback: "Revert",
								parallel_group: 0,
							},
							{
								title: "Task 2",
								description: "Second task",
								files: ["src/b.ts"],
								depends_on: [] as string[],
								checks: ["bun test"],
								acceptance: [{ description: "Also works", check_command: "bun test", verified: false }],
								risk: "Low",
								rollback: "Revert",
								parallel_group: 0,
							},
						],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			// First call to saveResults
			await planPhaseConfig.saveResults(results, ctx);

			// Should have created 2 tasks
			expect(createTaskSpy).toHaveBeenCalledTimes(2);
			const firstCallTaskCount = createTaskSpy.mock.calls.length;

			// Reset loadTasksForRun to return the tasks created in the first run
			const tasksAfterFirstRun = [
				createMockTask({ id: "T-1", issue_id: "ISS-IDEM-1", title: "Task 1" }),
				createMockTask({ id: "T-2", issue_id: "ISS-IDEM-1", title: "Task 2" }),
			];
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue(tasksAfterFirstRun);

			// Second call to saveResults with same results
			await planPhaseConfig.saveResults(results, ctx);

			// Should have created 2 more tasks (total 4 calls to createTaskForRunSafe)
			expect(createTaskSpy).toHaveBeenCalledTimes(firstCallTaskCount + 2);

			// But saveTasksForRunSafe should have been called to filter out old tasks first
			// Check that it was called with empty array (filtered out the 2 existing tasks)
			const saveTasksCalls = saveTasksSpy.mock.calls;
			// First call should filter out existing tasks for ISS-IDEM-1
			expect(saveTasksCalls.length).toBeGreaterThanOrEqual(2);

			// Verify that the saved tasks after re-plan only contain new tasks
			// (the filtering should have removed the old ones)
			const filterCall = saveTasksCalls.find((call) => {
				const [runId, tasks] = call as [string, typeof tasksModule.Task[]];
				return tasks.length === 0; // Should save empty array after filtering
			});
			expect(filterCall).toBeDefined();

			saveTasksSpy.mockRestore();
		});

		it("replaces tasks when re-planning the same issue", async () => {
			const issue = createMockIssue({ id: "ISS-REPLACE-1", status: "CONFIRMED", related_task_ids: ["OLD-T-1"] });

			// Existing task from previous plan
			const existingTask = createMockTask({ id: "OLD-T-1", issue_id: "ISS-REPLACE-1", title: "Old Task" });

			let saveTasksSpy: ReturnType<typeof spyOn>;
			let savedTasks: typeof tasksModule.Task[] = [];

			saveTasksSpy = spyOn(tasksModule, "saveTasksForRunSafe").mockImplementation(async (runId, tasks) => {
				savedTasks = [...tasks];
			});

			// New task from re-plan
			const newTask = createMockTask({ id: "NEW-T-1", issue_id: "ISS-REPLACE-1", title: "New Task" });
			createTaskSpy = spyOn(tasksModule, "createTaskForRunSafe").mockResolvedValue(newTask);

			updateIssueSpy = spyOn(issuesModule, "updateIssueForRun").mockImplementation((runId, issueId, update) => {
				return { ...issue, ...update };
			});

			// Load existing task
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun").mockReturnValue([existingTask]);

			const ctx = createMockPhaseContext({ runId: "run-replace-1" });
			const results = [
				{
					item: issue,
					result: {
						issue_id: "ISS-REPLACE-1",
						summary: "Updated plan",
						tasks: [
							{
								title: "New Task",
								description: "Replacement task",
								files: ["src/new.ts"],
								depends_on: [] as string[],
								checks: ["bun test"],
								acceptance: [{ description: "New criteria", check_command: "bun test", verified: false }],
								risk: "Low",
								rollback: "Revert",
								parallel_group: 0,
							},
						],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			await planPhaseConfig.saveResults(results, ctx);

			// Verify old task was filtered out
			expect(saveTasksSpy).toHaveBeenCalled();
			const filterCall = saveTasksSpy.mock.calls[0];
			const filteredTasks = filterCall[1] as typeof tasksModule.Task[];
			// Should have filtered out OLD-T-1 (which belongs to ISS-REPLACE-1)
			expect(filteredTasks.every((t) => t.issue_id !== "ISS-REPLACE-1")).toBe(true);

			// Verify updateIssueForRun was called with new task IDs (replacing, not appending)
			const updateCalls = updateIssueSpy.mock.calls;
			expect(updateCalls.length).toBeGreaterThanOrEqual(1);

			// Should have been called with the new task IDs array (which replaces the old one)
			const updateCall = updateCalls.find((call) => {
				const update = call[2] as { related_task_ids?: string[] };
				return update.related_task_ids?.length === 1 && update.related_task_ids[0] === "NEW-T-1";
			});
			expect(updateCall).toBeDefined();

			saveTasksSpy.mockRestore();
		});

		it("updates task_total stat correctly when re-planning", async () => {
			const issue = createMockIssue({ id: "ISS-STAT-1", status: "CONFIRMED", related_task_ids: [] });

			// First run: 2 tasks
			const firstTasks = [
				createMockTask({ id: "T-1", issue_id: "ISS-STAT-1" }),
				createMockTask({ id: "T-2", issue_id: "ISS-STAT-1" }),
			];

			let taskCounter = 3;
			createTaskSpy = spyOn(tasksModule, "createTaskForRunSafe").mockImplementation(async () => {
				return createMockTask({ id: `T-${taskCounter++}`, issue_id: "ISS-STAT-1" });
			});

			const saveTasksSpy = spyOn(tasksModule, "saveTasksForRunSafe").mockResolvedValue(undefined);
			updateIssueSpy = spyOn(issuesModule, "updateIssueForRun").mockReturnValue(issue);

			// First call: no existing tasks
			loadTasksSpy.mockRestore();
			loadTasksSpy = spyOn(tasksModule, "loadTasksForRun")
				.mockReturnValueOnce([]) // First call for filtering
				.mockReturnValueOnce([]) // Second call for stats
				.mockReturnValueOnce(firstTasks) // Third call for filtering in second saveResults
				.mockReturnValueOnce([
					createMockTask({ id: "T-3", issue_id: "ISS-STAT-1" }),
					createMockTask({ id: "T-4", issue_id: "ISS-STAT-1" }),
					createMockTask({ id: "T-5", issue_id: "ISS-STAT-1" }),
				]); // Fourth call for stats

			const ctx = createMockPhaseContext({ runId: "run-stat-1" });
			const results = [
				{
					item: issue,
					result: {
						issue_id: "ISS-STAT-1",
						summary: "Plan v1",
						tasks: [
							{
								title: "Task 1",
								files: [],
								depends_on: [] as string[],
								checks: [],
								acceptance: [],
							},
							{
								title: "Task 2",
								files: [],
								depends_on: [] as string[],
								checks: [],
								acceptance: [],
							},
						],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			// First call
			await planPhaseConfig.saveResults(results, ctx);

			// Verify updateRunStatsWithLock was called
			expect(updateRunStatsSpy).toHaveBeenCalledTimes(1);

			// Second call with 3 tasks (re-plan)
			const updatedResults = [
				{
					...results[0],
					result: {
						...results[0].result,
						tasks: [
							{ title: "Task 3", files: [], depends_on: [] as string[], checks: [], acceptance: [] },
							{ title: "Task 4", files: [], depends_on: [] as string[], checks: [], acceptance: [] },
							{ title: "Task 5", files: [], depends_on: [] as string[], checks: [], acceptance: [] },
						],
					},
				},
			];

			await planPhaseConfig.saveResults(updatedResults, ctx);

			// Verify updateRunStatsWithLock was called again
			expect(updateRunStatsSpy).toHaveBeenCalledTimes(2);

			// Verify the stat reflects the new task count (3 tasks), not cumulative (5 tasks)
			const lastStatsCall = updateRunStatsSpy.mock.calls[1];
			const statsUpdate = lastStatsCall[1] as { tasks_total: number };
			expect(statsUpdate.tasks_total).toBe(3);

			saveTasksSpy.mockRestore();
		});
	});

	// ============================================================================
	// Config assertions
	// ============================================================================

	describe("config assertions", () => {
		it("isRetryable is true", () => {
			expect(planPhaseConfig.isRetryable).toBe(true);
		});

		it("maxRetryRounds is 1", () => {
			expect(planPhaseConfig.maxRetryRounds).toBe(1);
		});

		it("mode is 'per-item'", () => {
			expect(planPhaseConfig.mode).toBe("per-item");
		});

		it("defaultParallel is 5", () => {
			expect(planPhaseConfig.defaultParallel).toBe(5);
		});

		it("has correct name and role", () => {
			expect(planPhaseConfig.name).toBe("plan");
			expect(planPhaseConfig.role).toBe("PL");
		});

		it("has engineMetadata with maxTurns", () => {
			expect(planPhaseConfig.engineMetadata?.maxTurns).toBe(15);
		});
	});
});
