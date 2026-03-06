/**
 * Tests for report generation.
 */

import { describe, expect, it } from "bun:test";
import {
	type RunReport,
	formatReportMarkdown,
	formatReportTerminal,
} from "../src/report.ts";

const mockReport: RunReport = {
	meta: {
		id: "run-20260101-test",
		scope: "fix bugs",
		phase: "completed",
		issues_found: 10,
		issues_validated: 7,
		tasks_total: 15,
		tasks_completed: 12,
		tasks_failed: 2,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T01:30:00Z",
	},
	issues: {
		total: 10,
		confirmed: 5,
		false_positive: 2,
		partial: 1,
		misdiagnosed: 1,
		unvalidated: 1,
		bySeverity: { CRITICAL: 1, HIGH: 3, MEDIUM: 4, LOW: 2 },
	},
	tasks: {
		total: 15,
		done: 12,
		failed: 2,
		pending: 1,
		skipped: 0,
	},
	verification: {
		passed: 10,
		failed: 2,
		overall_pass: false,
	},
	timeline: {
		started: "2026-01-01T00:00:00Z",
		finished: "2026-01-01T01:30:00Z",
		durationMs: 5400000,
	},
};

describe("formatReportMarkdown", () => {
	it("includes run ID", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("run-20260101-test");
	});

	it("includes scope", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("fix bugs");
	});

	it("includes issue counts", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("Confirmed | 5");
		expect(md).toContain("False Positive | 2");
	});

	it("includes task counts", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("Done | 12");
		expect(md).toContain("Failed | 2");
	});

	it("includes severity breakdown", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("CRITICAL | 1");
		expect(md).toContain("HIGH | 3");
	});

	it("shows FAILED for non-passing verification", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("FAILED");
	});

	it("shows PASSED when overall_pass is true", () => {
		const passing = { ...mockReport, verification: { ...mockReport.verification, overall_pass: true } };
		const md = formatReportMarkdown(passing);
		expect(md).toContain("PASSED");
	});

	it("includes duration", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("1h 30m");
	});
});

describe("formatReportTerminal", () => {
	it("includes run ID", () => {
		const out = formatReportTerminal(mockReport);
		expect(out).toContain("run-20260101-test");
	});

	it("includes issue summary", () => {
		const out = formatReportTerminal(mockReport);
		expect(out).toContain("10 found");
		expect(out).toContain("5 confirmed");
	});

	it("includes task summary", () => {
		const out = formatReportTerminal(mockReport);
		expect(out).toContain("15 total");
		expect(out).toContain("12 done");
	});

	it("shows FAIL for non-passing", () => {
		const out = formatReportTerminal(mockReport);
		expect(out).toContain("FAIL");
	});
});
