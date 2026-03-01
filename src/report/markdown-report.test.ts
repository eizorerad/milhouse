/**
 * Tests for markdown report generation — verification section
 */

import { describe, expect, it } from "bun:test";
import type { JsonRunReport } from "./json-report.ts";
import { generateMarkdownReport } from "./markdown-report.ts";

/** Create a minimal JsonRunReport for testing */
function makeReport(overrides: Partial<JsonRunReport> = {}): JsonRunReport {
	return {
		version: "0.2.0",
		run_id: "test-run-1",
		status: "completed",
		created_at: "2024-01-15T10:00:00Z",
		duration_ms: 60000,
		cost: {
			total: 0.015,
			currency: "USD",
			by_phase: {},
		},
		results: {
			items_found: 1,
			items_confirmed: 1,
			items_false: 0,
			items_partial: 0,
			tasks_created: 1,
			tasks_completed: 1,
			tasks_failed: 0,
		},
		items: [],
		errors: [],
		...overrides,
	};
}

describe("markdown-report verification section", () => {
	it("should include Verification section when verification data exists", () => {
		const report = makeReport({
			verification: {
				overall_pass: true,
				tasks_verified: 2,
				tasks_passed: 2,
				tasks_failed: 0,
				regressions_found: false,
				tasks: [
					{
						task_id: "T1",
						overall_pass: true,
						gates: [{ gate: "evidence", passed: true }],
						recommendations: [],
						regressions_found: false,
						summary: "All checks passed",
					},
					{
						task_id: "T2",
						overall_pass: true,
						gates: [{ gate: "dod", passed: true }],
						recommendations: [],
						regressions_found: false,
						summary: "DoD met",
					},
				],
				recommendations: [],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("## Verification");
		expect(md).toContain("**Overall**: PASS");
		expect(md).toContain("| T1 | PASS |");
		expect(md).toContain("| T2 | PASS |");
	});

	it("should omit Verification section when verification data is undefined", () => {
		const report = makeReport({ verification: undefined });

		const md = generateMarkdownReport(report);

		expect(md).not.toContain("## Verification");
	});

	it("should show FAIL status for failed verification", () => {
		const report = makeReport({
			verification: {
				overall_pass: false,
				tasks_verified: 1,
				tasks_passed: 0,
				tasks_failed: 1,
				regressions_found: false,
				tasks: [
					{
						task_id: "T1",
						overall_pass: false,
						gates: [
							{ gate: "evidence", passed: true },
							{ gate: "dod", passed: false, message: "DoD not met" },
						],
						recommendations: [],
						regressions_found: false,
						summary: "Failed DoD check",
					},
				],
				recommendations: [],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("**Overall**: FAIL");
		expect(md).toContain("| T1 | FAIL | dod |");
	});

	it("should show regression warning", () => {
		const report = makeReport({
			verification: {
				overall_pass: false,
				tasks_verified: 1,
				tasks_passed: 0,
				tasks_failed: 1,
				regressions_found: true,
				tasks: [
					{
						task_id: "T1",
						overall_pass: false,
						gates: [],
						recommendations: [],
						regressions_found: true,
						summary: "Regression detected",
					},
				],
				recommendations: [],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("**Warning**: Regressions detected");
	});

	it("should show recommendations when present", () => {
		const report = makeReport({
			verification: {
				overall_pass: true,
				tasks_verified: 1,
				tasks_passed: 1,
				tasks_failed: 0,
				regressions_found: false,
				tasks: [
					{
						task_id: "T1",
						overall_pass: true,
						gates: [],
						recommendations: ["Add tests"],
						regressions_found: false,
						summary: "Passed",
					},
				],
				recommendations: ["Add tests", "Improve docs"],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("### Recommendations");
		expect(md).toContain("- Add tests");
		expect(md).toContain("- Improve docs");
	});

	it("should show failed gates in the table", () => {
		const report = makeReport({
			verification: {
				overall_pass: false,
				tasks_verified: 1,
				tasks_passed: 0,
				tasks_failed: 1,
				regressions_found: false,
				tasks: [
					{
						task_id: "T1",
						overall_pass: false,
						gates: [
							{ gate: "evidence", passed: false },
							{ gate: "dod", passed: false },
							{ gate: "hygiene", passed: true },
						],
						recommendations: [],
						regressions_found: false,
						summary: "Multiple failures",
					},
				],
				recommendations: [],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("| T1 | FAIL | evidence, dod |");
	});

	it("should show dash for no failed gates", () => {
		const report = makeReport({
			verification: {
				overall_pass: true,
				tasks_verified: 1,
				tasks_passed: 1,
				tasks_failed: 0,
				regressions_found: false,
				tasks: [
					{
						task_id: "T1",
						overall_pass: true,
						gates: [{ gate: "evidence", passed: true }],
						recommendations: [],
						regressions_found: false,
						summary: "All good",
					},
				],
				recommendations: [],
			},
		});

		const md = generateMarkdownReport(report);

		expect(md).toContain("| T1 | PASS | - |");
	});
});
