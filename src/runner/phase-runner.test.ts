/**
 * Tests for phase-runner empty-items early-return path.
 *
 * Verifies that when a per-item phase has zero items from loadItems:
 * 1. PhaseRunResult.success is false
 * 2. saveResults is called with an empty array
 * 3. afterRun hook is called with an empty array
 * 4. runCost.byPhase[phaseName] is set (with zero tokens/cost)
 * 5. nextPhase is still computed and returned correctly
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunCost } from "./cost.ts";
import type { PhaseConfig, PhaseContext, PhaseItemResult } from "./types.ts";

// --- Mocks ---

const mockEngine = {
	execute: mock(async () => ({ success: true, response: "{}", inputTokens: 0, outputTokens: 0 })),
};

const mockCreateEngine = mock(async () => mockEngine);

mock.module("../engines/index.ts", () => ({
	createEngine: mockCreateEngine,
}));

mock.module("../state/runs.ts", () => ({
	createRun: mock(async () => ({ id: "test-run-001" })),
	loadRunsIndex: mock(() => ({ runs: [{ id: "test-run-001" }] })),
	updateRunPhaseInMetaWithLock: mock(async () => {}),
}));

mock.module("../state/run-lock.ts", () => ({
	acquireRunLock: mock(() => ({ release: () => {} })),
}));

mock.module("../config/loader.ts", () => ({
	loadUserConfig: mock(async () => ({})),
}));

mock.module("../config/define.ts", () => ({
	resolveConfig: mock((c: unknown) => c),
}));

mock.module("../ui/logger.ts", () => ({
	logInfo: () => {},
	logWarn: () => {},
	logError: () => {},
	logSuccess: () => {},
	logDebug: () => {},
	setVerbose: () => {},
	isVerbose: () => false,
	formatDuration: (ms: number) => `${ms}ms`,
	formatTask: (t: string) => t,
	formatTokens: () => "0",
}));

mock.module("../ui/spinners.ts", () => ({
	DynamicAgentSpinner: class {},
	ProgressSpinner: class {},
}));

mock.module("../ui/theme.ts", () => ({
	phaseIcons: {},
	theme: { phase: {} },
}));

const { runPhase } = await import("./phase-runner.ts");
const { createRunCost } = await import("./cost.ts");

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

describe("phase-runner empty-items early-return", () => {
	let saveResultsSpy: ReturnType<typeof mock>;
	let afterRunSpy: ReturnType<typeof mock>;
	let nextPhaseSpy: ReturnType<typeof mock>;
	let phaseConfig: PhaseConfig;

	beforeEach(() => {
		saveResultsSpy = mock(() => {});
		afterRunSpy = mock(() => {});
		nextPhaseSpy = mock(() => "completed" as const);

		phaseConfig = {
			name: "verify",
			role: "TV",
			mode: "per-item",
			defaultParallel: 1,
			loadItems: () => [],
			buildPrompt: () => "",
			parseResponse: () => ({}),
			saveResults: saveResultsSpy,
			afterRun: afterRunSpy,
			nextPhase: nextPhaseSpy,
		} as unknown as PhaseConfig;
	});

	test("success must be false when zero items are returned from loadItems", async () => {
		const result = await runPhase(phaseConfig, {
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
		});

		expect(result.success).toBe(false);
	});

	test("saveResults must be called with an empty array", async () => {
		await runPhase(phaseConfig, {
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
		});

		expect(saveResultsSpy).toHaveBeenCalledTimes(1);
		const callArgs = saveResultsSpy.mock.calls[0];
		expect(callArgs[0]).toEqual([]);
	});

	test("afterRun hook must be called with an empty array", async () => {
		await runPhase(phaseConfig, {
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
		});

		expect(afterRunSpy).toHaveBeenCalledTimes(1);
		const callArgs = afterRunSpy.mock.calls[0];
		expect(callArgs[0]).toEqual([]);
	});

	test("runCost.byPhase[phaseName] must be set with zero tokens/cost", async () => {
		const runCost: RunCost = createRunCost();

		await runPhase(phaseConfig, {
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
			runCost,
		});

		expect(runCost.byPhase.verify).toBeDefined();
		expect(runCost.byPhase.verify.inputTokens).toBe(0);
		expect(runCost.byPhase.verify.outputTokens).toBe(0);
		expect(runCost.byPhase.verify.cost).toBe(0);
	});

	test("nextPhase is still computed and returned correctly", async () => {
		const result = await runPhase(phaseConfig, {
			workDir: "/tmp/test",
			config: makeConfig(),
			runId: "test-run-001",
		});

		expect(nextPhaseSpy).toHaveBeenCalledTimes(1);
		expect(result.nextPhase).toBe("completed");
	});
});
