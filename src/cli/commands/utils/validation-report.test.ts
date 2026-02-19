/**
 * @fileoverview Tests for validation-report.ts
 *
 * Tests for report generation and saving functions.
 */

import { describe, expect, it } from "bun:test";
import { generateMarkdownReport } from "./validation-report.ts";
import type { DeepValidationReport } from "./validation-types.ts";

// Create a mock report for testing
const createMockReport = (overrides: Partial<DeepValidationReport> = {}): DeepValidationReport => ({
	issue_id: "P-test123-abc",
	status: "CONFIRMED",
	confidence: "HIGH",
	summary: "Test summary of the validation findings.",
	investigation: {
		files_examined: ["src/test.ts", "src/utils.ts"],
		commands_run: ["npm test", "npm run lint"],
		patterns_found: ["Pattern A in 3 files"],
		related_code: [
			{
				file: "src/test.ts",
				line_start: 10,
				line_end: 20,
				relevance: "Main bug location",
				code_snippet: "const x = 1;",
			},
		],
	},
	root_cause_analysis: {
		confirmed_cause: "Buffer overflow in loop",
		alternative_causes: ["Memory leak possibility"],
		why_not_false_positive: "Reproduced consistently",
	},
	impact_assessment: {
		severity_confirmed: true,
		actual_severity: "HIGH",
		affected_components: ["ComponentA", "ComponentB"],
		user_impact: "Users experience slow performance",
		security_implications: "No security impact",
	},
	reproduction: {
		reproducible: true,
		steps: ["Step 1: Run command", "Step 2: Check output"],
		conditions: "Only under heavy load",
	},
	recommendations: {
		fix_approach: "Optimize the loop buffer handling",
		estimated_complexity: "MEDIUM",
		prerequisites: ["Update dependency X"],
		test_strategy: "Add unit tests for buffer handling",
	},
	evidence: [
		{
			type: "file",
			file: "src/test.ts",
			line_start: 10,
			line_end: 20,
			timestamp: "2024-01-01T00:00:00Z",
		},
	],
	...overrides,
});

describe("validation-report", () => {
	describe("generateMarkdownReport", () => {
		it("should include the issue ID in the report header", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("# Validation Report: P-test123-abc");
		});

		it("should include the status with emoji", () => {
			const confirmed = createMockReport({ status: "CONFIRMED" });
			const falsePositive = createMockReport({ status: "FALSE" });
			const partial = createMockReport({ status: "PARTIAL" });
			const misdiagnosed = createMockReport({ status: "MISDIAGNOSED" });

			expect(generateMarkdownReport(confirmed)).toContain("CONFIRMED");
			expect(generateMarkdownReport(falsePositive)).toContain("FALSE");
			expect(generateMarkdownReport(partial)).toContain("PARTIAL");
			expect(generateMarkdownReport(misdiagnosed)).toContain("MISDIAGNOSED");
		});

		it("should include confidence level", () => {
			const report = createMockReport({ confidence: "HIGH" });
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("**Confidence**: HIGH");
		});

		it("should include the summary", () => {
			const report = createMockReport({ summary: "This is a detailed test summary." });
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("This is a detailed test summary.");
		});

		it("should include files examined", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("`src/test.ts`");
			expect(markdown).toContain("`src/utils.ts`");
		});

		it("should include commands run", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("`npm test`");
			expect(markdown).toContain("`npm run lint`");
		});

		it("should include patterns found", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("Pattern A in 3 files");
		});

		it("should include related code with file and line info", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("src/test.ts:10-20");
			expect(markdown).toContain("Main bug location");
		});

		it("should include root cause analysis", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("Buffer overflow in loop");
			expect(markdown).toContain("Memory leak possibility");
			expect(markdown).toContain("Reproduced consistently");
		});

		it("should include impact assessment table", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("Severity Confirmed");
			expect(markdown).toContain("Affected Components");
			expect(markdown).toContain("ComponentA, ComponentB");
		});

		it("should include reproduction steps", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("1. Step 1: Run command");
			expect(markdown).toContain("2. Step 2: Check output");
			expect(markdown).toContain("Only under heavy load");
		});

		it("should include recommendations", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("Optimize the loop buffer handling");
			expect(markdown).toContain("**Estimated Complexity**: MEDIUM");
			expect(markdown).toContain("Update dependency X");
		});

		it("should include evidence section", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("## Evidence");
			expect(markdown).toContain("file: src/test.ts");
		});

		it("should include corrected description when present", () => {
			const report = createMockReport({ corrected_description: "This is the corrected description." });
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("## Corrected Description");
			expect(markdown).toContain("This is the corrected description.");
		});

		it("should handle empty arrays gracefully", () => {
			const report = createMockReport({
				investigation: {
					files_examined: [],
					commands_run: [],
					patterns_found: [],
					related_code: [],
				},
				recommendations: {
					fix_approach: "Fix it",
					estimated_complexity: "LOW",
				},
				evidence: [],
			});
			const markdown = generateMarkdownReport(report);

			expect(markdown).toContain("No files examined");
			expect(markdown).toContain("No commands run");
		});

		it("should return a non-empty markdown string", () => {
			const report = createMockReport();
			const markdown = generateMarkdownReport(report);

			expect(markdown.length).toBeGreaterThan(100);
			expect(markdown).toContain("#"); // Should have markdown headers
		});
	});
});
