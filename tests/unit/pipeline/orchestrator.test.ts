import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import type { PhaseRunResult } from "../../../src/runner/types.ts";
import { createMockResolvedConfig } from "../runner/helpers.ts";

// ---------------------------------------------------------------------------
// Module-level mocks – stub runPhase and side-effect-heavy imports BEFORE
// importing the orchestrator so the module picks up the mocked versions.
// ---------------------------------------------------------------------------

const mockRunPhase = mock<(cfg: unknown, opts: unknown) => Promise<PhaseRunResult>>();

mock.module("../../../src/runner/phase-runner.ts", () => ({
	runPhase: mockRunPhase,
	displayPhaseSummaryHeader: () => {},
}));

mock.module("../../../src/report/generator.ts", () => ({
	autoGenerateReport: () => {},
}));

// Import orchestrator AFTER mocks are registered
const { runPipeline } = await import("../../../src/pipeline/orchestrator.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhaseResult(overrides: Partial<PhaseRunResult> = {}): PhaseRunResult {
	return {
		phase: "scan",
		runId: "test-run-001",
		success: true,
		items: [],
		totalInputTokens: 10,
		totalOutputTokens: 5,
		cost: 0.001,
		duration: 100,
		...overrides,
	};
}

function baseOptions(overrides: Record<string, unknown> = {}) {
	return {
		workDir: "/tmp/test-work",
		config: createMockResolvedConfig({ failFast: false }),
		pipeline: ["scan", "validate", "plan"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Suppress console output from displaySummary
// ---------------------------------------------------------------------------
let consoleSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	mockRunPhase.mockReset();
	consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	consoleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline – phasesCompleted correctness", () => {
	it("all phases succeed: phasesCompleted includes all phases", async () => {
		mockRunPhase.mockImplementation(async (cfg: any) => {
			return makePhaseResult({ phase: cfg.name, success: true });
		});

		const result = await runPipeline(baseOptions());

		expect(result.success).toBe(true);
		expect(result.phasesCompleted).toEqual(["scan", "validate", "plan"]);
		expect(result.stoppedAt).toBeUndefined();
	});

	it("failFast enabled + failed phase: phasesCompleted excludes the failed phase", async () => {
		mockRunPhase.mockImplementation(async (cfg: any) => {
			if (cfg.name === "validate") {
				return makePhaseResult({ phase: "validate", success: false });
			}
			return makePhaseResult({ phase: cfg.name, success: true });
		});

		const result = await runPipeline(
			baseOptions({ config: createMockResolvedConfig({ failFast: true }) }),
		);

		expect(result.success).toBe(false);
		// "scan" succeeded, "validate" failed – should NOT be in phasesCompleted
		expect(result.phasesCompleted).toEqual(["scan"]);
		expect(result.phasesCompleted).not.toContain("validate");
		expect(result.stoppedAt).toBe("validate");
	});

	it("failFast disabled + failed phase: phasesCompleted contains only succeeded phases", async () => {
		// scan succeeds, validate fails, plan succeeds
		mockRunPhase.mockImplementation(async (cfg: any) => {
			if (cfg.name === "validate") {
				return makePhaseResult({ phase: "validate", success: false });
			}
			return makePhaseResult({ phase: cfg.name, success: true });
		});

		const result = await runPipeline(
			baseOptions({ config: createMockResolvedConfig({ failFast: false }) }),
		);

		// Pipeline continues past failure when failFast is disabled
		expect(result.success).toBe(false);
		expect(result.phasesCompleted).toEqual(["scan", "plan"]);
		expect(result.phasesCompleted).not.toContain("validate");
	});

	it("exception in phase: phasesCompleted excludes the phase that threw", async () => {
		mockRunPhase.mockImplementation(async (cfg: any) => {
			if (cfg.name === "plan") {
				throw new Error("Unexpected engine crash");
			}
			return makePhaseResult({ phase: cfg.name, success: true });
		});

		// failFast disabled so pipeline continues after error (but no more phases after plan)
		const result = await runPipeline(
			baseOptions({ config: createMockResolvedConfig({ failFast: false }) }),
		);

		expect(result.success).toBe(false);
		expect(result.phasesCompleted).toEqual(["scan", "validate"]);
		expect(result.phasesCompleted).not.toContain("plan");
	});

	it("exception in phase with failFast: stops immediately, excludes thrown phase", async () => {
		mockRunPhase.mockImplementation(async (cfg: any) => {
			if (cfg.name === "validate") {
				throw new Error("Connection timeout");
			}
			return makePhaseResult({ phase: cfg.name, success: true });
		});

		const result = await runPipeline(
			baseOptions({ config: createMockResolvedConfig({ failFast: true }) }),
		);

		expect(result.success).toBe(false);
		expect(result.phasesCompleted).toEqual(["scan"]);
		expect(result.phasesCompleted).not.toContain("validate");
		expect(result.stoppedAt).toBe("validate");
	});
});
