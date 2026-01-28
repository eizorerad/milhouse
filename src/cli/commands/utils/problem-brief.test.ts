/**
 * @fileoverview Tests for problem-brief.ts
 *
 * Tests for problem brief generation functions.
 */

import { describe, expect, it } from "bun:test";
import { generateValidatedProblemBrief, formatIssueSection } from "./problem-brief.ts";
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

describe("problem-brief", () => {
	describe("generateValidatedProblemBrief", () => {
		it("should include the run ID", () => {
			const issues: Issue[] = [];
			const brief = generateValidatedProblemBrief(issues, "run-abc123");

			expect(brief).toContain("run-abc123");
		});

		it("should include status header", () => {
			const issues: Issue[] = [];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("**Status**: VALIDATED");
		});

		it("should count confirmed issues correctly", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "CONFIRMED" }),
				createMockIssue({ id: "P-2", status: "CONFIRMED" }),
				createMockIssue({ id: "P-3", status: "FALSE" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("| CONFIRMED | 2 |");
		});

		it("should count false positive issues correctly", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "FALSE" }),
				createMockIssue({ id: "P-2", status: "FALSE" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("| FALSE | 2 |");
		});

		it("should count partial issues correctly", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "PARTIAL" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("| PARTIAL | 1 |");
		});

		it("should count misdiagnosed issues correctly", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "MISDIAGNOSED" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("| MISDIAGNOSED | 1 |");
		});

		it("should count unvalidated issues correctly", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "UNVALIDATED" }),
				createMockIssue({ id: "P-2", status: "UNVALIDATED" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("| UNVALIDATED | 2 |");
		});

		it("should include confirmed issues section", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-confirmed", status: "CONFIRMED", symptom: "Confirmed symptom" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("## Confirmed Issues (Ready for Planning)");
			expect(brief).toContain("P-confirmed");
			expect(brief).toContain("Confirmed symptom");
		});

		it("should include partial issues section", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-partial", status: "PARTIAL", symptom: "Partial symptom" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("## Partial Issues (May Need Refinement)");
			expect(brief).toContain("P-partial");
		});

		it("should include misdiagnosed issues section", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-misdiagnosed", status: "MISDIAGNOSED" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("## Misdiagnosed Issues (Different Root Cause)");
			expect(brief).toContain("P-misdiagnosed");
		});

		it("should include false positives section with simplified format", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-false", status: "FALSE", symptom: "False positive symptom" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("## False Positives (Dismissed)");
			expect(brief).toContain("P-false");
			expect(brief).toContain("**Status**: FALSE");
		});

		it("should include next steps section", () => {
			const issues: Issue[] = [];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("## Next Steps");
			expect(brief).toContain("milhouse plan");
			expect(brief).toContain("milhouse consolidate");
		});

		it("should show 'No confirmed issues' when none exist", () => {
			const issues: Issue[] = [
				createMockIssue({ id: "P-1", status: "FALSE" }),
			];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("No confirmed issues.");
		});

		it("should handle empty issues array", () => {
			const issues: Issue[] = [];
			const brief = generateValidatedProblemBrief(issues, "run-123");

			expect(brief).toContain("**Total Issues**: 0");
			expect(brief.length).toBeGreaterThan(100);
		});
	});

	describe("formatIssueSection", () => {
		it("should include issue ID and symptom in header", () => {
			const issue = createMockIssue({ id: "P-test", symptom: "Test symptom" });
			const section = formatIssueSection(issue);

			expect(section).toContain("### P-test: Test symptom");
		});

		it("should include status in table", () => {
			const issue = createMockIssue({ status: "CONFIRMED" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Status** | CONFIRMED |");
		});

		it("should include severity in table", () => {
			const issue = createMockIssue({ severity: "CRITICAL" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Severity** | CRITICAL |");
		});

		it("should include hypothesis in table", () => {
			const issue = createMockIssue({ hypothesis: "Test hypothesis text" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Hypothesis** | Test hypothesis text |");
		});

		it("should include corrected description when present", () => {
			const issue = createMockIssue({ corrected_description: "Corrected text" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Corrected Description** | Corrected text |");
		});

		it("should include frequency when present", () => {
			const issue = createMockIssue({ frequency: "daily" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Frequency** | daily |");
		});

		it("should include strategy when present", () => {
			const issue = createMockIssue({ strategy: "Fix immediately" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Strategy** | Fix immediately |");
		});

		it("should include validated_by when present", () => {
			const issue = createMockIssue({ validated_by: "IV" });
			const section = formatIssueSection(issue);

			expect(section).toContain("| **Validated By** | IV |");
		});

		it("should include file evidence with line numbers", () => {
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
			const section = formatIssueSection(issue);

			expect(section).toContain("#### Evidence");
			expect(section).toContain("`src/test.ts`");
			expect(section).toContain(":10-20");
		});

		it("should include command evidence with output", () => {
			const issue = createMockIssue({
				evidence: [
					{
						type: "command",
						command: "npm test",
						output: "Test output text",
						timestamp: "2024-01-01T00:00:00Z",
					},
				],
			});
			const section = formatIssueSection(issue);

			expect(section).toContain("`npm test`");
			expect(section).toContain("Output: Test output text");
		});

		it("should include probe evidence", () => {
			const issue = createMockIssue({
				evidence: [
					{
						type: "probe",
						probe_id: "probe-123",
						timestamp: "2024-01-01T00:00:00Z",
					},
				],
			});
			const section = formatIssueSection(issue);

			expect(section).toContain("**Probe**: probe-123");
		});

		it("should truncate long command output", () => {
			const longOutput = "a".repeat(300);
			const issue = createMockIssue({
				evidence: [
					{
						type: "command",
						command: "test",
						output: longOutput,
						timestamp: "2024-01-01T00:00:00Z",
					},
				],
			});
			const section = formatIssueSection(issue);

			expect(section).toContain("...");
			expect(section.length).toBeLessThan(longOutput.length + 500);
		});

		it("should handle issues without evidence", () => {
			const issue = createMockIssue({ evidence: [] });
			const section = formatIssueSection(issue);

			expect(section).not.toContain("#### Evidence");
		});

		it("should end with separator", () => {
			const issue = createMockIssue();
			const section = formatIssueSection(issue);

			expect(section).toMatch(/---\n$/);
		});
	});
});
