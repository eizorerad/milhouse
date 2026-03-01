/**
 * Tests for JSON report generation — verification data integration
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILES } from "../state/types.ts";
import { generateJsonReport } from "./json-report.ts";

const TEST_DIR = `.test-json-report-${Date.now()}`;
const MILHOUSE_DIR = join(TEST_DIR, ".milhouse");
const RUNS_DIR = join(MILHOUSE_DIR, "runs");
const RUN_ID = "test-json-report-run-1";
const RUN_DIR = join(RUNS_DIR, RUN_ID);
const STATE_DIR = join(RUN_DIR, "state");

/** Minimal RunCost for testing */
const mockCost = {
	inputTokens: 1000,
	outputTokens: 500,
	totalTokens: 1500,
	inputCost: 0.01,
	outputCost: 0.005,
	totalCost: 0.015,
	reservedCost: 0,
	byPhase: {
		scan: { inputTokens: 500, outputTokens: 250, cost: 0.0075 },
	},
};

function setupRunState() {
	mkdirSync(STATE_DIR, { recursive: true });

	// Write meta.json
	writeFileSync(
		join(RUN_DIR, "meta.json"),
		JSON.stringify({
			id: RUN_ID,
			created_at: "2024-01-15T10:00:00Z",
			updated_at: "2024-01-15T10:30:00Z",
			phase: "completed",
			issues_found: 1,
			issues_validated: 1,
			tasks_total: 2,
			tasks_completed: 2,
			tasks_failed: 0,
		}),
	);

	// Write issues.json
	writeFileSync(
		join(STATE_DIR, "issues.json"),
		JSON.stringify([
			{
				id: "ISS-1",
				symptom: "Test issue",
				hypothesis: "Test hypothesis",
				evidence: [],
				status: "CONFIRMED",
				severity: "MEDIUM",
				related_task_ids: ["T1"],
				created_at: "2024-01-15T10:00:00Z",
				updated_at: "2024-01-15T10:00:00Z",
			},
		]),
	);

	// Write tasks.json
	writeFileSync(
		join(STATE_DIR, "tasks.json"),
		JSON.stringify([
			{
				id: "T1",
				title: "Fix bug",
				status: "done",
				files: [],
				depends_on: [],
				checks: [],
				acceptance: [],
				parallel_group: 0,
				created_at: "2024-01-15T10:00:00Z",
				updated_at: "2024-01-15T10:00:00Z",
			},
		]),
	);

	// Write runs-index.json so getCurrentRunId works
	writeFileSync(
		join(MILHOUSE_DIR, "runs-index.json"),
		JSON.stringify({ runs: [{ id: RUN_ID, created_at: "2024-01-15T10:00:00Z", phase: "completed" }] }),
	);
}

describe("json-report verification integration", () => {
	beforeEach(() => {
		setupRunState();
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should include verification data when verification.json exists", () => {
		const verificationData = {
			run_id: RUN_ID,
			created_at: "2024-01-15T10:30:00Z",
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
					summary: "All checks passed",
				},
			],
			recommendations: [],
		};

		writeFileSync(
			join(STATE_DIR, STATE_FILES.verification),
			JSON.stringify(verificationData),
		);

		const report = generateJsonReport(RUN_ID, mockCost, 30000, TEST_DIR);

		expect(report.verification).toBeDefined();
		expect(report.verification!.overall_pass).toBe(true);
		expect(report.verification!.tasks_verified).toBe(1);
		expect(report.verification!.tasks_passed).toBe(1);
		expect(report.verification!.tasks_failed).toBe(0);
		expect(report.verification!.regressions_found).toBe(false);
		expect(report.verification!.tasks).toHaveLength(1);
		expect(report.verification!.tasks[0].task_id).toBe("T1");
	});

	it("should return undefined verification when verification.json is missing", () => {
		const report = generateJsonReport(RUN_ID, mockCost, 30000, TEST_DIR);

		expect(report.verification).toBeUndefined();
	});

	it("should return undefined verification when verification.json is corrupted", () => {
		writeFileSync(
			join(STATE_DIR, STATE_FILES.verification),
			"{ not valid json !!!",
		);

		const report = generateJsonReport(RUN_ID, mockCost, 30000, TEST_DIR);

		expect(report.verification).toBeUndefined();
	});

	it("should still produce valid report fields alongside verification", () => {
		const verificationData = {
			run_id: RUN_ID,
			created_at: "2024-01-15T10:30:00Z",
			overall_pass: false,
			tasks_verified: 1,
			tasks_passed: 0,
			tasks_failed: 1,
			regressions_found: true,
			tasks: [
				{
					task_id: "T1",
					overall_pass: false,
					gates: [{ gate: "dod", passed: false, message: "DoD not met" }],
					recommendations: ["Add tests"],
					regressions_found: true,
					summary: "Failed DoD",
				},
			],
			recommendations: ["Add tests"],
		};

		writeFileSync(
			join(STATE_DIR, STATE_FILES.verification),
			JSON.stringify(verificationData),
		);

		const report = generateJsonReport(RUN_ID, mockCost, 30000, TEST_DIR);

		// Verify standard fields still work
		expect(report.run_id).toBe(RUN_ID);
		expect(report.results.items_found).toBe(1);
		expect(report.results.tasks_completed).toBe(1);

		// Verify verification data
		expect(report.verification!.overall_pass).toBe(false);
		expect(report.verification!.regressions_found).toBe(true);
		expect(report.verification!.recommendations).toContain("Add tests");
	});
});
