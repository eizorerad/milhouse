import { describe, expect, test } from "bun:test";
import type { PhaseItemResult } from "../../../src/runner/types.ts";

type TestResult = { issues: string[]; score: number };

describe("PhaseItemResult discriminated union", () => {
	test("success path: result is required and accessible", () => {
		const r: PhaseItemResult<TestResult> = {
			success: true,
			item: { id: "test-1" },
			result: { issues: ["bug-1", "bug-2"], score: 95 },
			inputTokens: 100,
			outputTokens: 200,
		};

		expect(r.success).toBe(true);
		expect(r.result.issues).toEqual(["bug-1", "bug-2"]);
		expect(r.result.score).toBe(95);
	});

	test("failure path without result: result is undefined", () => {
		const r: PhaseItemResult<TestResult> = {
			success: false,
			item: { id: "test-2" },
			error: "AI execution failed",
			inputTokens: 0,
			outputTokens: 0,
		};

		expect(r.success).toBe(false);
		expect(r.result).toBeUndefined();
		expect(r.error).toBe("AI execution failed");
	});

	test("failure path with result: optional result is accessible", () => {
		const r: PhaseItemResult<TestResult> = {
			success: false,
			item: { id: "test-3" },
			result: { issues: [], score: 0 },
			error: "partial failure",
			inputTokens: 50,
			outputTokens: 75,
		};

		expect(r.success).toBe(false);
		expect(r.result).toBeDefined();
		expect(r.result!.issues).toEqual([]);
		expect(r.result!.score).toBe(0);
	});

	test("consumer narrowing pattern: if (!r.success) skip, then access result", () => {
		const results: PhaseItemResult<TestResult>[] = [
			{
				success: true,
				item: { id: "a" },
				result: { issues: ["i1"], score: 80 },
				inputTokens: 10,
				outputTokens: 20,
			},
			{
				success: false,
				item: { id: "b" },
				error: "failed",
				inputTokens: 0,
				outputTokens: 0,
			},
			{
				success: true,
				item: { id: "c" },
				result: { issues: ["i2", "i3"], score: 60 },
				inputTokens: 30,
				outputTokens: 40,
			},
		];

		const collected: string[] = [];
		for (const r of results) {
			if (!r.success) continue;
			// TypeScript narrows r to success:true here, so r.result is TResult
			collected.push(...r.result.issues);
		}

		expect(collected).toEqual(["i1", "i2", "i3"]);
	});

	test("filter/ternary pattern: r.success ? r.result.xxx : fallback", () => {
		const results: PhaseItemResult<TestResult>[] = [
			{
				success: true,
				item: { id: "x" },
				result: { issues: ["a", "b"], score: 90 },
				inputTokens: 10,
				outputTokens: 20,
			},
			{
				success: false,
				item: { id: "y" },
				error: "error",
				inputTokens: 0,
				outputTokens: 0,
			},
		];

		const allIssues = results.flatMap((r) =>
			r.success ? r.result.issues : [],
		);

		expect(allIssues).toEqual(["a", "b"]);
	});
});
