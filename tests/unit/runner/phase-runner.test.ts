/**
 * Unit tests for phase-runner.ts
 *
 * Tests displayPhaseSummaryHeader and runPhase integration with mock phase configs.
 *
 * @module tests/unit/runner/phase-runner.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { displayPhaseSummaryHeader, runPhase } from "../../../src/runner/phase-runner.ts";
import type { PhaseConfig, PhaseContext, PhaseItemResult, ResolvedConfig } from "../../../src/runner/types.ts";
import { createMockEngine, createMockPhaseContext, createMockResolvedConfig } from "./helpers.ts";

// ============================================================================
// displayPhaseSummaryHeader
// ============================================================================

describe("displayPhaseSummaryHeader", () => {
	let consoleSpy: ReturnType<typeof spyOn>;
	let loggedLines: string[];

	beforeEach(() => {
		loggedLines = [];
		consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			loggedLines.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("displays correct succeeded/failed counts when all succeeded", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 500, outputTokens: 200 },
			{ item: {}, result: {}, success: true, inputTokens: 300, outputTokens: 100 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("scan", results, 800, 300, config, Date.now() - 1000);

		const itemsLine = loggedLines.find((l) => l.includes("Items:"));
		expect(itemsLine).toBeDefined();
		expect(itemsLine).toContain("2");
		expect(itemsLine).toContain("succeeded");
		// Should not mention failed when all succeeded
		expect(itemsLine).not.toContain("failed");
	});

	it("displays correct counts when some failed", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 500, outputTokens: 200 },
			{ item: {}, result: {}, success: false, error: "Engine error", inputTokens: 0, outputTokens: 0 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("validate", results, 500, 200, config, Date.now() - 2000);

		const itemsLine = loggedLines.find((l) => l.includes("Items:"));
		expect(itemsLine).toBeDefined();
		expect(itemsLine).toContain("1");
		expect(itemsLine).toContain("succeeded");
		expect(itemsLine).toContain("1");
		expect(itemsLine).toContain("failed");
	});

	it("handles zero results", () => {
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("plan", [], 0, 0, config, Date.now());

		const itemsLine = loggedLines.find((l) => l.includes("Items:"));
		expect(itemsLine).toBeDefined();
		expect(itemsLine).toContain("0");
	});

	it("displays token info", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 5000, outputTokens: 2000 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("scan", results, 5000, 2000, config, Date.now() - 500);

		const tokensLine = loggedLines.find((l) => l.includes("Tokens:"));
		expect(tokensLine).toBeDefined();
		expect(tokensLine).toContain("5K");
		expect(tokensLine).toContain("2K");
	});

	it("displays cost info", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 1000000, outputTokens: 100000 },
		];
		const config = createMockResolvedConfig({
			cost: { inputPerMillion: 5, outputPerMillion: 25, budgetLimit: 100 },
		});
		displayPhaseSummaryHeader("exec", results, 1000000, 100000, config, Date.now() - 1000);

		const costLine = loggedLines.find((l) => l.includes("Cost:"));
		expect(costLine).toBeDefined();
		expect(costLine).toContain("$");
	});

	it("displays duration info", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 100, outputTokens: 50 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("verify", results, 100, 50, config, Date.now() - 5000);

		const durationLine = loggedLines.find((l) => l.includes("Duration:"));
		expect(durationLine).toBeDefined();
	});

	it("displays error messages for failed items", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: false, error: "Rate limit exceeded", inputTokens: 0, outputTokens: 0 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("scan", results, 0, 0, config, Date.now());

		const errorLine = loggedLines.find((l) => l.includes("Error:"));
		expect(errorLine).toBeDefined();
		expect(errorLine).toContain("Rate limit exceeded");
	});

	it("does not display error line when no errors", () => {
		const results: PhaseItemResult[] = [
			{ item: {}, result: {}, success: true, inputTokens: 100, outputTokens: 50 },
		];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("scan", results, 100, 50, config, Date.now());

		const errorLine = loggedLines.find((l) => l.includes("Error:"));
		expect(errorLine).toBeUndefined();
	});

	it("includes phase name in output", () => {
		const results: PhaseItemResult[] = [];
		const config = createMockResolvedConfig();
		displayPhaseSummaryHeader("consolidate", results, 0, 0, config, Date.now());

		const headerLine = loggedLines.find((l) => l.includes("consolidate"));
		expect(headerLine).toBeDefined();
	});
});

// ============================================================================
// runPhase integration tests with mock phase config
// ============================================================================

describe("runPhase", () => {
	const testDir = join(process.cwd(), ".test-phase-runner");
	let consoleSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse"), { recursive: true });
		// Suppress console output during tests
		consoleSpy = spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	function createMinimalPhaseConfig(overrides: Partial<PhaseConfig<string, string>> = {}): PhaseConfig<string, string> {
		return {
			name: "scan",
			role: "LI",
			mode: "per-item",
			defaultParallel: 1,
			loadItems: () => ["test-item"],
			buildPrompt: (item) => `Process: ${item}`,
			parseResponse: (response) => response,
			saveResults: async () => {},
			...overrides,
		};
	}

	it("executes successfully with single item", async () => {
		const engine = createMockEngine({
			defaultResult: {
				success: true,
				response: "parsed-result",
				inputTokens: 500,
				outputTokens: 200,
			},
		});

		// Mock createEngine to return our mock engine
		const { mock: mockModule } = await import("bun:test");
		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		// Mock run state functions
		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-123",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		// Mock run lock
		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		// Mock config loader
		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const phaseConfig = createMinimalPhaseConfig({
			name: "scan",
			nextPhase: (results) => results.every((r) => r.success) ? "validate" : "completed",
		});

		const config = createMockResolvedConfig();
		const result = await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "test scope",
		});

		expect(result.phase).toBe("scan");
		expect(result.runId).toBe("test-run-123");
		expect(result.success).toBe(true);
		expect(result.items.length).toBe(1);
		expect(result.items[0].success).toBe(true);
		expect(result.items[0].result).toBe("parsed-result");
		expect(result.totalInputTokens).toBe(500);
		expect(result.totalOutputTokens).toBe(200);

		// Cleanup spies
		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("returns early with empty items for per-item mode", async () => {
		const engine = createMockEngine();

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const loadIndexSpy = spyOn(runsModule, "loadRunsIndex").mockReturnValue({
			runs: [{ id: "test-run-empty", created_at: new Date().toISOString(), phase: "validate" as const }],
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const saveResultsMock = mock(() => Promise.resolve());
		const phaseConfig = createMinimalPhaseConfig({
			name: "validate",
			loadItems: () => [],
			saveResults: saveResultsMock,
		});

		const config = createMockResolvedConfig();
		const result = await runPhase(phaseConfig, {
			workDir: testDir,
			config,
		});

		expect(result.success).toBe(true);
		expect(result.items).toEqual([]);
		// saveResults should not be called when returning early
		expect(saveResultsMock).not.toHaveBeenCalled();

		createEngineSpy.mockRestore();
		loadIndexSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("handles engine failure (success: false) and produces failed result", async () => {
		const engine = createMockEngine({
			defaultResult: {
				success: false,
				response: "",
				error: "AI execution failed",
				inputTokens: 100,
				outputTokens: 0,
			},
		});

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-fail",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const phaseConfig = createMinimalPhaseConfig({ name: "scan" });
		const config = createMockResolvedConfig();

		const result = await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "fail test",
		});

		expect(result.success).toBe(false);
		expect(result.items.length).toBe(1);
		expect(result.items[0].success).toBe(false);
		expect(result.items[0].error).toBe("AI execution failed");

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("calls beforeRun and afterRun hooks", async () => {
		const engine = createMockEngine({
			defaultResult: {
				success: true,
				response: "ok",
				inputTokens: 100,
				outputTokens: 50,
			},
		});

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-hooks",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const beforeRunMock = mock(() => {});
		const afterRunMock = mock(() => {});

		const phaseConfig = createMinimalPhaseConfig({
			name: "scan",
			beforeRun: beforeRunMock,
			afterRun: afterRunMock,
		});

		const config = createMockResolvedConfig();
		await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "hooks test",
		});

		expect(beforeRunMock).toHaveBeenCalledTimes(1);
		expect(afterRunMock).toHaveBeenCalledTimes(1);

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("calls nextPhase and updates run phase", async () => {
		const engine = createMockEngine({
			defaultResult: {
				success: true,
				response: "ok",
				inputTokens: 100,
				outputTokens: 50,
			},
		});

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-next",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const phaseConfig = createMinimalPhaseConfig({
			name: "scan",
			nextPhase: () => "validate",
		});

		const config = createMockResolvedConfig();
		await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "next phase test",
		});

		// updateRunPhaseInMetaWithLock called twice: once for current phase, once for nextPhase
		expect(updatePhaseSpy).toHaveBeenCalledTimes(2);
		// Second call should be for "validate"
		const secondCallArgs = updatePhaseSpy.mock.calls[1];
		expect(secondCallArgs[1]).toBe("validate");

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("updates runCost with token and phase breakdown", async () => {
		const engine = createMockEngine({
			defaultResult: {
				success: true,
				response: "ok",
				inputTokens: 10000,
				outputTokens: 5000,
			},
		});

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-cost",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const { createRunCost } = await import("../../../src/runner/cost.ts");
		const runCost = createRunCost();

		const phaseConfig = createMinimalPhaseConfig({ name: "scan" });
		const config = createMockResolvedConfig();

		await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "cost test",
			runCost,
		});

		// runCost should have been updated with tokens
		expect(runCost.byPhase.scan).toBeDefined();
		expect(runCost.byPhase.scan.inputTokens).toBe(10000);
		expect(runCost.byPhase.scan.outputTokens).toBe(5000);
		expect(runCost.byPhase.scan.cost).toBeGreaterThan(0);

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("uses customExecute when provided", async () => {
		const engine = createMockEngine();

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-custom",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		const customExecuteMock = mock(async (_ctx: PhaseContext, _runCost: unknown) => {
			return [
				{
					item: { id: "task-1" },
					result: "custom-result",
					success: true,
					inputTokens: 2000,
					outputTokens: 1000,
				},
			] as PhaseItemResult<string>[];
		});

		// Use name "scan" so runPhase creates a new run (non-scan phases call loadRunsIndex)
		const phaseConfig = createMinimalPhaseConfig({
			name: "scan",
			role: "EX" as never,
			customExecute: customExecuteMock,
		});

		const config = createMockResolvedConfig();
		const result = await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "custom exec test",
		});

		expect(customExecuteMock).toHaveBeenCalledTimes(1);
		expect(result.items.length).toBe(1);
		expect(result.items[0].result).toBe("custom-result");
		expect(result.totalInputTokens).toBe(2000);
		expect(result.totalOutputTokens).toBe(1000);

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("handles retry logic: retries items returned by retryFilter", async () => {
		let callCount = 0;
		const engine = createMockEngine({
			executeFn: async () => {
				callCount++;
				if (callCount === 1) {
					return {
						success: true,
						response: "UNVALIDATED",
						inputTokens: 100,
						outputTokens: 50,
					};
				}
				return {
					success: true,
					response: "CONFIRMED",
					inputTokens: 100,
					outputTokens: 50,
				};
			},
		});

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockResolvedValue(engine);

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-retry",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		const updatePhaseSpy = spyOn(runsModule, "updateRunPhaseInMetaWithLock").mockResolvedValue(undefined as never);

		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: () => {} } as never);

		const loaderModule = await import("../../../src/config/loader.ts");
		const loadConfigSpy = spyOn(loaderModule, "loadUserConfig").mockResolvedValue({});

		// Use name "scan" so runPhase creates a new run (non-scan phases call loadRunsIndex)
		const phaseConfig = createMinimalPhaseConfig({
			name: "scan",
			role: "IV" as never,
			loadItems: () => ["item-1"],
			parseResponse: (response) => response,
			isRetryable: true,
			maxRetryRounds: 2,
			retryFilter: (items, results) => {
				// Retry items whose result is UNVALIDATED
				return items.filter((_item, idx) => results[idx]?.result === "UNVALIDATED");
			},
		});

		const config = createMockResolvedConfig();
		const result = await runPhase(phaseConfig, {
			workDir: testDir,
			config,
			scope: "retry test",
		});

		// Should have called engine twice (initial + 1 retry)
		expect(callCount).toBe(2);
		// Final result should be the retried one (CONFIRMED)
		expect(result.items.length).toBe(1);
		expect(result.items[0].result).toBe("CONFIRMED");

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		updatePhaseSpy.mockRestore();
		lockSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("releases lock even on error", async () => {
		const engine = createMockEngine();

		const enginesModule = await import("../../../src/engines/index.ts");
		const createEngineSpy = spyOn(enginesModule, "createEngine").mockRejectedValue(new Error("Engine creation failed"));

		const runsModule = await import("../../../src/state/runs.ts");
		const createRunSpy = spyOn(runsModule, "createRun").mockResolvedValue({
			id: "test-run-error",
			phase: "scan",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});

		const releaseMock = mock(() => {});
		const lockModule = await import("../../../src/state/run-lock.ts");
		const lockSpy = spyOn(lockModule, "acquireRunLock").mockReturnValue({ release: releaseMock } as never);

		const phaseConfig = createMinimalPhaseConfig({ name: "scan" });
		const config = createMockResolvedConfig();

		try {
			await runPhase(phaseConfig, {
				workDir: testDir,
				config,
				scope: "error test",
			});
		} catch {
			// Expected to throw
		}

		expect(releaseMock).toHaveBeenCalledTimes(1);

		createEngineSpy.mockRestore();
		createRunSpy.mockRestore();
		lockSpy.mockRestore();
	});
});
