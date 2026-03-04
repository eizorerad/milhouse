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
