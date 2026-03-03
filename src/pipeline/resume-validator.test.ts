import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PHASE_ORDER,
	PHASE_OUTPUT_REQUIREMENTS,
	validateResumeOutputs,
} from "./resume-validator.ts";

describe("resume-validator", () => {
	const testDir = join(process.cwd(), ".test-resume-validator");
	const runId = "test-run-001";

	function stateDir(): string {
		return join(testDir, ".milhouse", "runs", runId, "state");
	}

	function writeStateFile(name: string, data: unknown): void {
		const dir = stateDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
	}

	function makeIssue(overrides: Record<string, unknown> = {}) {
		return {
			id: "P-test-abc",
			symptom: "test symptom",
			hypothesis: "test hypothesis",
			evidence: [],
			status: "CONFIRMED",
			severity: "MEDIUM",
			related_task_ids: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			...overrides,
		};
	}

	function makeTask(overrides: Record<string, unknown> = {}) {
		return {
			id: "P-test-abc-T1",
			issue_id: "P-test-abc",
			title: "Fix the bug",
			files: [],
			depends_on: [],
			checks: [],
			acceptance: [],
			parallel_group: 0,
			status: "pending",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			...overrides,
		};
	}

	function makeGraphNode(overrides: Record<string, unknown> = {}) {
		return {
			id: "P-test-abc-T1",
			depends_on: [],
			parallel_group: 0,
			...overrides,
		};
	}

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir(), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// ==========================================================================
	// Happy path tests
	// ==========================================================================

	describe("happy paths", () => {
		test("resume from scan — always valid, no prior phases to validate", () => {
			const result = validateResumeOutputs(runId, "scan", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.firstInvalidPhase).toBeUndefined();
		});

		test("valid when outputs exist — resume from validate with valid issues.json", () => {
			writeStateFile("issues.json", [makeIssue()]);

			const result = validateResumeOutputs(runId, "validate", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		test("valid when outputs exist — resume from plan with validated issues", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);

			const result = validateResumeOutputs(runId, "plan", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		test("valid when outputs exist — resume from consolidate with tasks", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);

			const result = validateResumeOutputs(runId, "consolidate", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		test("valid when outputs exist — resume from exec with tasks and graph", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);
			writeStateFile("graph.json", [makeGraphNode()]);

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		test("valid when outputs exist — resume from verify with completed tasks", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask({ status: "done" })]);
			writeStateFile("graph.json", [makeGraphNode()]);

			const result = validateResumeOutputs(runId, "verify", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Missing file tests
	// ==========================================================================

	describe("missing files", () => {
		test("missing issues — resume from validate with no issues.json falls back to scan", () => {
			const result = validateResumeOutputs(runId, "validate", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("scan");
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("issues.json");
		});

		test("missing issues — resume from plan with no issues.json falls back to scan", () => {
			const result = validateResumeOutputs(runId, "plan", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("scan");
		});

		test("missing tasks — resume from consolidate with no tasks.json falls back to plan", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);

			const result = validateResumeOutputs(runId, "consolidate", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("plan");
			expect(result.errors.some((e) => e.includes("tasks.json"))).toBe(true);
		});

		test("missing graph — resume from exec with no graph.json falls back to consolidate", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("consolidate");
			expect(result.errors.some((e) => e.includes("graph.json"))).toBe(true);
		});
	});

	// ==========================================================================
	// Empty / corrupted file tests
	// ==========================================================================

	describe("empty or corrupted files", () => {
		test("empty tasks — resume from consolidate with empty tasks.json falls back to plan", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", []);

			const result = validateResumeOutputs(runId, "consolidate", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("plan");
		});

		test("empty issues — resume from validate with empty issues.json falls back to scan", () => {
			writeStateFile("issues.json", []);

			const result = validateResumeOutputs(runId, "validate", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("scan");
		});

		test("only UNVALIDATED issues — resume from plan falls back to validate", () => {
			writeStateFile("issues.json", [makeIssue({ status: "UNVALIDATED" })]);

			const result = validateResumeOutputs(runId, "plan", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("validate");
			expect(result.errors.some((e) => e.includes("UNVALIDATED"))).toBe(true);
		});

		test("empty graph — resume from exec with empty graph.json falls back to consolidate", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);
			writeStateFile("graph.json", []);

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("consolidate");
		});

		test("corrupted JSON — resume from validate with invalid JSON falls back to scan", () => {
			const dir = stateDir();
			writeFileSync(join(dir, "issues.json"), "not valid json{{{");

			const result = validateResumeOutputs(runId, "validate", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("scan");
		});

		test("no completed tasks — resume from verify falls back to exec", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask({ status: "pending" })]);
			writeStateFile("graph.json", [makeGraphNode()]);

			const result = validateResumeOutputs(runId, "verify", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("exec");
			expect(result.errors.some((e) => e.includes("no completed tasks"))).toBe(true);
		});
	});

	// ==========================================================================
	// Partial state tests
	// ==========================================================================

	describe("partial state", () => {
		test("issues exist but tasks missing when resuming from exec — falls back to plan", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			// No tasks.json, no graph.json

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			// plan is the earliest phase with missing output
			expect(result.firstInvalidPhase).toBe("plan");
		});

		test("all prior outputs except graph exist — falls back to consolidate", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);
			// No graph.json

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("consolidate");
		});

		test("multiple errors are accumulated", () => {
			// Resume from verify with nothing — should get errors for scan, validate, plan, consolidate, exec
			const result = validateResumeOutputs(runId, "verify", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("scan");
			expect(result.errors.length).toBeGreaterThan(1);
		});
	});

	// ==========================================================================
	// Edge cases
	// ==========================================================================

	describe("edge cases", () => {
		test("unknown phase — treated like first phase, always valid", () => {
			const result = validateResumeOutputs(runId, "unknown-phase", testDir);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		test("fallback — validates correctly when only some phases are missing", () => {
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			writeStateFile("tasks.json", [makeTask()]);
			writeStateFile("graph.json", [makeGraphNode()]);
			// exec phase check: tasks should have at least one "done" status
			// but all tasks are "pending" — should fail at exec

			const result = validateResumeOutputs(runId, "verify", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("exec");
		});

		test("fallback — firstInvalidPhase can be used as new startPhase", () => {
			// Simulates the orchestrator integration: when validation fails,
			// the orchestrator sets startPhase = firstInvalidPhase
			writeStateFile("issues.json", [makeIssue({ status: "CONFIRMED" })]);
			// Missing tasks.json -> plan is invalid

			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			expect(result.firstInvalidPhase).toBe("plan");

			// Re-validating from the fallback phase should pass
			// (because plan has no prior phases that need tasks)
			expect(result.firstInvalidPhase).toBeDefined();
			const recheck = validateResumeOutputs(runId, result.firstInvalidPhase as string, testDir);
			expect(recheck.valid).toBe(true);
		});

		test("errors contain descriptive messages for diagnostics", () => {
			const result = validateResumeOutputs(runId, "exec", testDir);
			expect(result.valid).toBe(false);
			// Should have multiple descriptive errors
			for (const err of result.errors) {
				expect(typeof err).toBe("string");
				expect(err.length).toBeGreaterThan(10);
			}
		});
	});

	// ==========================================================================
	// Phase output requirements completeness
	// ==========================================================================

	describe("phase output requirements completeness", () => {
		test("every phase in PHASE_ORDER has a corresponding PHASE_OUTPUT_REQUIREMENTS entry", () => {
			for (const phase of PHASE_ORDER) {
				expect(PHASE_OUTPUT_REQUIREMENTS).toHaveProperty(phase);
				expect(Array.isArray(PHASE_OUTPUT_REQUIREMENTS[phase])).toBe(true);
				expect(PHASE_OUTPUT_REQUIREMENTS[phase].length).toBeGreaterThan(0);
			}
		});
	});

	// ==========================================================================
	// Verify phase check (direct invocation)
	// ==========================================================================

	describe("verify phase check", () => {
		test("passes with valid verification.json containing overall_pass", () => {
			writeStateFile("verification.json", {
				run_id: runId,
				overall_pass: true,
				tasks_verified: 1,
				tasks_passed: 1,
				tasks_failed: 0,
			});

			const checks = PHASE_OUTPUT_REQUIREMENTS["verify"];
			for (const check of checks) {
				expect(check(runId, testDir)).toBeNull();
			}
		});

		test("fails when verification.json is missing", () => {
			const checks = PHASE_OUTPUT_REQUIREMENTS["verify"];
			const errors = checks.map((check) => check(runId, testDir)).filter(Boolean);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain("verification.json is missing");
		});

		test("fails when verification.json contains invalid JSON", () => {
			const dir = stateDir();
			writeFileSync(join(dir, "verification.json"), "not valid json{{{");

			const checks = PHASE_OUTPUT_REQUIREMENTS["verify"];
			const errors = checks.map((check) => check(runId, testDir)).filter(Boolean);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain("invalid JSON");
		});

		test("fails when verification.json is missing overall_pass boolean", () => {
			writeStateFile("verification.json", {
				run_id: runId,
				tasks_verified: 1,
			});

			const checks = PHASE_OUTPUT_REQUIREMENTS["verify"];
			const errors = checks.map((check) => check(runId, testDir)).filter(Boolean);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain("overall_pass");
		});

		test("passes with overall_pass: false (valid but failing verification)", () => {
			writeStateFile("verification.json", {
				run_id: runId,
				overall_pass: false,
				tasks_verified: 1,
				tasks_passed: 0,
				tasks_failed: 1,
			});

			const checks = PHASE_OUTPUT_REQUIREMENTS["verify"];
			for (const check of checks) {
				expect(check(runId, testDir)).toBeNull();
			}
		});
	});
});
