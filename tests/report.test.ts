/**
 * Tests for report generation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type RunReport,
	formatReportMarkdown,
	formatReportTerminal,
	generateReport,
} from "../src/report.ts";
import { RunStore } from "../src/state.ts";

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
	cost: {
		total: { inputTokens: 3_000_000, outputTokens: 300_000, totalCost: 13.50, byPhase: { scan: { inputTokens: 1_000_000, outputTokens: 100_000, cost: 4.50 }, exec: { inputTokens: 2_000_000, outputTokens: 200_000, cost: 9.00 } } },
		byPhase: { scan: { inputTokens: 1_000_000, outputTokens: 100_000, cost: 4.50 }, exec: { inputTokens: 2_000_000, outputTokens: 200_000, cost: 9.00 } },
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

	it("includes Cost section header", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("## Cost");
	});

	it("includes per-phase cost table", () => {
		const md = formatReportMarkdown(mockReport);
		expect(md).toContain("| scan |");
		expect(md).toContain("| exec |");
		expect(md).toContain("$4.50");
		expect(md).toContain("$9.00");
	});
});

describe("generateReport", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-report-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("includes verification data from store", () => {
		const store = RunStore.create(tmpDir);
		store.saveVerification({
			overall_pass: true,
			tasks: [
				{ overall_pass: true },
				{ overall_pass: true },
				{ overall_pass: false },
			],
		});

		const report = generateReport(store);
		expect(report.verification.overall_pass).toBe(true);
		expect(report.verification.passed).toBe(2);
		expect(report.verification.failed).toBe(1);
	});

	it("handles missing verification data", () => {
		const store = RunStore.create(tmpDir);

		const report = generateReport(store);
		expect(report.verification.overall_pass).toBe(false);
		expect(report.verification.passed).toBe(0);
		expect(report.verification.failed).toBe(0);
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

	it("includes cost summary line", () => {
		const out = formatReportTerminal(mockReport);
		expect(out).toContain("Cost:");
		expect(out).toContain("$13.50");
	});
});
