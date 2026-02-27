/**
 * Unit tests for validate phase config (validatePhaseConfig)
 *
 * Tests parseResponse, retryFilter, nextPhase, and config assertions.
 *
 * @module tests/unit/runner/phases/validate.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { validatePhaseConfig } from "../../../../src/runner/phases/validate.ts";
import * as logger from "../../../../src/ui/logger.ts";
import { createMockIssue, createMockPhaseContext } from "../helpers.ts";

// ============================================================================
// parseResponse
// ============================================================================

describe("validatePhaseConfig", () => {
	let logWarnSpy: ReturnType<typeof spyOn>;
	let logDebugSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		logWarnSpy = spyOn(logger, "logWarn").mockImplementation(() => {});
		logDebugSpy = spyOn(logger, "logDebug").mockImplementation(() => {});
	});

	afterEach(() => {
		logWarnSpy.mockRestore();
		logDebugSpy.mockRestore();
	});

	describe("parseResponse", () => {
		const ctx = createMockPhaseContext();
		const item = createMockIssue({ id: "TEST-001" });

		it("parses valid JSON with CONFIRMED status", () => {
			const response = JSON.stringify({
				status: "CONFIRMED",
				confidence: "HIGH",
				summary: "Issue confirmed",
				evidence: [{ type: "file", file: "src/test.ts" }],
			});
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("CONFIRMED");
			expect(result.issue_id).toBe("TEST-001");
			expect(result.confidence).toBe("HIGH");
			expect(result.summary).toBe("Issue confirmed");
			expect(result.evidence?.length).toBe(1);
		});

		it("parses valid JSON with PARTIAL status", () => {
			const response = JSON.stringify({
				status: "PARTIAL",
				summary: "Partially confirmed",
			});
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("PARTIAL");
		});

		it("parses valid JSON with FALSE status", () => {
			const response = JSON.stringify({ status: "FALSE" });
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("FALSE");
		});

		it("parses valid JSON with MISDIAGNOSED status", () => {
			const response = JSON.stringify({
				status: "MISDIAGNOSED",
				corrected_description: "Actually a different issue",
			});
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("MISDIAGNOSED");
			expect(result.corrected_description).toBe("Actually a different issue");
		});

		it("falls back to UNVALIDATED for invalid status", () => {
			const response = JSON.stringify({ status: "INVALID_STATUS" });
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("UNVALIDATED");
		});

		it("falls back to UNVALIDATED for UNVALIDATED status in response", () => {
			const response = JSON.stringify({ status: "UNVALIDATED" });
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.status).toBe("UNVALIDATED");
		});

		it("returns UNVALIDATED when no JSON extractable", () => {
			const result = validatePhaseConfig.parseResponse("Just plain text, no JSON here", item, ctx);
			expect(result.status).toBe("UNVALIDATED");
			expect(result.issue_id).toBe("TEST-001");
		});

		it("returns UNVALIDATED for malformed JSON", () => {
			const result = validatePhaseConfig.parseResponse('{"status": CONFIRMED}', item, ctx);
			expect(result.status).toBe("UNVALIDATED");
		});

		it("handles evidence array parsing", () => {
			const response = JSON.stringify({
				status: "CONFIRMED",
				evidence: [
					{ type: "file", file: "src/a.ts", line_start: 10, line_end: 20 },
					{ type: "command", output: "test output" },
				],
			});
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.evidence?.length).toBe(2);
			expect(result.evidence?.[0].type).toBe("file");
			expect(result.evidence?.[1].type).toBe("command");
		});

		it("defaults evidence to empty array when not an array", () => {
			const response = JSON.stringify({
				status: "CONFIRMED",
				evidence: "not an array",
			});
			const result = validatePhaseConfig.parseResponse(response, item, ctx);
			expect(result.evidence).toEqual([]);
		});

		it("returns UNVALIDATED for empty response", () => {
			const result = validatePhaseConfig.parseResponse("", item, ctx);
			expect(result.status).toBe("UNVALIDATED");
		});
	});

	// ============================================================================
	// retryFilter
	// ============================================================================

	describe("retryFilter", () => {
		it("returns items whose result status is UNVALIDATED", () => {
			const issue1 = createMockIssue({ id: "ISS-1" });
			const issue2 = createMockIssue({ id: "ISS-2" });
			const issue3 = createMockIssue({ id: "ISS-3" });
			const items = [issue1, issue2, issue3];

			const results = [
				{
					item: issue1,
					result: { issue_id: "ISS-1", status: "UNVALIDATED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: issue2,
					result: { issue_id: "ISS-2", status: "CONFIRMED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: issue3,
					result: { issue_id: "ISS-3", status: "UNVALIDATED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = validatePhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(2);
			expect(retryItems.map((i) => i.id)).toEqual(["ISS-1", "ISS-3"]);
		});

		it("does not retry items with CONFIRMED status", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];
			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", status: "CONFIRMED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = validatePhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(0);
		});

		it("does not retry items with FALSE status", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];
			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", status: "FALSE" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = validatePhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(0);
		});

		it("does not retry items with PARTIAL status", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];
			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", status: "PARTIAL" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];

			const retryItems = validatePhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(0);
		});

		it("does not retry failed results (success=false)", () => {
			const issue = createMockIssue({ id: "ISS-1" });
			const items = [issue];
			const results = [
				{
					item: issue,
					result: { issue_id: "ISS-1", status: "UNVALIDATED" as const },
					success: false,
					error: "Engine error",
					inputTokens: 0,
					outputTokens: 0,
				},
			];

			const retryItems = validatePhaseConfig.retryFilter!(items, results);
			expect(retryItems.length).toBe(0);
		});
	});

	// ============================================================================
	// nextPhase
	// ============================================================================

	describe("nextPhase", () => {
		const ctx = createMockPhaseContext();

		it("returns 'plan' when any result is CONFIRMED", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", status: "CONFIRMED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(validatePhaseConfig.nextPhase!(results, ctx)).toBe("plan");
		});

		it("returns 'plan' when any result is PARTIAL", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", status: "PARTIAL" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(validatePhaseConfig.nextPhase!(results, ctx)).toBe("plan");
		});

		it("returns 'completed' when all are FALSE", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", status: "FALSE" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-2", status: "FALSE" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(validatePhaseConfig.nextPhase!(results, ctx)).toBe("completed");
		});

		it("returns 'completed' when all are MISDIAGNOSED", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", status: "MISDIAGNOSED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(validatePhaseConfig.nextPhase!(results, ctx)).toBe("completed");
		});

		it("returns 'plan' when mixed results include CONFIRMED", () => {
			const results = [
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-1", status: "FALSE" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
				{
					item: createMockIssue(),
					result: { issue_id: "ISS-2", status: "CONFIRMED" as const },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			expect(validatePhaseConfig.nextPhase!(results, ctx)).toBe("plan");
		});
	});

	// ============================================================================
	// Config assertions
	// ============================================================================

	describe("config assertions", () => {
		it("isRetryable is true", () => {
			expect(validatePhaseConfig.isRetryable).toBe(true);
		});

		it("maxRetryRounds is 2", () => {
			expect(validatePhaseConfig.maxRetryRounds).toBe(2);
		});

		it("mode is 'per-item'", () => {
			expect(validatePhaseConfig.mode).toBe("per-item");
		});

		it("defaultParallel is 5", () => {
			expect(validatePhaseConfig.defaultParallel).toBe(5);
		});

		it("has correct name and role", () => {
			expect(validatePhaseConfig.name).toBe("validate");
			expect(validatePhaseConfig.role).toBe("IV");
		});
	});
});
