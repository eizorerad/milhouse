/**
 * Unit tests for daemon session-state saveState/loadState.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveState, loadState, markSessionCrashed, getDaemonStatePath, recordRunStart, recordRunComplete } from "./session-state.ts";
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

	describe("recordRunStart + recordRunComplete lifecycle", () => {
		test("success path: recordRunStart creates pending entry, recordRunComplete with exitCode=0 sets result to success", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			expect(entry.result).toBe("pending");
			expect(entry.finishedAt).toBeUndefined();

			recordRunComplete(entry, {
				exitCode: 0,
				killedByWatchdog: false,
				duration: 30000,
				runId: "run-success-1",
				cost: 1.25,
			});

			expect(entry.result).toBe("success");
			expect(entry.finishedAt).toBeDefined();
			expect(entry.duration).toBe(30000);
			expect(entry.exitCode).toBe(0);
			expect(entry.cost).toBe(1.25);
			expect(entry.runId).toBe("run-success-1");
		});

		test("failure path: recordRunComplete with non-zero exitCode sets result to failed", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			recordRunComplete(entry, {
				exitCode: 1,
				killedByWatchdog: false,
				duration: 15000,
				runId: "run-fail-1",
				cost: 0.50,
			});

			expect(entry.result).toBe("failed");
			expect(entry.exitCode).toBe(1);
			expect(entry.finishedAt).toBeDefined();
		});

		test("killed by watchdog: recordRunComplete with killedByWatchdog=true sets result to killed", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			recordRunComplete(entry, {
				exitCode: 137,
				killedByWatchdog: true,
				duration: 600000,
				runId: "run-killed-1",
			});

			expect(entry.result).toBe("killed");
			expect(entry.killedByWatchdog).toBe(true);
			expect(entry.exitCode).toBe(137);
			expect(entry.finishedAt).toBeDefined();
		});

		test("partial success: recordRunComplete with non-zero exitCode but non-empty issuesFixed sets result to partial", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			recordRunComplete(entry, {
				exitCode: 1,
				killedByWatchdog: false,
				duration: 45000,
				runId: "run-partial-1",
				cost: 2.00,
				issuesFixed: ["issue-1", "issue-2"],
				issuesFailed: ["issue-3"],
			});

			expect(entry.result).toBe("partial");
			expect(entry.exitCode).toBe(1);
			expect(entry.issuesFixed).toEqual(["issue-1", "issue-2"]);
			expect(entry.issuesFailed).toEqual(["issue-3"]);
		});

		test("entry remains in state.runs[] with completed data after recordRunStart + recordRunComplete", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			expect(state.runs).toHaveLength(1);
			expect(state.runs[0].result).toBe("pending");

			recordRunComplete(entry, {
				exitCode: 0,
				killedByWatchdog: false,
				duration: 20000,
				runId: "run-verify-1",
				cost: 0.75,
			});

			// The entry in state.runs[] is the same object (mutated in place)
			expect(state.runs).toHaveLength(1);
			expect(state.runs[0].result).toBe("success");
			expect(state.runs[0].finishedAt).toBeDefined();
			expect(state.runs[0].exitCode).toBe(0);
			expect(state.runs[0].cost).toBe(0.75);
			expect(state.runs[0]).toBe(entry); // same reference
		});

		test("persisted state contains completed run entries after saveState", () => {
			const state = makeDaemonState();
			const entry = recordRunStart(state);

			recordRunComplete(entry, {
				exitCode: 0,
				killedByWatchdog: false,
				duration: 10000,
				runId: "run-persist-1",
				cost: 3.50,
			});

			saveState(state, workDir);
			const loaded = loadState(workDir);

			expect(loaded).not.toBeNull();
			expect(loaded!.runs).toHaveLength(1);
			expect(loaded!.runs[0].result).not.toBe("pending");
			expect(loaded!.runs[0].result).toBe("success");
			expect(loaded!.runs[0].finishedAt).toBeDefined();
			expect(loaded!.runs[0].exitCode).toBe(0);
			expect(loaded!.runs[0].cost).toBe(3.50);
			expect(loaded!.runs[0].runId).toBe("run-persist-1");
		});
	});
});
