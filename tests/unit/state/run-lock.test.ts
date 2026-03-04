/**
 * Unit tests for run-lock.ts
 *
 * Tests the per-run per-phase execution lock mechanism
 * that prevents concurrent execution of the same phase for the same run.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, isRunLocked } from "../../../src/state/run-lock.ts";

describe("run-lock", () => {
	const testDir = join(process.cwd(), ".test-run-lock-unit");
	const testRunId = "test-run-001";
	const testPhase = "execute";

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	/** Helper to get the lock file path for a given runId and phase */
	function getLockFilePath(runId: string, phase: string): string {
		return join(testDir, ".milhouse", "runs", runId, `${phase}.lock`);
	}

	describe("acquireRunLock", () => {
		it("should return an object with a release function and create lock file with correct content", () => {
			const lock = acquireRunLock(testRunId, testPhase, testDir);

			expect(lock).toBeDefined();
			expect(typeof lock.release).toBe("function");

			// Verify lock file was created
			const lockPath = getLockFilePath(testRunId, testPhase);
			expect(existsSync(lockPath)).toBe(true);

			// Verify lock file contains correct PID and startedAt
			const content = JSON.parse(readFileSync(lockPath, "utf-8"));
			expect(content.pid).toBe(process.pid);
			expect(content.startedAt).toBeDefined();
			expect(typeof content.startedAt).toBe("string");
			// Verify startedAt is a valid ISO date
			expect(Number.isNaN(new Date(content.startedAt).getTime())).toBe(false);

			lock.release();
		});

		it("should create the parent directory if it doesn't exist", () => {
			const runId = "nonexistent-run-dir";
			const parentDir = join(testDir, ".milhouse", "runs", runId);

			expect(existsSync(parentDir)).toBe(false);

			const lock = acquireRunLock(runId, testPhase, testDir);

			expect(existsSync(parentDir)).toBe(true);
			expect(existsSync(getLockFilePath(runId, testPhase))).toBe(true);

			lock.release();
		});

		it("should throw when lock file exists with a live PID", () => {
			const lockPath = getLockFilePath(testRunId, testPhase);
			const lockDir = join(lockPath, "..");
			mkdirSync(lockDir, { recursive: true });

			// Write a lock file with the current process PID (which is alive)
			const lockInfo = {
				pid: process.pid,
				startedAt: new Date().toISOString(),
			};
			writeFileSync(lockPath, JSON.stringify(lockInfo));

			expect(() => acquireRunLock(testRunId, testPhase, testDir)).toThrow(
				/is locked by PID/,
			);
		});

		it("should succeed by overwriting a stale lock (dead PID)", () => {
			const lockPath = getLockFilePath(testRunId, testPhase);
			const lockDir = join(lockPath, "..");
			mkdirSync(lockDir, { recursive: true });

			// Write a lock file with a PID that is definitely dead
			const staleLock = {
				pid: 999999999,
				startedAt: "2020-01-01T00:00:00.000Z",
			};
			writeFileSync(lockPath, JSON.stringify(staleLock));

			// Should succeed since the PID is dead
			const lock = acquireRunLock(testRunId, testPhase, testDir);
			expect(lock).toBeDefined();

			// Verify the lock file now has the current PID
			const content = JSON.parse(readFileSync(lockPath, "utf-8"));
			expect(content.pid).toBe(process.pid);

			lock.release();
		});

		it("should succeed by overwriting a corrupted lock file", () => {
			const lockPath = getLockFilePath(testRunId, testPhase);
			const lockDir = join(lockPath, "..");
			mkdirSync(lockDir, { recursive: true });

			// Write invalid JSON to the lock file
			writeFileSync(lockPath, "this is not valid json {{{");

			const lock = acquireRunLock(testRunId, testPhase, testDir);
			expect(lock).toBeDefined();

			// Verify the lock file now has valid content
			const content = JSON.parse(readFileSync(lockPath, "utf-8"));
			expect(content.pid).toBe(process.pid);

			lock.release();
		});
	});

	describe("release", () => {
		it("should remove the lock file when called", () => {
			const lock = acquireRunLock(testRunId, testPhase, testDir);
			const lockPath = getLockFilePath(testRunId, testPhase);

			expect(existsSync(lockPath)).toBe(true);

			lock.release();

			expect(existsSync(lockPath)).toBe(false);
		});
	});

	describe("isRunLocked", () => {
		it("should return { locked: false } when no lock file exists", () => {
			const result = isRunLocked(testRunId, testPhase, testDir);

			expect(result).toEqual({ locked: false });
		});

		it("should return { locked: true, pid, since } for a live PID", () => {
			const lock = acquireRunLock(testRunId, testPhase, testDir);

			const result = isRunLocked(testRunId, testPhase, testDir);

			expect(result.locked).toBe(true);
			expect(result.pid).toBe(process.pid);
			expect(result.since).toBeDefined();

			lock.release();
		});

		it("should return { locked: false } for a dead PID", () => {
			const lockPath = getLockFilePath(testRunId, testPhase);
			const lockDir = join(lockPath, "..");
			mkdirSync(lockDir, { recursive: true });

			// Write lock with dead PID
			const staleLock = {
				pid: 999999999,
				startedAt: "2020-01-01T00:00:00.000Z",
			};
			writeFileSync(lockPath, JSON.stringify(staleLock));

			const result = isRunLocked(testRunId, testPhase, testDir);

			expect(result).toEqual({ locked: false });
		});

		it("should return { locked: false } for corrupted lock file", () => {
			const lockPath = getLockFilePath(testRunId, testPhase);
			const lockDir = join(lockPath, "..");
			mkdirSync(lockDir, { recursive: true });

			writeFileSync(lockPath, "not valid json");

			const result = isRunLocked(testRunId, testPhase, testDir);

			expect(result).toEqual({ locked: false });
		});
	});
});
