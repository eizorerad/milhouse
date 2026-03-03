/**
 * Unit tests for scan phase config (scanPhaseConfig)
 *
 * Tests parseResponse, loadItems, nextPhase, and isValidIssue logic.
 *
 * @module tests/unit/runner/phases/scan.test.ts
 */

import { describe, expect, it } from "bun:test";
import { scanPhaseConfig } from "../../../../src/runner/phases/scan.ts";
import { createMockPhaseContext } from "../helpers.ts";

// ============================================================================
// parseResponse
// ============================================================================

describe("scanPhaseConfig", () => {
	describe("parseResponse", () => {
		const ctx = createMockPhaseContext();
		const item = { scope: "test", workDir: "/tmp" };

		it("returns issues from valid JSON array", () => {
			const response = JSON.stringify([
				{ title: "Bug 1", rationale: "Cause 1", severity: "HIGH" },
				{ title: "Bug 2", rationale: "Cause 2", severity: "LOW" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(2);
			expect(result.issues[0].title).toBe("Bug 1");
			expect(result.issues[0].severity).toBe("HIGH");
			expect(result.issues[1].title).toBe("Bug 2");
		});

		it("returns issues from JSON wrapped in {items: [...]}", () => {
			const response = JSON.stringify({
				items: [
					{ title: "Feature 1", rationale: "Why 1", severity: "MEDIUM" },
				],
			});
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
			expect(result.issues[0].title).toBe("Feature 1");
		});

		it("throws for invalid JSON", () => {
			expect(() => scanPhaseConfig.parseResponse("not valid json at all", item, ctx)).toThrow("Scan: AI response contained no extractable JSON");
		});

		it("throws for empty response", () => {
			expect(() => scanPhaseConfig.parseResponse("", item, ctx)).toThrow("Scan: AI response contained no extractable JSON");
		});

		it("filters out items missing both title and symptom", () => {
			const response = JSON.stringify([
				{ title: "Valid", rationale: "Has rationale", severity: "HIGH" },
				{ rationale: "No title or symptom", severity: "LOW" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
			expect(result.issues[0].title).toBe("Valid");
		});

		it("filters out items missing both rationale and hypothesis", () => {
			const response = JSON.stringify([
				{ title: "Has title", severity: "HIGH" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(0);
		});

		it("accepts items with symptom instead of title", () => {
			const response = JSON.stringify([
				{ symptom: "Old-style symptom", hypothesis: "Old-style hypothesis", severity: "MEDIUM" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
		});

		it("defaults severity to MEDIUM when missing", () => {
			const response = JSON.stringify([
				{ title: "No severity", rationale: "Has rationale" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
			expect(result.issues[0].severity).toBe("MEDIUM");
		});

		it("defaults severity to MEDIUM when invalid value", () => {
			const response = JSON.stringify([
				{ title: "Bad severity", rationale: "Has rationale", severity: "ULTRA" },
			]);
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
			expect(result.issues[0].severity).toBe("MEDIUM");
		});

		it("throws for non-array JSON object without items (unrecognized structure)", () => {
			const response = JSON.stringify({ foo: "bar" });
			expect(() => scanPhaseConfig.parseResponse(response, item, ctx)).toThrow("Scan: AI response JSON has unrecognized structure");
		});

		it("handles JSON inside markdown code block", () => {
			const response = '```json\n[{"title": "In block", "rationale": "Test", "severity": "HIGH"}]\n```';
			const result = scanPhaseConfig.parseResponse(response, item, ctx);
			expect(result.issues.length).toBe(1);
			expect(result.issues[0].title).toBe("In block");
		});
	});

	// ============================================================================
	// loadItems
	// ============================================================================

	describe("loadItems", () => {
		it("returns single item with scope from config.scanFocus", () => {
			const ctx = createMockPhaseContext({
				config: { scanFocus: "security vulnerabilities" },
			});
			const items = scanPhaseConfig.loadItems(ctx);
			expect(items.length).toBe(1);
			expect(items[0].scope).toBe("security vulnerabilities");
			expect(items[0].workDir).toBe(ctx.workDir);
		});

		it("returns default scope when scanFocus is undefined", () => {
			const ctx = createMockPhaseContext();
			const items = scanPhaseConfig.loadItems(ctx);
			expect(items.length).toBe(1);
			expect(items[0].scope).toBe("find and analyze issues");
		});
	});

	// ============================================================================
	// nextPhase
	// ============================================================================

	describe("nextPhase", () => {
		it("returns 'validate' when results have issues", () => {
			const results = [
				{
					item: {},
					result: { issues: [{ title: "Bug", rationale: "R", severity: "HIGH" }] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			const ctx = createMockPhaseContext();
			const next = scanPhaseConfig.nextPhase!(results, ctx);
			expect(next).toBe("validate");
		});

		it("returns 'completed' when no issues found", () => {
			const results = [
				{
					item: {},
					result: { issues: [] },
					success: true,
					inputTokens: 100,
					outputTokens: 50,
				},
			];
			const ctx = createMockPhaseContext();
			const next = scanPhaseConfig.nextPhase!(results, ctx);
			expect(next).toBe("completed");
		});

		it("returns 'completed' when result is not successful", () => {
			const results = [
				{
					item: {},
					result: { issues: [{ title: "Bug", rationale: "R", severity: "HIGH" }] },
					success: false,
					error: "AI failed",
					inputTokens: 0,
					outputTokens: 0,
				},
			];
			const ctx = createMockPhaseContext();
			const next = scanPhaseConfig.nextPhase!(results, ctx);
			expect(next).toBe("completed");
		});
	});

	// ============================================================================
	// Config assertions
	// ============================================================================

	describe("config assertions", () => {
		it("has correct name", () => {
			expect(scanPhaseConfig.name).toBe("scan");
		});

		it("has correct role", () => {
			expect(scanPhaseConfig.role).toBe("LI");
		});

		it("has single-agent mode", () => {
			expect(scanPhaseConfig.mode).toBe("single-agent");
		});

		it("has defaultParallel of 1", () => {
			expect(scanPhaseConfig.defaultParallel).toBe(1);
		});

		it("has engineMetadata with maxTurns", () => {
			expect(scanPhaseConfig.engineMetadata?.maxTurns).toBe(100);
		});
	});
});
