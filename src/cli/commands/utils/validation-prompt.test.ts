/**
 * @fileoverview Tests for validation-prompt.ts
 *
 * Tests for prompt building functions used in validation.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { buildDeepIssueValidatorPrompt, buildIssueValidatorPrompt } from "./validation-prompt.ts";
import type { Issue } from "../../../state/types.ts";

// Create a mock issue for testing
const createMockIssue = (overrides: Partial<Issue> = {}): Issue => ({
	id: "P-test123-abc",
	symptom: "Test symptom description",
	hypothesis: "Test hypothesis about the issue",
	evidence: [],
	status: "UNVALIDATED",
	severity: "HIGH",
	frequency: "frequent",
	blast_radius: "moderate",
	strategy: "Fix approach suggestion",
	related_task_ids: [],
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	validated_by: null,
	corrected_description: null,
	...overrides,
});

describe("validation-prompt", () => {
	describe("buildDeepIssueValidatorPrompt", () => {
		it("should include the issue ID in the prompt", () => {
			const issue = createMockIssue();
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain(issue.id);
		});

		it("should include the symptom in the prompt", () => {
			const issue = createMockIssue({ symptom: "Memory leak in processing loop" });
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("Memory leak in processing loop");
		});

		it("should include the hypothesis in the prompt", () => {
			const issue = createMockIssue({ hypothesis: "Buffer not being released" });
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("Buffer not being released");
		});

		it("should include severity in the prompt", () => {
			const issue = createMockIssue({ severity: "CRITICAL" });
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("CRITICAL");
		});

		it("should include agent number in the prompt", () => {
			const issue = createMockIssue();
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 5);

			expect(prompt).toContain("Agent #5");
			expect(prompt).toContain("IV-5");
		});

		it("should include probe evidence when provided", () => {
			const issue = createMockIssue();
			const probeEvidence = "## Probe Results\n- Test probe passed";
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1, probeEvidence);

			expect(prompt).toContain("Probe Results");
			expect(prompt).toContain("Test probe passed");
		});

		it("should include JSON output format instructions", () => {
			const issue = createMockIssue();
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("```json");
			expect(prompt).toContain('"issue_id"');
			expect(prompt).toContain('"status"');
			expect(prompt).toContain('"confidence"');
		});

		it("should include all valid status options", () => {
			const issue = createMockIssue();
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("CONFIRMED");
			expect(prompt).toContain("FALSE");
			expect(prompt).toContain("PARTIAL");
			expect(prompt).toContain("MISDIAGNOSED");
		});

		it("should include investigation protocol phases", () => {
			const issue = createMockIssue();
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("Phase 1: Code Exploration");
			expect(prompt).toContain("Phase 2: Hypothesis Testing");
			expect(prompt).toContain("Phase 3: Impact Analysis");
			expect(prompt).toContain("Phase 4: Reproduction");
			expect(prompt).toContain("Phase 5: Recommendations");
		});

		it("should include previous evidence when present", () => {
			const issue = createMockIssue({
				evidence: [
					{
						type: "file",
						file: "src/test.ts",
						line_start: 10,
						line_end: 20,
						timestamp: "2024-01-01T00:00:00Z",
					},
				],
			});
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			expect(prompt).toContain("file: src/test.ts");
		});

		it("should handle issues without optional fields", () => {
			const issue = createMockIssue({
				frequency: null,
				blast_radius: null,
				strategy: null,
			});
			const prompt = buildDeepIssueValidatorPrompt(issue, "/tmp/test", 1);

			// Should not throw and should still include required fields
			expect(prompt).toContain(issue.id);
			expect(prompt).toContain(issue.symptom);
		});
	});

	describe("buildIssueValidatorPrompt", () => {
		it("should call buildDeepIssueValidatorPrompt with agentNum 0", () => {
			const issue = createMockIssue();
			const prompt = buildIssueValidatorPrompt(issue, "/tmp/test");

			// The legacy wrapper should use agent number 0
			expect(prompt).toContain("Agent #0");
		});

		it("should return a non-empty prompt", () => {
			const issue = createMockIssue();
			const prompt = buildIssueValidatorPrompt(issue, "/tmp/test");

			expect(prompt.length).toBeGreaterThan(0);
		});
	});
});
