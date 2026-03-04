/**
 * Tests for session-report: verifies that cost data is correctly propagated
 * through writeSessionReport to generateReport.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunCost } from "../runner/cost.ts";
import { createRunCost } from "../runner/cost.ts";
import type { RunMeta } from "../state/types.ts";

// Mock generateReport so we can inspect what cost is passed
const mockGenerateReport = mock(() => ({ jsonPath: "/fake.json", markdownPath: "/fake.md" }));
mock.module("../report/generator.ts", () => ({
	generateReport: mockGenerateReport,
}));

// Import after mocking
const { writeSessionReport } = await import("./session-report.ts");

function makeRunMeta(overrides?: Partial<RunMeta>): RunMeta {
	return {
		id: "test-session-001",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		phase: "completed" as const,
		issues_found: 0,
		issues_validated: 0,
		tasks_total: 0,
		tasks_completed: 0,
		tasks_failed: 0,
		...overrides,
	};
}

describe("writeSessionReport", () => {
	beforeEach(() => {
		mockGenerateReport.mockClear();
	});

	test("passes provided cost to generateReport", () => {
		const cost = createRunCost();
		cost.totalCost = 12.34;

		writeSessionReport(makeRunMeta(), "/tmp/work", cost);

		expect(mockGenerateReport).toHaveBeenCalledTimes(1);
		const callArgs = mockGenerateReport.mock.calls[0][0] as { cost: RunCost };
		expect(callArgs.cost.totalCost).toBe(12.34);
	});

	test("does not replace provided cost with a zero-cost object", () => {
		const cost = createRunCost();
		cost.totalCost = 5.67;

		writeSessionReport(makeRunMeta(), "/tmp/work", cost);

		expect(mockGenerateReport).toHaveBeenCalledTimes(1);
		const callArgs = mockGenerateReport.mock.calls[0][0] as { cost: RunCost };
		expect(callArgs.cost.totalCost).toBe(5.67);
		expect(callArgs.cost).toBe(cost);
	});

	test("passes zero cost when session has no cost", () => {
		const cost = createRunCost();
		// totalCost is already 0 from createRunCost()

		writeSessionReport(makeRunMeta(), "/tmp/work", cost);

		expect(mockGenerateReport).toHaveBeenCalledTimes(1);
		const callArgs = mockGenerateReport.mock.calls[0][0] as { cost: RunCost };
		expect(callArgs.cost.totalCost).toBe(0);
	});
});
