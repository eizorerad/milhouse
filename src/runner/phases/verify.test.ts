/**
 * Tests for verify phase saveResults — verification.json persistence
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILES } from "../../state/types.ts";
import type { PhaseContext, PhaseItemResult } from "../types.ts";
import { verifyPhaseConfig } from "./verify.ts";

const TEST_DIR = `.test-verify-phase-${Date.now()}`;
const MILHOUSE_DIR = join(TEST_DIR, ".milhouse");
const RUNS_DIR = join(MILHOUSE_DIR, "runs");
const RUN_ID = "test-verify-run-1";
const RUN_DIR = join(RUNS_DIR, RUN_ID);
const STATE_DIR = join(RUN_DIR, "state");

/** Minimal PhaseContext for testing saveResults */
function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
	return {
		runId: RUN_ID,
		workDir: TEST_DIR,
		startTime: Date.now() - 5000,
		config: {} as PhaseContext["config"],
		engine: {} as PhaseContext["engine"],
		userConfig: {} as PhaseContext["userConfig"],
		store: {},
		...overrides,
	};
}

type VerifyResult = {
	task_id: string;
	overall_pass: boolean;
	gates: Array<{ gate: string; passed: boolean; message?: string }>;
	recommendations: string[];
	regressions_found: boolean;
	summary: string;
};

function makeResult(
	overrides: Partial<VerifyResult> & { task_id: string },
): PhaseItemResult<VerifyResult> {
	return {
		success: true,
		item: { id: overrides.task_id },
		result: {
			overall_pass: true,
			gates: [{ gate: "evidence", passed: true }],
			recommendations: [],
			regressions_found: false,
			summary: "All checks passed",
			...overrides,
		},
		inputTokens: 100,
		outputTokens: 50,
	};
}

function makeFailedResult(taskId: string): PhaseItemResult<VerifyResult> {
	return {
		success: false,
		item: { id: taskId },
		error: "Agent crashed",
		inputTokens: 10,
		outputTokens: 0,
	};
}

describe("verify phase saveResults", () => {
	beforeEach(() => {
		mkdirSync(STATE_DIR, { recursive: true });
		// Also create verification-reports dir used by saveVerificationReport
		mkdirSync(join(MILHOUSE_DIR, "verification-reports"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should write verification.json with correct schema when all tasks pass", () => {
		const results = [
			makeResult({ task_id: "T1" }),
			makeResult({ task_id: "T2" }),
		];

		verifyPhaseConfig.saveResults(results, makeCtx());

		const filePath = join(STATE_DIR, STATE_FILES.verification);
		expect(existsSync(filePath)).toBe(true);

		const data = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(data.run_id).toBe(RUN_ID);
		expect(data.overall_pass).toBe(true);
		expect(data.tasks_verified).toBe(2);
		expect(data.tasks_passed).toBe(2);
		expect(data.tasks_failed).toBe(0);
		expect(data.regressions_found).toBe(false);
		expect(data.tasks).toHaveLength(2);
		expect(data.created_at).toBeTruthy();
	});

	it("should write verification.json when all tasks fail", () => {
		const results = [
			makeResult({
				task_id: "T1",
				overall_pass: false,
				gates: [{ gate: "evidence", passed: false, message: "No evidence" }],
				summary: "Failed evidence check",
			}),
			makeResult({
				task_id: "T2",
				overall_pass: false,
				gates: [{ gate: "dod", passed: false, message: "DoD not met" }],
				summary: "Failed DoD",
			}),
		];

		verifyPhaseConfig.saveResults(results, makeCtx());

		const data = JSON.parse(readFileSync(join(STATE_DIR, STATE_FILES.verification), "utf-8"));
		expect(data.overall_pass).toBe(false);
		expect(data.tasks_passed).toBe(0);
		expect(data.tasks_failed).toBe(2);
	});

	it("should handle empty results array", () => {
		verifyPhaseConfig.saveResults([], makeCtx());

		const data = JSON.parse(readFileSync(join(STATE_DIR, STATE_FILES.verification), "utf-8"));
		expect(data.overall_pass).toBe(true);
		expect(data.tasks_verified).toBe(0);
		expect(data.tasks_passed).toBe(0);
		expect(data.tasks_failed).toBe(0);
		expect(data.tasks).toHaveLength(0);
	});

	it("should handle agent failures (success: false)", () => {
		const results = [
			makeResult({ task_id: "T1" }),
			makeFailedResult("T2"),
		];

		verifyPhaseConfig.saveResults(results, makeCtx());

		const data = JSON.parse(readFileSync(join(STATE_DIR, STATE_FILES.verification), "utf-8"));
		expect(data.overall_pass).toBe(false);
		expect(data.tasks_passed).toBe(1);
		expect(data.tasks_failed).toBe(1);

		const failedTask = data.tasks.find((t: { task_id: string }) => t.task_id === "T2");
		expect(failedTask.overall_pass).toBe(false);
		expect(failedTask.gates[0].gate).toBe("execution");
	});

	it("should detect regressions", () => {
		const results = [
			makeResult({ task_id: "T1", regressions_found: true }),
			makeResult({ task_id: "T2" }),
		];

		verifyPhaseConfig.saveResults(results, makeCtx());

		const data = JSON.parse(readFileSync(join(STATE_DIR, STATE_FILES.verification), "utf-8"));
		expect(data.regressions_found).toBe(true);
	});

	it("should aggregate and deduplicate recommendations", () => {
		const results = [
			makeResult({
				task_id: "T1",
				recommendations: ["Add tests", "Improve docs"],
			}),
			makeResult({
				task_id: "T2",
				recommendations: ["Add tests", "Fix lint"],
			}),
		];

		verifyPhaseConfig.saveResults(results, makeCtx());

		const data = JSON.parse(readFileSync(join(STATE_DIR, STATE_FILES.verification), "utf-8"));
		expect(data.recommendations).toContain("Add tests");
		expect(data.recommendations).toContain("Improve docs");
		expect(data.recommendations).toContain("Fix lint");
		// "Add tests" should be deduplicated
		expect(data.recommendations.filter((r: string) => r === "Add tests")).toHaveLength(1);
	});

	it("should also save VerificationReport via saveVerificationReport", () => {
		const results = [makeResult({ task_id: "T1" })];

		verifyPhaseConfig.saveResults(results, makeCtx());

		// Check that the full report was saved to the run directory
		const reportPath = join(RUN_DIR, "verification-report.json");
		expect(existsSync(reportPath)).toBe(true);

		const report = JSON.parse(readFileSync(reportPath, "utf-8"));
		expect(report.run_id).toBe(RUN_ID);
		expect(report.overall_success).toBe(true);
		expect(report.gates).toBeDefined();
		expect(report.tokens).toBeDefined();
	});
});
