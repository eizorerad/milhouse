/**
 * Unit tests for verify.ts
 *
 * Tests the verification gates and helper functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildVerifierPrompt,
	GATES,
	runAllGates,
	runDiffHygieneGate,
	runDoDGate,
	runEnvConsistencyGate,
	runEvidenceGate,
	runPlaceholderGate,
	type VerificationIssue,
} from "./verify.ts";
import type { Task } from "../../state/types.ts";

describe("verify.ts gate functions", () => {
	const testWorkDir = join(process.cwd(), ".test-workdir-verify");

	beforeEach(() => {
		if (!existsSync(testWorkDir)) {
			mkdirSync(testWorkDir, { recursive: true });
		}
		const milhouseDir = join(testWorkDir, ".milhouse");
		mkdirSync(join(milhouseDir, "state"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testWorkDir)) {
			rmSync(testWorkDir, { recursive: true, force: true });
		}
	});

	describe("GATES constant", () => {
		test("should define all required gates", () => {
			expect(GATES).toHaveProperty("evidence");
			expect(GATES).toHaveProperty("diffHygiene");
			expect(GATES).toHaveProperty("placeholder");
			expect(GATES).toHaveProperty("envConsistency");
			expect(GATES).toHaveProperty("dod");
		});

		test("should have descriptive gate names", () => {
			expect(GATES.evidence).toContain("Evidence");
			expect(GATES.diffHygiene).toContain("Diff");
			expect(GATES.placeholder).toContain("Placeholder");
			expect(GATES.envConsistency).toContain("Environment");
			expect(GATES.dod).toContain("Definition of Done");
		});
	});

	describe("runPlaceholderGate", () => {
		test("should pass when no state directory exists", () => {
			const emptyDir = join(testWorkDir, "empty-project");
			mkdirSync(emptyDir, { recursive: true });

			const result = runPlaceholderGate(emptyDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("placeholder");
			expect(result.message).toBe("No state directory found");
		});

		test("should pass when tasks have no code files", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(
				tasksPath,
				JSON.stringify([
					{
						id: "task-1",
						title: "Test task",
						files: ["README.md"],
						status: "done",
						acceptance: [],
						depends_on: [],
						checks: [],
						parallel_group: 0,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				]),
			);

			const result = runPlaceholderGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("placeholder");
		});

		test("should have timestamp in result", () => {
			const result = runPlaceholderGate(testWorkDir);

			expect(result.timestamp).toBeDefined();
			expect(() => new Date(result.timestamp)).not.toThrow();
		});
	});

	describe("runDiffHygieneGate", () => {
		test("should pass when no silent refactors detected", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(
				tasksPath,
				JSON.stringify([
					{
						id: "task-1",
						title: "Test task",
						files: ["src/index.ts"],
						status: "done",
						acceptance: [],
						depends_on: [],
						checks: [],
						parallel_group: 0,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				]),
			);

			const executionsPath = join(testWorkDir, ".milhouse", "state", "executions.json");
			writeFileSync(executionsPath, JSON.stringify([]));

			const result = runDiffHygieneGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("diffHygiene");
		});

		test("should return gate type as diffHygiene", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(tasksPath, JSON.stringify([]));

			const executionsPath = join(testWorkDir, ".milhouse", "state", "executions.json");
			writeFileSync(executionsPath, JSON.stringify([]));

			const result = runDiffHygieneGate(testWorkDir);

			expect(result.gate).toBe("diffHygiene");
		});
	});

	describe("runEvidenceGate", () => {
		test("should pass when all acceptance criteria are verified", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(
				tasksPath,
				JSON.stringify([
					{
						id: "task-1",
						title: "Test task",
						files: [],
						status: "done",
						acceptance: [
							{
								description: "Test criterion",
								verified: true,
							},
						],
						depends_on: [],
						checks: [],
						parallel_group: 0,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				]),
			);

			const result = runEvidenceGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("evidence");
		});

		test("should fail when acceptance criteria are unverified", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(
				tasksPath,
				JSON.stringify([
					{
						id: "task-1",
						title: "Test task",
						files: [],
						status: "done",
						acceptance: [
							{
								description: "Unverified criterion",
								verified: false,
							},
						],
						depends_on: [],
						checks: [],
						parallel_group: 0,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				]),
			);

			const result = runEvidenceGate(testWorkDir);

			expect(result.passed).toBe(false);
			expect(result.message).toContain("unverified");
		});
	});

	describe("runEnvConsistencyGate", () => {
		test("should pass when no probes directory exists", () => {
			const result = runEnvConsistencyGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("envConsistency");
			expect(result.message).toBe("No probes directory found");
		});

		test("should report probe types when probes directory exists", () => {
			const probesDir = join(testWorkDir, ".milhouse", "probes");
			mkdirSync(join(probesDir, "deps"), { recursive: true });
			mkdirSync(join(probesDir, "compose"), { recursive: true });

			const result = runEnvConsistencyGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.message).toContain("probe type");
		});
	});

	describe("runDoDGate", () => {
		test("should pass when no acceptance criteria defined", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(
				tasksPath,
				JSON.stringify([
					{
						id: "task-1",
						title: "Test task",
						files: [],
						status: "done",
						acceptance: [],
						depends_on: [],
						checks: [],
						parallel_group: 0,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				]),
			);

			const result = runDoDGate(testWorkDir);

			expect(result.passed).toBe(true);
			expect(result.gate).toBe("dod");
		});

		test("should return gate type as dod", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(tasksPath, JSON.stringify([]));

			const result = runDoDGate(testWorkDir);

			expect(result.gate).toBe("dod");
		});
	});

	describe("runAllGates", () => {
		test("should run all five gates", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(tasksPath, JSON.stringify([]));

			const executionsPath = join(testWorkDir, ".milhouse", "state", "executions.json");
			writeFileSync(executionsPath, JSON.stringify([]));

			const results = runAllGates(testWorkDir);

			expect(results.length).toBe(5);
		});

		test("should include all gate types", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(tasksPath, JSON.stringify([]));

			const executionsPath = join(testWorkDir, ".milhouse", "state", "executions.json");
			writeFileSync(executionsPath, JSON.stringify([]));

			const results = runAllGates(testWorkDir);
			const gateTypes = results.map((r) => r.gate);

			expect(gateTypes).toContain("placeholder");
			expect(gateTypes).toContain("diffHygiene");
			expect(gateTypes).toContain("dod");
			expect(gateTypes).toContain("evidence");
			expect(gateTypes).toContain("envConsistency");
		});

		test("should run DoD gate before Evidence gate", () => {
			const tasksPath = join(testWorkDir, ".milhouse", "state", "tasks.json");
			writeFileSync(tasksPath, JSON.stringify([]));

			const executionsPath = join(testWorkDir, ".milhouse", "state", "executions.json");
			writeFileSync(executionsPath, JSON.stringify([]));

			const results = runAllGates(testWorkDir);
			const dodIndex = results.findIndex((r) => r.gate === "dod");
			const evidenceIndex = results.findIndex((r) => r.gate === "evidence");

			expect(dodIndex).toBeLessThan(evidenceIndex);
		});
	});

	describe("buildVerifierPrompt", () => {
		test("should include role information", () => {
			const tasks: Task[] = [];
			const issues: VerificationIssue[] = [];

			const prompt = buildVerifierPrompt(tasks, issues, testWorkDir);

			expect(prompt).toContain("Truth Verifier");
			expect(prompt).toContain("TV");
		});

		test("should include execution summary", () => {
			const tasks: Task[] = [
				{
					id: "task-1",
					title: "Test task",
					files: [],
					status: "done",
					acceptance: [],
					depends_on: [],
					checks: [],
					parallel_group: 0,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			];
			const issues: VerificationIssue[] = [];

			const prompt = buildVerifierPrompt(tasks, issues, testWorkDir);

			expect(prompt).toContain("Execution Summary");
			expect(prompt).toContain("Completed Tasks");
		});

		test("should include issues when present", () => {
			const tasks: Task[] = [];
			const issues: VerificationIssue[] = [
				{
					gate: "placeholder",
					severity: "ERROR",
					message: "Test issue",
				},
			];

			const prompt = buildVerifierPrompt(tasks, issues, testWorkDir);

			expect(prompt).toContain("Pre-check Issues Found");
			expect(prompt).toContain("Test issue");
		});

		test("should include output format instructions", () => {
			const tasks: Task[] = [];
			const issues: VerificationIssue[] = [];

			const prompt = buildVerifierPrompt(tasks, issues, testWorkDir);

			expect(prompt).toContain("Output Format");
			expect(prompt).toContain("overall_pass");
			expect(prompt).toContain("json");
		});
	});
});
