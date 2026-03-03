/**
 * Unit tests for consolidate phase config (consolidatePhaseConfig)
 *
 * Tests parseResponse, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/consolidate.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { consolidatePhaseConfig } from "../../../../src/runner/phases/consolidate.ts";
import { createRun } from "../../../../src/state/runs.ts";
import { createTaskForRun, loadTasksForRun } from "../../../../src/state/tasks.ts";
import type { Task } from "../../../../src/state/types.ts";
import { createMockPhaseContext } from "../helpers.ts";

// ============================================================================
// parseResponse
// ============================================================================

describe("consolidatePhaseConfig", () => {
	describe("parseResponse", () => {
		const ctx = createMockPhaseContext();
		const item = { tasks: [], issues: [] };

		it("parses valid consolidation JSON", () => {
			const response = JSON.stringify({
				duplicates: [{ keep: "T1", remove: ["T2"], reason: "Same fix" }],
				cross_dependencies: [{ task_id: "T3", depends_on: ["T1"], reason: "Needs T1 first" }],
				parallel_groups: [{ group: 0, task_ids: ["T1", "T3"] }],
				execution_order: ["T1", "T3"],
			});
			const result = consolidatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.duplicates.length).toBe(1);
			expect(result.duplicates[0].keep).toBe("T1");
			expect(result.duplicates[0].remove).toEqual(["T2"]);
			expect(result.cross_dependencies.length).toBe(1);
			expect(result.cross_dependencies[0].task_id).toBe("T3");
			expect(result.parallel_groups.length).toBe(1);
			expect(result.execution_order).toEqual(["T1", "T3"]);
		});

		it("defaults missing arrays gracefully", () => {
			const response = JSON.stringify({});
			const result = consolidatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.duplicates).toEqual([]);
			expect(result.cross_dependencies).toEqual([]);
			expect(result.parallel_groups).toEqual([]);
			expect(result.execution_order).toEqual([]);
		});

		it("handles partially present fields", () => {
			const response = JSON.stringify({
				duplicates: [{ keep: "T1", remove: ["T2"], reason: "dup" }],
				execution_order: ["T1"],
			});
			const result = consolidatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.duplicates.length).toBe(1);
			expect(result.cross_dependencies).toEqual([]);
			expect(result.parallel_groups).toEqual([]);
			expect(result.execution_order).toEqual(["T1"]);
		});

		it("throws for malformed JSON", () => {
			expect(() => consolidatePhaseConfig.parseResponse("{invalid json", item, ctx)).toThrow("Consolidate:");
		});

		it("throws when no JSON extractable", () => {
			expect(() => consolidatePhaseConfig.parseResponse("Just text, no JSON", item, ctx)).toThrow("Consolidate: AI response contained no extractable JSON");
		});

		it("handles non-array values for expected array fields", () => {
			const response = JSON.stringify({
				duplicates: "not an array",
				cross_dependencies: 42,
				parallel_groups: null,
				execution_order: { wrong: true },
			});
			const result = consolidatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.duplicates).toEqual([]);
			expect(result.cross_dependencies).toEqual([]);
			expect(result.parallel_groups).toEqual([]);
			expect(result.execution_order).toEqual([]);
		});
	});

	// ============================================================================
	// nextPhase
	// ============================================================================

	describe("nextPhase", () => {
		it("returns exec when result succeeded", () => {
			const ctx = createMockPhaseContext();
			const results = [
				{
					item: { tasks: [], issues: [] },
					result: { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(consolidatePhaseConfig.nextPhase!(results, ctx)).toBe("exec");
		});

		it("returns 'exec' even with empty results", () => {
			const ctx = createMockPhaseContext();
			expect(consolidatePhaseConfig.nextPhase!([], ctx)).toBe("exec");
		});

		it("returns failed when all results failed", () => {
			const ctx = createMockPhaseContext();
			const results = [
				{
					item: { tasks: [], issues: [] },
					result: { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] },
					success: false,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: { tasks: [], issues: [] },
					result: { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] },
					success: false,
					inputTokens: 80,
					outputTokens: 40,
				},
			];
			expect(consolidatePhaseConfig.nextPhase!(results, ctx)).toBe("failed");
		});

		it("returns exec when at least one result succeeded in mixed results", () => {
			const ctx = createMockPhaseContext();
			const results = [
				{
					item: { tasks: [], issues: [] },
					result: { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] },
					success: false,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: { tasks: [], issues: [] },
					result: { duplicates: [], cross_dependencies: [], parallel_groups: [], execution_order: [] },
					success: true,
					inputTokens: 80,
					outputTokens: 40,
				},
			];
			expect(consolidatePhaseConfig.nextPhase!(results, ctx)).toBe("exec");
		});
	});

	// ============================================================================
	// saveResults — dangling dependency stripping
	// ============================================================================

	describe("saveResults - dangling dependency stripping", () => {
		const testDir = join(process.cwd(), ".test-consolidate-dangling");

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

		it("strips dangling dependency IDs from cross_dependencies before saving", async () => {
			const run = await createRun({ scope: "consolidate dangling", workDir: testDir });
			const t1 = createTaskForRun(run.id, createTestTaskData("ISS-1"), testDir);
			const t2 = createTaskForRun(run.id, createTestTaskData("ISS-1"), testDir);

			const ctx = createMockPhaseContext({
				runId: run.id,
				workDir: testDir,
				store: {
					allTasks: loadTasksForRun(run.id, testDir),
					allIssues: [],
				},
			});

			// Simulate a consolidation result with a dangling dep
			const results = [
				{
					item: { tasks: [], issues: [] },
					result: {
						duplicates: [],
						cross_dependencies: [
							{
								task_id: t2.id,
								depends_on: [t1.id, "NON-EXISTENT-TASK-ID"],
								reason: "test",
							},
						],
						parallel_groups: [],
						execution_order: [t1.id, t2.id],
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			await consolidatePhaseConfig.saveResults!(results, ctx);

			// Reload and check that dangling dep was stripped
			const savedTasks = loadTasksForRun(run.id, testDir);
			const savedT2 = savedTasks.find((t) => t.id === t2.id);
			expect(savedT2).toBeDefined();
			// The dangling "NON-EXISTENT-TASK-ID" should have been stripped
			expect(savedT2!.depends_on).not.toContain("NON-EXISTENT-TASK-ID");
			// The valid dep should remain
			expect(savedT2!.depends_on).toContain(t1.id);
		});
	});

	// ============================================================================
	// Config assertions
	// ============================================================================

	describe("config assertions", () => {
		it("mode is 'single-agent'", () => {
			expect(consolidatePhaseConfig.mode).toBe("single-agent");
		});

		it("defaultParallel is 1", () => {
			expect(consolidatePhaseConfig.defaultParallel).toBe(1);
		});

		it("has correct name and role", () => {
			expect(consolidatePhaseConfig.name).toBe("consolidate");
			expect(consolidatePhaseConfig.role).toBe("CDM");
		});

		it("has engineMetadata with maxTokens and maxTurns", () => {
			expect(consolidatePhaseConfig.engineMetadata?.maxTokens).toBe(32000);
			expect(consolidatePhaseConfig.engineMetadata?.maxTurns).toBe(15);
		});
	});
});
