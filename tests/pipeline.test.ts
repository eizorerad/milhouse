/**
 * Tests for pipeline resume and completion semantics.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config, Phase, PhaseResult } from "../src/types.ts";

const mockRunPhase = mock<
	(phase: { name: Phase }, ...args: unknown[]) => Promise<PhaseResult[]>
>();

mock.module("../src/runner.ts", () => ({
	runPhase: mockRunPhase,
}));

const mockPreflight = mock<(...args: unknown[]) => Promise<void>>();

mock.module("../src/preflight.ts", () => ({
	preflight: mockPreflight,
	KNOWN_ENGINES: ["claude", "gemini", "aider"],
	checkEngine: async () => {},
	checkGitRepo: async () => {},
	checkConfig: () => {},
}));

const { runPipeline } = await import("../src/pipeline.ts");
const { RunStore } = await import("../src/state.ts");

function makeConfig(pipeline: Phase[]): Config {
	return {
		engine: "claude",
		model: "sonnet",
		pipeline,
		failFast: true,
		phases: {
			scan: { workers: 1, retries: 0 },
			validate: { workers: 1, retries: 0 },
			plan: { workers: 1, retries: 0 },
			consolidate: { workers: 1, retries: 0 },
			exec: { workers: 1, retries: 0 },
			verify: { workers: 1, retries: 0 },
		},
		cost: { inputPerMillion: 0, outputPerMillion: 0, budget: 0 },
		project: { name: "test", language: "ts", framework: "bun", description: "" },
		commands: { test: "bun test", lint: "bun lint", build: "bun build" },
		rules: [],
		boundaries: { neverTouch: [] },
		gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },
	};
}

function successResult(): PhaseResult[] {
	return [{ item: {}, result: {}, success: true, tokens: { response: "", inputTokens: 0, outputTokens: 0 } }];
}

describe("runPipeline", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-pipeline-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		mockRunPhase.mockReset();
		mockPreflight.mockReset();
		mockPreflight.mockResolvedValue(undefined);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resumes from the phase after the last completed phase", async () => {
		const config = makeConfig(["scan", "validate", "plan"]);
		const store = RunStore.create(tmpDir, "scope");
		store.completePhase("scan");
		store.stopRun("validate", "stopped");

		mockRunPhase.mockResolvedValue(successResult());

		await runPipeline(config, { resume: true, runId: store.runId });

		expect(mockRunPhase.mock.calls.map(([phase]) => phase.name)).toEqual(["validate", "plan"]);
		expect(store.loadMeta()).toMatchObject({
			phase: "completed",
			status: "completed",
			last_completed_phase: "plan",
		});
	});

	it("calls preflight before proceeding", async () => {
		const config = makeConfig(["scan"]);
		mockPreflight.mockRejectedValueOnce(new Error("preflight failed"));

		// runPipeline calls process.exit(1) on preflight failure; mock it to throw
		// so execution actually stops
		const originalExit = process.exit;
		process.exit = (() => { throw new Error("EXIT"); }) as any;

		try {
			await runPipeline(config, { scope: "scope" });
		} catch (e: any) {
			expect(e.message).toBe("EXIT");
		} finally {
			process.exit = originalExit;
		}

		expect(mockPreflight).toHaveBeenCalledTimes(1);
		expect(mockRunPhase).not.toHaveBeenCalled();
	});

	it("does not mark the run completed when a phase stops with no items", async () => {
		const config = makeConfig(["scan", "validate", "plan"]);

		mockRunPhase
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce([]);

		await runPipeline(config, { scope: "scope" });

		const store = RunStore.latest(tmpDir);
		expect(store).not.toBeNull();
		expect(store!.loadMeta()).toMatchObject({
			phase: "plan",
			status: "stopped",
			last_completed_phase: "validate",
		});
	});
});
