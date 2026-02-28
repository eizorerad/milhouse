/**
 * Unit tests for daemon session-state saveState/loadState.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveState, loadState, markSessionCrashed, getDaemonStatePath } from "./session-state.ts";
import type { DaemonState } from "./types.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `session-state-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeDaemonState(overrides: Partial<DaemonState> = {}): DaemonState {
	return {
		sessionId: "daemon-20260227-abc123",
		startedAt: "2026-02-27T00:00:00.000Z",
		scope: "test",
		pid: process.pid,
		status: "running",
		runs: [],
		consecutiveFailures: 0,
		totalCost: 0,
		costExtractionFailures: 0,
		totalRuns: 0,
		orchestratorDecisions: [],
		...overrides,
	};
}

describe("session-state", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeTempDir();
		// Ensure .milhouse dir exists for saveState/loadState
		mkdirSync(join(workDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	});

	describe("saveState + loadState round-trip", () => {
		test("saveState writes valid JSON that loadState reads back", () => {
			const state = makeDaemonState({ scope: "round-trip" });
			saveState(state, workDir);

			const loaded = loadState(workDir);
			expect(loaded).not.toBeNull();
			expect(loaded!.sessionId).toBe(state.sessionId);
			expect(loaded!.scope).toBe("round-trip");
			expect(loaded!.status).toBe("running");
			expect(loaded!.runs).toEqual([]);
		});

		test("saveState uses atomic write (no .tmp file remains)", () => {
			const state = makeDaemonState();
			saveState(state, workDir);

			const statePath = getDaemonStatePath(workDir);
			expect(existsSync(statePath)).toBe(true);
			expect(existsSync(`${statePath}.tmp`)).toBe(false);
		});
	});

	describe("loadState missing file", () => {
		test("returns null for missing file", () => {
			const emptyDir = makeTempDir();
			mkdirSync(join(emptyDir, ".milhouse"), { recursive: true });

			const result = loadState(emptyDir);
			expect(result).toBeNull();

			rmSync(emptyDir, { recursive: true, force: true });
		});
	});

	describe("loadState retry on parse failure", () => {
		test("retries and succeeds when first read returns invalid JSON but second succeeds", () => {
			const state = makeDaemonState({ scope: "retry-test" });
			saveState(state, workDir);

			const statePath = getDaemonStatePath(workDir);
			const validJson = readFileSync(statePath, "utf-8");

			let callCount = 0;
			const readSpy = spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
				callCount++;
				if (callCount === 1) {
					return "{ invalid json !!!";
				}
				// Second call returns valid JSON
				return validJson;
			});

			const loaded = loadState(workDir);
			expect(loaded).not.toBeNull();
			expect(loaded!.scope).toBe("retry-test");
			// readFileSync should have been called at least twice (first fail, retry succeed)
			expect(callCount).toBeGreaterThanOrEqual(2);

			readSpy.mockRestore();
		});

		test("returns null when file is persistently corrupt (both attempts fail)", () => {
			const state = makeDaemonState();
			saveState(state, workDir);

			const readSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
				return "not valid json at all {{{";
			});

			const loaded = loadState(workDir);
			expect(loaded).toBeNull();

			readSpy.mockRestore();
		});
	});

	describe("markSessionCrashed", () => {
		test("with inMemoryState preserves the provided totalCost rather than loading stale data from disk", () => {
			// Save initial state with low totalCost to disk (simulates stale persisted state)
			const staleState = makeDaemonState({ totalCost: 1.0, costExtractionFailures: 0 });
			saveState(staleState, workDir);

			// Create in-memory state with higher totalCost (the accurate value)
			const inMemoryState = makeDaemonState({ totalCost: 25.50, costExtractionFailures: 3 });

			markSessionCrashed(workDir, inMemoryState);

			// Verify the saved state has the in-memory values, not the stale disk values
			const loaded = loadState(workDir);
			expect(loaded).not.toBeNull();
			expect(loaded!.status).toBe("crashed");
			expect(loaded!.totalCost).toBe(25.50);
			expect(loaded!.costExtractionFailures).toBe(3);
		});

		test("without inMemoryState falls back to loading state from disk", () => {
			const state = makeDaemonState({ totalCost: 5.0, scope: "fallback-test" });
			saveState(state, workDir);

			markSessionCrashed(workDir);

			const loaded = loadState(workDir);
			expect(loaded).not.toBeNull();
			expect(loaded!.status).toBe("crashed");
			expect(loaded!.totalCost).toBe(5.0);
			expect(loaded!.scope).toBe("fallback-test");
		});
	});
});
