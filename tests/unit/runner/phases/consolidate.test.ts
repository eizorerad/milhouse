/**
 * Unit tests for consolidate phase config (consolidatePhaseConfig)
 *
 * Tests parseResponse, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/consolidate.test.ts
 */

import { describe, expect, it } from "bun:test";
import { consolidatePhaseConfig } from "../../../../src/runner/phases/consolidate.ts";
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

		it("returns all empty arrays for malformed JSON", () => {
			const result = consolidatePhaseConfig.parseResponse("{invalid json", item, ctx);
			expect(result.duplicates).toEqual([]);
			expect(result.cross_dependencies).toEqual([]);
			expect(result.parallel_groups).toEqual([]);
			expect(result.execution_order).toEqual([]);
		});

		it("returns all empty arrays when no JSON extractable", () => {
			const result = consolidatePhaseConfig.parseResponse("Just text, no JSON", item, ctx);
			expect(result.duplicates).toEqual([]);
			expect(result.cross_dependencies).toEqual([]);
			expect(result.parallel_groups).toEqual([]);
			expect(result.execution_order).toEqual([]);
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
		it("always returns 'exec'", () => {
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
