/**
 * Unit tests for json-extractor utility
 *
 * Regression tests for multi-object JSON extraction scenarios that break
 * greedy regex approaches. Validates that extractJsonFromResponse and
 * extractBalancedJson correctly handle orchestrator-like inputs.
 *
 * @module tests/unit/utils/json-extractor
 */

import { describe, expect, test } from "bun:test";
import {
	extractBalancedJson,
	extractJsonFromResponse,
	extractAndParseJson,
} from "../../../src/utils/json-extractor.ts";

describe("json-extractor", () => {
	describe("extractJsonFromResponse with preamble text containing braces", () => {
		test("extracts correct JSON when output has preamble text with braces before the real JSON object", () => {
			// Preamble has closing braces and brackets but the first '{' is the real JSON.
			// A greedy regex /{[\s\S]*}/ would match from the first '{' to the LAST '}'
			// which includes trailing garbage. Balanced extraction stops correctly.
			const input = `I'm analyzing the output (see log entry showing } on line 42 and array [items: 3]).

{"action": "run", "reasoning": "Found unresolved issues"}`;

			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("run");
			expect(result!.reasoning).toBe("Found unresolved issues");
		});

		test("extracts correct JSON from code fence when preamble contains brace-like structures", () => {
			// When AI wraps response in a code fence, Strategy 1 finds it regardless of preamble braces.
			const input = `Based on the state {runs: 3, issues: 5} I will decide.
The config shows {budget: 100, used: 50} remaining.

\`\`\`json
{"action": "stop", "reasoning": "Budget nearly exhausted", "stopReason": "budget"}
\`\`\``;

			const result = extractAndParseJson<{ action: string; reasoning: string; stopReason: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("stop");
			expect(result!.reasoning).toBe("Budget nearly exhausted");
			expect(result!.stopReason).toBe("budget");
		});
	});

	describe("extractJsonFromResponse with multiple JSON objects", () => {
		test("extracts first valid JSON object when multiple objects are present in output", () => {
			// A greedy regex /{[\s\S]*}/ matches from first '{' to LAST '}',
			// capturing both objects and intermediate text → parse failure.
			// Balanced extraction correctly stops at the first object's closing '}'.
			const input = `{"action": "run", "reasoning": "Issues need attention"}

Some intermediate text.

{"action": "stop", "reasoning": "Changed my mind"}`;

			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("run");
			expect(result!.reasoning).toBe("Issues need attention");
		});

		test("extracts first JSON object even when second is larger", () => {
			const input = `{"action": "run", "reasoning": "Go"}

{"action": "stop", "reasoning": "Actually stop", "stopReason": "complete", "summary": "All done with extra fields"}`;

			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("run");
			expect(result!.reasoning).toBe("Go");
		});
	});

	describe("extractJsonFromResponse with trailing text containing braces", () => {
		test("extracts correct JSON when trailing text contains braces", () => {
			// This is the core greedy-regex bug: /{[\s\S]*}/ matches from the JSON's '{'
			// all the way to the last '}' in the trailing text → wrong boundaries.
			// Balanced extraction stops at the JSON's own closing '}'.
			const input = `{"action": "run", "reasoning": "Found issues to address"}

Note: the daemon state shows {status: active, runs: 2} and will continue.`;

			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("run");
			expect(result!.reasoning).toBe("Found issues to address");
		});

		test("extracts correct JSON when log-like lines with braces follow", () => {
			const input = `{"action": "stop", "reasoning": "All issues resolved", "stopReason": "complete"}
[2024-01-01T00:00:00Z] {level: "info"} Orchestrator made decision
[2024-01-01T00:00:01Z] {level: "debug"} Sending directive to daemon`;

			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("stop");
			expect(result!.reasoning).toBe("All issues resolved");
		});
	});

	describe("extractBalancedJson with nested structures", () => {
		test("handles deeply nested JSON objects", () => {
			const input = `{"action": "run", "reasoning": "test", "scope": {"phases": ["scan"], "config": {"depth": 1}}}`;
			const result = extractBalancedJson(input, "{");
			expect(result).not.toBeNull();
			const parsed = JSON.parse(result!);
			expect(parsed.action).toBe("run");
			expect(parsed.scope.phases).toEqual(["scan"]);
			expect(parsed.scope.config.depth).toBe(1);
		});

		test("handles JSON with strings containing braces", () => {
			const input = `{"action": "run", "reasoning": "Found {critical} issues in {src/main.ts}"}`;
			const result = extractBalancedJson(input, "{");
			expect(result).not.toBeNull();
			const parsed = JSON.parse(result!);
			expect(parsed.action).toBe("run");
			expect(parsed.reasoning).toBe("Found {critical} issues in {src/main.ts}");
		});

		test("extracts first balanced object from text with multiple objects", () => {
			const input = `{"first": true} {"second": true}`;
			const result = extractBalancedJson(input, "{");
			expect(result).not.toBeNull();
			const parsed = JSON.parse(result!);
			expect(parsed.first).toBe(true);
			expect(parsed.second).toBeUndefined();
		});
	});

	describe("extractJsonFromResponse with markdown fences", () => {
		test("extracts JSON from markdown code fence", () => {
			const input = "Here is my decision:\n\n```json\n{\"action\": \"run\", \"reasoning\": \"Issues found\"}\n```";
			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("run");
		});

		test("extracts JSON from code fence when surrounding text has braces", () => {
			const input = "Looking at {state} and {config}:\n\n```json\n{\"action\": \"stop\", \"reasoning\": \"Done\"}\n```\n\nEnd of response with {extra} braces.";
			const result = extractAndParseJson<{ action: string; reasoning: string }>(input);
			expect(result).not.toBeNull();
			expect(result!.action).toBe("stop");
			expect(result!.reasoning).toBe("Done");
		});
	});
});
