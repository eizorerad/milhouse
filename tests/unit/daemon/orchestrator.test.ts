/**
 * Unit tests for orchestrator parseDirective
 *
 * Reproduces the original bug scenario: the greedy regex /{[\s\S]*}/
 * in parseDirective matched wrong JSON boundaries when AI output contained
 * multiple JSON-like structures. Verifies the refactored implementation
 * correctly extracts the directive and validates its fields.
 *
 * @module tests/unit/daemon/orchestrator
 */

import { describe, expect, test } from "bun:test";
import { parseDirective } from "../../../src/daemon/orchestrator.ts";

describe("parseDirective", () => {
	test("extracts directive from clean JSON response", () => {
		const input = '{"action": "run", "reasoning": "Found 3 unresolved issues"}';
		const result = parseDirective(input);
		expect(result.action).toBe("run");
		expect(result.reasoning).toBe("Found 3 unresolved issues");
	});

	test("extracts directive from JSON in markdown fence", () => {
		const input = `Here is my decision:

\`\`\`json
{"action": "stop", "reasoning": "All issues resolved", "stopReason": "complete"}
\`\`\``;
		const result = parseDirective(input);
		expect(result.action).toBe("stop");
		expect(result.reasoning).toBe("All issues resolved");
		expect(result.stopReason).toBe("complete");
	});

	test("extracts directive when preceded by text with braces in code fence", () => {
		// Original bug scenario: AI outputs reasoning text containing braces
		// before the actual JSON directive. The greedy regex would match from
		// the first '{' to the last '}', producing invalid JSON.
		const input = `I analyzed the state {runs: 2, budget: 80%} and the issues list.

\`\`\`json
{"action": "run", "reasoning": "Budget available, issues remain", "scope": "scan"}
\`\`\``;
		const result = parseDirective(input);
		expect(result.action).toBe("run");
		expect(result.reasoning).toBe("Budget available, issues remain");
		expect(result.scope).toBe("scan");
	});

	test("extracts first directive when response has both valid directive and a stray JSON-like structure after", () => {
		const input = `{"action": "run", "reasoning": "Issues need fixing"}

Additional context: the state object is {"status": "active", "count": 5}`;
		const result = parseDirective(input);
		expect(result.action).toBe("run");
		expect(result.reasoning).toBe("Issues need fixing");
	});

	test("throws on missing required action field", () => {
		const input = '{"reasoning": "Some reasoning"}';
		expect(() => parseDirective(input)).toThrow("Invalid action");
	});

	test("throws on invalid action value", () => {
		const input = '{"action": "pause", "reasoning": "Some reasoning"}';
		expect(() => parseDirective(input)).toThrow("Invalid action");
	});

	test("throws on missing reasoning field", () => {
		const input = '{"action": "run"}';
		expect(() => parseDirective(input)).toThrow("Missing reasoning field");
	});

	test("throws when no JSON found in response", () => {
		const input = "I could not decide what to do next.";
		expect(() => parseDirective(input)).toThrow("No JSON object found");
	});

	test("preserves optional fields when present", () => {
		const input = JSON.stringify({
			action: "run",
			reasoning: "Targeted fix needed",
			scope: "exec",
			strategy: "fix-first",
			phases: ["scan", "exec"],
			startPhase: "exec",
			resume: true,
			runId: "run-123",
			minSeverity: "HIGH",
			issueIds: ["P-abc-123"],
			excludeIssueIds: ["P-def-456"],
		});
		const result = parseDirective(input);
		expect(result.scope).toBe("exec");
		expect(result.strategy).toBe("fix-first");
		expect(result.phases).toEqual(["scan", "exec"]);
		expect(result.startPhase).toBe("exec");
		expect(result.resume).toBe(true);
		expect(result.runId).toBe("run-123");
		expect(result.minSeverity).toBe("HIGH");
		expect(result.issueIds).toEqual(["P-abc-123"]);
		expect(result.excludeIssueIds).toEqual(["P-def-456"]);
	});

	test("optional fields are undefined when absent", () => {
		const input = '{"action": "stop", "reasoning": "Done", "stopReason": "budget"}';
		const result = parseDirective(input);
		expect(result.scope).toBeUndefined();
		expect(result.strategy).toBeUndefined();
		expect(result.phases).toBeUndefined();
		expect(result.stopReason).toBe("budget");
	});
});
