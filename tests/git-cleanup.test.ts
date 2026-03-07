/**
 * Tests for Windows-aware worktree cleanup.
 * Mocks Bun.spawn to simulate git command outcomes.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { cleanupDeferredWorktrees, cleanupWorktree } from "../src/git.ts";

/** Returns a mock implementation that produces fresh proc objects per call */
function spawnReturning(...sequence: boolean[]) {
	let idx = 0;
	return () => {
		const ok = idx < sequence.length ? sequence[idx] : sequence[sequence.length - 1];
		idx++;
		return {
			stdin: null,
			stdout: new Blob([""]).stream(),
			stderr: new Blob([ok ? "" : "error"]).stream(),
			exited: Promise.resolve(ok ? 0 : 1),
			kill: mock(() => {}),
			pid: 1,
		} as never;
	};
}

describe("cleanupWorktree", () => {
	let spawnMock: ReturnType<typeof spyOn>;

	afterEach(() => {
		spawnMock?.mockRestore();
	});

	it("succeeds on first try via git worktree remove", async () => {
		// git worktree remove succeeds, then git worktree prune succeeds
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(true, true));

		const result = await cleanupWorktree("/tmp/wt", "/tmp/base");

		expect(result).toBe(true);
		// Should have called git worktree remove + git worktree prune
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it("retries on EBUSY-like failures and eventually returns false", async () => {
		// All git remove attempts fail, manual fallback also fails (path doesn't exist)
		// This simulates the retry exhaustion path
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(false));

		const result = await cleanupWorktree("/tmp/nonexistent-wt", "/tmp/base");

		// After 3 retry attempts with non-existent path, returns false
		expect(result).toBe(false);
		// At least 3 git worktree remove attempts
		expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("succeeds on second attempt after first git remove fails", async () => {
		// Attempt 1: git remove fails, manual fallback fails (path doesn't exist)
		// Attempt 2: git remove succeeds
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(false, true, true));

		const result = await cleanupWorktree("/tmp/nonexistent-wt", "/tmp/base");

		expect(result).toBe(true);
	});

	it("returns true when git remove succeeds immediately", async () => {
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(true, true));

		const result = await cleanupWorktree("/any/path", "/base");

		expect(result).toBe(true);
	});

	it("returns boolean not void", async () => {
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(true, true));

		const result = await cleanupWorktree("/any/path", "/base");

		expect(typeof result).toBe("boolean");
	});
});

describe("cleanupDeferredWorktrees", () => {
	let spawnMock: ReturnType<typeof spyOn>;
	let existsSyncMock: ReturnType<typeof spyOn>;

	afterEach(() => {
		spawnMock?.mockRestore();
		existsSyncMock?.mockRestore();
	});

	it("skips empty paths array without spawning git", async () => {
		spawnMock = spyOn(Bun, "spawn");
		await cleanupDeferredWorktrees([], "/tmp/base");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("skips paths that no longer exist", async () => {
		existsSyncMock = spyOn(fs, "existsSync").mockReturnValue(false);
		spawnMock = spyOn(Bun, "spawn");

		await cleanupDeferredWorktrees(["/tmp/wt1", "/tmp/wt2"], "/tmp/base");

		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("retries cleanup for existing deferred paths", async () => {
		existsSyncMock = spyOn(fs, "existsSync").mockReturnValue(true);
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(true, true));

		await cleanupDeferredWorktrees(["/tmp/wt1"], "/tmp/base");

		expect(spawnMock).toHaveBeenCalled();
	});

	it("handles multiple deferred paths", async () => {
		existsSyncMock = spyOn(fs, "existsSync").mockReturnValue(true);
		spawnMock = spyOn(Bun, "spawn").mockImplementation(spawnReturning(true, true));

		await cleanupDeferredWorktrees(["/tmp/wt1", "/tmp/wt2"], "/tmp/base");

		// Each cleanup needs at least 2 git calls (remove + prune)
		expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(4);
	});
});
