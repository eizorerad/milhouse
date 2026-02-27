/**
 * Unit tests for plan phase config (planPhaseConfig)
 *
 * Tests parseResponse, retryFilter, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/plan.test.ts
 */

import { describe, expect, it } from "bun:test";
import { planPhaseConfig } from "../../../../src/runner/phases/plan.ts";
import { createMockIssue, createMockPhaseContext } from "../helpers.ts";

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

		it("returns 'Invalid WBS structure' when summary missing", () => {
			const response = JSON.stringify({ tasks: [{ title: "T1" }] });
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.summary).toBe("Invalid WBS structure");
			expect(result.tasks).toEqual([]);
		});

		it("returns 'Invalid WBS structure' when tasks array missing", () => {
			const response = JSON.stringify({ summary: "Has summary" });
			const result = planPhaseConfig.parseResponse(response, item, ctx);
			expect(result.summary).toBe("Invalid WBS structure");
			expect(result.tasks).toEqual([]);
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

		it("returns empty tasks for no JSON extractable", () => {
			const result = planPhaseConfig.parseResponse("Just plain text", item, ctx);
			expect(result.summary).toBe("Failed to parse WBS");
			expect(result.tasks).toEqual([]);
		});

		it("returns empty tasks for malformed JSON", () => {
			const result = planPhaseConfig.parseResponse("{bad json", item, ctx);
			expect(result.tasks).toEqual([]);
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
