/**
 * Unit tests for verify phase config (verifyPhaseConfig)
 *
 * Tests parseResponse, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/verify.test.ts
 */

import { describe, expect, it } from "bun:test";
import { verifyPhaseConfig } from "../../../../src/runner/phases/verify.ts";
import { createMockPhaseContext } from "../helpers.ts";

// ============================================================================
// parseResponse
// ============================================================================

describe("verifyPhaseConfig", () => {
	describe("parseResponse", () => {
		const ctx = createMockPhaseContext();
		const item = { tasks: [], preCheckIssues: [] };

		it("parses valid JSON with overall_pass=true", () => {
			const response = JSON.stringify({
				overall_pass: true,
				gates: [
					{ gate: "tests", passed: true, message: "All tests pass" },
					{ gate: "lint", passed: true },
				],
				recommendations: ["Consider adding more edge case tests"],
				regressions_found: false,
				summary: "All gates passed successfully",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.overall_pass).toBe(true);
			expect(result.gates.length).toBe(2);
			expect(result.gates[0].gate).toBe("tests");
			expect(result.gates[0].passed).toBe(true);
			expect(result.recommendations).toEqual(["Consider adding more edge case tests"]);
			expect(result.regressions_found).toBe(false);
			expect(result.summary).toBe("All gates passed successfully");
		});

		it("parses valid JSON with overall_pass=false", () => {
			const response = JSON.stringify({
				overall_pass: false,
				gates: [
					{ gate: "tests", passed: false, message: "3 test failures" },
				],
				recommendations: ["Fix failing tests"],
				regressions_found: true,
				summary: "Verification failed",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.overall_pass).toBe(false);
			expect(result.regressions_found).toBe(true);
		});

		it("defaults overall_pass to false when missing", () => {
			const response = JSON.stringify({
				gates: [],
				summary: "Missing pass",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.overall_pass).toBe(false);
		});

		it("defaults gates to empty array when missing", () => {
			const response = JSON.stringify({
				overall_pass: true,
				summary: "No gates",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.gates).toEqual([]);
		});

		it("defaults recommendations to empty array when missing", () => {
			const response = JSON.stringify({
				overall_pass: true,
				gates: [],
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.recommendations).toEqual([]);
		});

		it("defaults regressions_found to false when missing", () => {
			const response = JSON.stringify({
				overall_pass: true,
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.regressions_found).toBe(false);
		});

		it("defaults summary to empty string when missing", () => {
			const response = JSON.stringify({
				overall_pass: true,
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.summary).toBe("");
		});

		it("returns failure result when no JSON extractable", () => {
			const result = verifyPhaseConfig.parseResponse("Plain text, no JSON", item, ctx);
			expect(result.overall_pass).toBe(false);
			expect(result.gates.length).toBe(1);
			expect(result.gates[0].gate).toBe("parsing");
			expect(result.gates[0].passed).toBe(false);
			expect(result.gates[0].message).toBe("Failed to extract JSON");
			expect(result.recommendations).toEqual([]);
			expect(result.regressions_found).toBe(false);
		});

		it("returns failure result for JSON parse error", () => {
			// Wrap in markdown code block to make extractJsonFromResponse return a value
			// but still fail JSON.parse
			const result = verifyPhaseConfig.parseResponse("```json\n{broken json}\n```", item, ctx);
			expect(result.overall_pass).toBe(false);
			expect(result.gates.length).toBe(1);
			expect(result.gates[0].gate).toBe("parsing");
			expect(result.gates[0].passed).toBe(false);
		});

		it("handles empty response", () => {
			const result = verifyPhaseConfig.parseResponse("", item, ctx);
			expect(result.overall_pass).toBe(false);
		});

		it("defaults non-boolean overall_pass to false", () => {
			const response = JSON.stringify({
				overall_pass: "yes",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.overall_pass).toBe(false);
		});

		it("defaults non-boolean regressions_found to false", () => {
			const response = JSON.stringify({
				overall_pass: true,
				regressions_found: "no",
			});
			const result = verifyPhaseConfig.parseResponse(response, item, ctx);
			expect(result.regressions_found).toBe(false);
		});
	});

	// ============================================================================
	// nextPhase
	// ============================================================================

	describe("nextPhase", () => {
		const ctx = createMockPhaseContext();

		it("returns 'completed' when all results pass", () => {
			const results = [
				{
					item: { tasks: [], preCheckIssues: [] },
					result: {
						overall_pass: true,
						gates: [],
						recommendations: [],
						regressions_found: false,
						summary: "OK",
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(verifyPhaseConfig.nextPhase!(results, ctx)).toBe("completed");
		});

		it("returns 'failed' when any result fails overall_pass", () => {
			const results = [
				{
					item: { tasks: [], preCheckIssues: [] },
					result: {
						overall_pass: false,
						gates: [{ gate: "tests", passed: false }],
						recommendations: [],
						regressions_found: true,
						summary: "Failed",
					},
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(verifyPhaseConfig.nextPhase!(results, ctx)).toBe("failed");
		});

		it("returns 'failed' when result success is false", () => {
			const results = [
				{
					item: { tasks: [], preCheckIssues: [] },
					result: {
						overall_pass: true,
						gates: [],
						recommendations: [],
						regressions_found: false,
						summary: "",
					},
					success: false,
					error: "Engine error",
					inputTokens: 0,
					outputTokens: 0,
				},
			];
			expect(verifyPhaseConfig.nextPhase!(results, ctx)).toBe("failed");
		});

		it("returns 'failed' for empty results (no tasks verified)", () => {
			expect(verifyPhaseConfig.nextPhase!([], ctx)).toBe("failed");
		});
	});

	// ============================================================================
	// Config assertions
	// ============================================================================

	describe("config assertions", () => {
		it("mode is 'single-agent'", () => {
			expect(verifyPhaseConfig.mode).toBe("single-agent");
		});

		it("defaultParallel is 1", () => {
			expect(verifyPhaseConfig.defaultParallel).toBe(1);
		});

		it("has correct name and role", () => {
			expect(verifyPhaseConfig.name).toBe("verify");
			expect(verifyPhaseConfig.role).toBe("TV");
		});

		it("engineMetadata.maxTurns is 100", () => {
			expect(verifyPhaseConfig.engineMetadata?.maxTurns).toBe(100);
		});
	});
});
