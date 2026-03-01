import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PhaseRunResult } from "../runner/types.ts";

// Track which phases runPhase is called with
const runPhaseCalls: string[] = [];
let runPhaseResults: Map<string, Partial<PhaseRunResult>>;

const runPhaseMock = mock(async (phaseConfig: { name: string }) => {
	runPhaseCalls.push(phaseConfig.name);
	const override = runPhaseResults.get(phaseConfig.name) ?? {};
	return {
		phase: phaseConfig.name,
		runId: "test-run-001",
		success: true,
		items: [],
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cost: 0,
		duration: 100,
		data: { runId: "test-run-001" },
		...override,
	} satisfies PhaseRunResult;
});

// Mock dependencies before importing the orchestrator
mock.module("../runner/phase-runner.ts", () => ({
	runPhase: runPhaseMock,
	displayPhaseSummaryHeader: () => {},
}));

mock.module("../report/generator.ts", () => ({
	autoGenerateReport: () => {},
}));

mock.module("../ui/logger.ts", () => ({
	logInfo: () => {},
	logWarn: () => {},
	logError: () => {},
	logSuccess: () => {},
	logDebug: () => {},
	setVerbose: () => {},
	isVerbose: () => false,
	formatTask: (t: string) => t,
	formatDuration: (ms: number) => `${ms}ms`,
	formatTokens: () => "0",
}));

const { runPipeline } = await import("./orchestrator.ts");

/** Minimal resolved config for testing */
function makeConfig() {
	return {
		engine: "test",
		model: "test-model",
		phases: {},
		workers: 1,
		cost: { inputPerMillion: 0, outputPerMillion: 0, budgetLimit: 100 },
		report: { enabled: false, format: "json" as const, autoGenerate: false },
		skipTests: false,
		skipLint: false,
		autoCommit: false,
		createPr: false,
		isolate: false,
		skipMerge: false,
		verbose: false,
		dryRun: false,
		failFast: false,
		maxRetries: 0,
		baseBranch: "main",
		draftPr: false,
		maxValidationRetries: 0,
		retryUnvalidated: false,
		tmux: false,
		tmuxAutoAttach: false,
		autoInstall: false,
		unsafeDoDChecks: false,
		execByIssue: true,
	};
}

describe("orchestrator nextPhase early-exit", () => {
	beforeEach(() => {
		runPhaseCalls.length = 0;
		runPhaseResults = new Map();
		runPhaseMock.mockClear();
	});

	test("pipeline stops when a phase signals 'completed'", async () => {
		runPhaseResults.set("validate", { nextPhase: "completed" });

		const result = await runPipeline({
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
			pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
		});

		// scan and validate should have run
		expect(runPhaseCalls).toContain("scan");
		expect(runPhaseCalls).toContain("validate");

		// plan, consolidate, exec, verify should NOT have run
		expect(runPhaseCalls).not.toContain("plan");
		expect(runPhaseCalls).not.toContain("consolidate");
		expect(runPhaseCalls).not.toContain("exec");
		expect(runPhaseCalls).not.toContain("verify");

		// Pipeline result should still be successful
		expect(result.success).toBe(true);
	});

	test("pipeline stops when a phase signals 'failed'", async () => {
		runPhaseResults.set("plan", { nextPhase: "failed", success: false });

		const result = await runPipeline({
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
			pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
		});

		// scan, validate, and plan should have run
		expect(runPhaseCalls).toContain("scan");
		expect(runPhaseCalls).toContain("validate");
		expect(runPhaseCalls).toContain("plan");

		// consolidate, exec, verify should NOT have run
		expect(runPhaseCalls).not.toContain("consolidate");
		expect(runPhaseCalls).not.toContain("exec");
		expect(runPhaseCalls).not.toContain("verify");

		// Pipeline should report failure since plan was not successful
		expect(result.success).toBe(false);
	});

	test("pipeline continues when nextPhase is a normal phase", async () => {
		runPhaseResults.set("validate", { nextPhase: "plan" });

		const result = await runPipeline({
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
			pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
		});

		// All phases should have run
		expect(runPhaseCalls).toContain("scan");
		expect(runPhaseCalls).toContain("validate");
		expect(runPhaseCalls).toContain("plan");
		expect(runPhaseCalls).toContain("consolidate");
		expect(runPhaseCalls).toContain("exec");
		expect(runPhaseCalls).toContain("verify");
		expect(runPhaseCalls).toHaveLength(6);

		expect(result.success).toBe(true);
	});

	test("pipeline continues when nextPhase is undefined", async () => {
		// No nextPhase set for any phase — all results have nextPhase: undefined by default

		const result = await runPipeline({
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
			pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
		});

		// All phases should have run
		expect(runPhaseCalls).toContain("scan");
		expect(runPhaseCalls).toContain("validate");
		expect(runPhaseCalls).toContain("plan");
		expect(runPhaseCalls).toContain("consolidate");
		expect(runPhaseCalls).toContain("exec");
		expect(runPhaseCalls).toContain("verify");
		expect(runPhaseCalls).toHaveLength(6);

		expect(result.success).toBe(true);
	});
});
