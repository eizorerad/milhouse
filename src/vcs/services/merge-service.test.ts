/**
 * @fileoverview Unit Tests for VCS Merge Service — Stash Backup Flow
 *
 * Tests the stash conflict backup behavior in mergeInIsolatedWorktree.
 *
 * @module vcs/services/merge-service.test
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as gitCli from "../backends/git-cli";
import * as logger from "../../ui/logger";
import { createVcsError, err, ok } from "../types";
import { MergeService, classifyCheckoutError } from "./merge-service";

describe("MergeService.mergeInIsolatedWorktree — stash backup", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let existsSyncSpy: ReturnType<typeof spyOn>;
	let mkdirSyncSpy: ReturnType<typeof spyOn>;
	let rmSyncSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
		existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(true);
		mkdirSyncSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined as any);
		rmSyncSpy = spyOn(fs, "rmSync").mockReturnValue(undefined);
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
		existsSyncSpy.mockRestore();
		mkdirSyncSpy.mockRestore();
		rmSyncSpy.mockRestore();
	});

	/**
	 * Build a mock implementation that simulates the stash-pop-conflict flow.
	 * The caller can override behavior for specific git commands.
	 */
	function buildConflictFlowMock(overrides: {
		revParseFails?: boolean;
		stashPopSucceeds?: boolean;
	} = {}) {
		const calls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			calls.push([...args]);

			// worktree prune
			if (args[0] === "worktree" && args[1] === "prune") {
				return successResult();
			}

			// worktree add
			if (args[0] === "worktree" && args[1] === "add") {
				return successResult();
			}

			// worktree remove
			if (args[0] === "worktree" && args[1] === "remove") {
				return successResult();
			}

			// branch -D (cleanup)
			if (args[0] === "branch" && args[1] === "-D") {
				return successResult();
			}

			// First ff-only merge — fails (dirty files)
			if (args[0] === "merge" && args[1] === "--ff-only") {
				// After stash, the second ff-only succeeds
				const ffCalls = calls.filter(
					(c) => c[0] === "merge" && c[1] === "--ff-only",
				);
				if (ffCalls.length === 1) {
					return failedResult(1, "Cannot merge: dirty files");
				}
				return successResult();
			}

			// stash push (stashChanges internally checks status first)
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("M  dirty-file.ts");
			}

			if (args[0] === "stash" && args[1] === "push") {
				return successResult();
			}

			// stash pop — conflict or success based on override
			if (args[0] === "stash" && args[1] === "pop") {
				if (overrides.stashPopSucceeds) {
					return successResult();
				}
				return failedResult(1, "CONFLICT in dirty-file.ts");
			}

			// getConflictedFiles — returns conflicted files (porcelain with UU prefix)
			// Note: this is handled by the status --porcelain case above when called during
			// getConflictedFiles after stash pop fails. We need to distinguish the context.
			// Since getConflictedFiles also calls status --porcelain, we handle it via
			// the UU-prefixed output for the second call.

			// rev-parse stash@{0} — for backup
			if (args[0] === "rev-parse" && args[1] === "stash@{0}") {
				if (overrides.revParseFails) {
					return failedResult(1, "fatal: stash ref not found");
				}
				return successResult("abc123def456");
			}

			// update-ref — for backup
			if (args[0] === "update-ref") {
				return successResult();
			}

			// checkout --ours
			if (args[0] === "checkout" && args[1] === "--ours") {
				return successResult();
			}

			// add
			if (args[0] === "add") {
				return successResult();
			}

			// stash drop
			if (args[0] === "stash" && args[1] === "drop") {
				return successResult();
			}

			// reset HEAD
			if (args[0] === "reset" && args[1] === "HEAD") {
				return successResult();
			}

			return successResult();
		});

		return calls;
	}

	/**
	 * A more precise mock that correctly simulates the status --porcelain call
	 * returning conflicted files (UU prefix) after stash pop fails.
	 */
	function buildPreciseConflictFlowMock(overrides: {
		revParseFails?: boolean;
		stashPopSucceeds?: boolean;
		checkoutOursFails?: boolean | "err";
		addFails?: boolean;
		stashDropFails?: boolean;
		resetHeadFails?: boolean;
	} = {}) {
		const calls: string[][] = [];
		let stashPushDone = false;
		let stashPopDone = false;

		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			calls.push([...args]);

			// worktree prune
			if (args[0] === "worktree" && args[1] === "prune") {
				return successResult();
			}

			// worktree add
			if (args[0] === "worktree" && args[1] === "add") {
				return successResult();
			}

			// worktree remove
			if (args[0] === "worktree" && args[1] === "remove") {
				return successResult();
			}

			// branch -D
			if (args[0] === "branch" && args[1] === "-D") {
				return successResult();
			}

			// ff-only merge
			if (args[0] === "merge" && args[1] === "--ff-only") {
				if (!stashPushDone) {
					// First attempt: fail due to dirty files
					return failedResult(1, "Cannot merge: dirty files");
				}
				// Second attempt after stash: succeed
				return successResult();
			}

			// status --porcelain (used by stashChanges and getConflictedFiles)
			if (args[0] === "status" && args[1] === "--porcelain") {
				if (stashPopDone) {
					// After conflicted stash pop: return UU (both-modified / conflict)
					return successResult("UU dirty-file.ts");
				}
				// Before stash: has dirty files
				return successResult("M  dirty-file.ts");
			}

			// stash push
			if (args[0] === "stash" && args[1] === "push") {
				stashPushDone = true;
				return successResult();
			}

			// stash pop
			if (args[0] === "stash" && args[1] === "pop") {
				stashPopDone = true;
				if (overrides.stashPopSucceeds) {
					return successResult();
				}
				return failedResult(1, "CONFLICT in dirty-file.ts");
			}

			// rev-parse stash@{0}
			if (args[0] === "rev-parse" && args[1] === "stash@{0}") {
				if (overrides.revParseFails) {
					return failedResult(1, "fatal: stash ref not found");
				}
				return successResult("abc123def456");
			}

			// update-ref
			if (args[0] === "update-ref") {
				return successResult();
			}

			// checkout --ours
			if (args[0] === "checkout" && args[1] === "--ours") {
				if (overrides.checkoutOursFails === "err") {
					return err(createVcsError("COMMAND_FAILED", "checkout --ours spawn failed"));
				}
				if (overrides.checkoutOursFails) {
					return failedResult(1, "error: path 'dirty-file.ts' does not have our version");
				}
				return successResult();
			}

			// add
			if (args[0] === "add") {
				if (overrides.addFails) {
					return failedResult(1, "fatal: unable to stat 'dirty-file.ts': Permission denied");
				}
				return successResult();
			}

			// stash drop
			if (args[0] === "stash" && args[1] === "drop") {
				if (overrides.stashDropFails) {
					return failedResult(1, "fatal: log for 'stash' is empty");
				}
				return successResult();
			}

			// reset HEAD
			if (args[0] === "reset" && args[1] === "HEAD") {
				if (overrides.resetHeadFails) {
					return failedResult(1, "fatal: Failed to resolve 'HEAD' as a valid ref");
				}
				return successResult();
			}

			return successResult();
		});

		return calls;
	}

	const noopOperation = async () => {};

	test("stash pop conflict triggers backup before auto-resolution", async () => {
		const calls = buildPreciseConflictFlowMock();

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(true);

		// Find the indices of rev-parse stash@{0}, update-ref, and checkout --ours
		const revParseIdx = calls.findIndex(
			(c) => c[0] === "rev-parse" && c[1] === "stash@{0}",
		);
		const updateRefIdx = calls.findIndex(
			(c) => c[0] === "update-ref" && c[1]?.startsWith("refs/milhouse/stash-backup/"),
		);
		const checkoutOursIdx = calls.findIndex(
			(c) => c[0] === "checkout" && c[1] === "--ours",
		);

		expect(revParseIdx).toBeGreaterThan(-1);
		expect(updateRefIdx).toBeGreaterThan(-1);
		expect(checkoutOursIdx).toBeGreaterThan(-1);

		// Backup commands must come BEFORE checkout --ours
		expect(revParseIdx).toBeLessThan(checkoutOursIdx);
		expect(updateRefIdx).toBeLessThan(checkoutOursIdx);
	});

	test("backup ref is included in result when conflicts are resolved", async () => {
		buildPreciseConflictFlowMock();

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.stashConflictsResolved).toEqual(["dirty-file.ts"]);
			expect(result.value.stashBackupRef).toMatch(
				/^refs\/milhouse\/stash-backup\/mh-merge-/,
			);
		}
	});

	test("backup failure does not abort conflict resolution", async () => {
		const calls = buildPreciseConflictFlowMock({ revParseFails: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			// Resolution still succeeded
			expect(result.value.success).toBe(true);
			expect(result.value.stashConflictsResolved).toEqual(["dirty-file.ts"]);
			// But no backup ref
			expect(result.value.stashBackupRef).toBeUndefined();
		}

		// Verify checkout --ours still happened despite backup failure
		const checkoutOurs = calls.filter(
			(c) => c[0] === "checkout" && c[1] === "--ours",
		);
		expect(checkoutOurs.length).toBeGreaterThan(0);
	});

	test("no backup attempted when stash pop succeeds without conflicts", async () => {
		const calls = buildPreciseConflictFlowMock({ stashPopSucceeds: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.stashWasNeeded).toBe(true);
			expect(result.value.stashConflictsResolved).toEqual([]);
			expect(result.value.stashBackupRef).toBeUndefined();
		}

		// Verify rev-parse stash@{0} and update-ref were NOT called
		const revParseStash = calls.filter(
			(c) => c[0] === "rev-parse" && c[1] === "stash@{0}",
		);
		const updateRef = calls.filter(
			(c) => c[0] === "update-ref",
		);
		expect(revParseStash.length).toBe(0);
		expect(updateRef.length).toBe(0);
	});

	test("returns error when checkout --ours fails during stash conflict resolution", async () => {
		buildPreciseConflictFlowMock({ checkoutOursFails: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});

	test("returns error when git add fails during stash conflict resolution", async () => {
		buildPreciseConflictFlowMock({ addFails: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});

	test("returns error when stash drop fails during stash conflict resolution", async () => {
		buildPreciseConflictFlowMock({ stashDropFails: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});

	test("returns error when reset HEAD fails during stash conflict resolution", async () => {
		buildPreciseConflictFlowMock({ resetHeadFails: true });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});

	test("returns error when checkout --ours command itself fails (ok: false)", async () => {
		buildPreciseConflictFlowMock({ checkoutOursFails: "err" });

		const result = await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});
});

describe("MergeService.continueRebase", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	test("returns ok(true) when rebase --continue succeeds (exit 0)", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// rebase --continue succeeds
			if (args.includes("rebase") && args.includes("--continue")) {
				return successResult();
			}
			return successResult();
		});

		const result = await mergeService.continueRebase("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
	});

	test("returns ok(true) when reflog shows rebase (finish) after non-zero exit", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// rebase --continue exits 1
			if (args.includes("rebase") && args.includes("--continue")) {
				return failedResult(1, "No rebase in progress?");
			}
			// isRebaseInProgress: rev-parse --git-path rebase-merge
			if (args[0] === "rev-parse" && args[1] === "--git-path") {
				return successResult(".git/rebase-merge");
			}
			// isRebaseInProgress: rev-parse --verify REBASE_HEAD — no rebase
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "REBASE_HEAD") {
				return failedResult(128, "fatal: Needed a single revision");
			}
			// reflog -1 --format=%gs — rebase finished
			if (args[0] === "reflog" && args[1] === "-1") {
				return successResult("rebase (finish): returning to refs/heads/feature");
			}
			return successResult();
		});

		const result = await mergeService.continueRebase("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
	});

	test("returns ok(false) when reflog shows rebase (abort) after non-zero exit", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// rebase --continue exits 1
			if (args.includes("rebase") && args.includes("--continue")) {
				return failedResult(1, "No rebase in progress?");
			}
			// isRebaseInProgress: rev-parse --git-path rebase-merge
			if (args[0] === "rev-parse" && args[1] === "--git-path") {
				return successResult(".git/rebase-merge");
			}
			// isRebaseInProgress: rev-parse --verify REBASE_HEAD — no rebase
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "REBASE_HEAD") {
				return failedResult(128, "fatal: Needed a single revision");
			}
			// reflog -1 --format=%gs — rebase aborted
			if (args[0] === "reflog" && args[1] === "-1") {
				return successResult("rebase (abort): returning to abc123");
			}
			return successResult();
		});

		const result = await mergeService.continueRebase("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}
	});

	test("falls back to ok(true) when reflog check fails", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// rebase --continue exits 1
			if (args.includes("rebase") && args.includes("--continue")) {
				return failedResult(1, "No rebase in progress?");
			}
			// isRebaseInProgress: rev-parse --git-path rebase-merge
			if (args[0] === "rev-parse" && args[1] === "--git-path") {
				return successResult(".git/rebase-merge");
			}
			// isRebaseInProgress: rev-parse --verify REBASE_HEAD — no rebase
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "REBASE_HEAD") {
				return failedResult(128, "fatal: Needed a single revision");
			}
			// reflog command fails
			if (args[0] === "reflog") {
				return failedResult(1, "fatal: bad default revision 'HEAD'");
			}
			return successResult();
		});

		const result = await mergeService.continueRebase("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
	});

	test("returns ok(false) when rebase is still in progress with new conflicts", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// rebase --continue exits 1
			if (args.includes("rebase") && args.includes("--continue")) {
				return failedResult(1, "Could not apply patch");
			}
			// isRebaseInProgress: rev-parse --git-path rebase-merge
			if (args[0] === "rev-parse" && args[1] === "--git-path") {
				return successResult(".git/rebase-merge");
			}
			// isRebaseInProgress: rev-parse --verify REBASE_HEAD — rebase still active
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "REBASE_HEAD") {
				return successResult("abc123");
			}
			// getConflictedFiles: status --porcelain
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("UU file.ts");
			}
			return successResult();
		});

		const result = await mergeService.continueRebase("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}
	});
});

describe("MergeService.completeMerge", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	test("stages all changes with git add -A (not individual files)", async () => {
		const calls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			calls.push([...args]);

			// getConflictedFiles: status --porcelain — no conflicts remain
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("");
			}
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// git commit --no-edit
			if (args[0] === "commit" && args[1] === "--no-edit") {
				return successResult();
			}
			return successResult();
		});

		await mergeService.completeMerge("/tmp/test-repo");

		// git add -A should have been called exactly once
		const addAllCalls = calls.filter(
			(c) => c[0] === "add" && c[1] === "-A",
		);
		expect(addAllCalls.length).toBe(1);

		// No individual file staging (add calls where second arg is a filename, not -A)
		const individualAddCalls = calls.filter(
			(c) => c[0] === "add" && c[1] !== "-A",
		);
		expect(individualAddCalls.length).toBe(0);
	});

	test("returns ok(false) when conflicts remain", async () => {
		const calls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			calls.push([...args]);

			// getConflictedFiles: status --porcelain — conflicts remain
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("UU file.ts");
			}
			return successResult();
		});

		const result = await mergeService.completeMerge("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}

		// No git add or git commit should have been called
		const addCalls = calls.filter((c) => c[0] === "add");
		const commitCalls = calls.filter((c) => c[0] === "commit");
		expect(addCalls.length).toBe(0);
		expect(commitCalls.length).toBe(0);
	});

	test("returns error when git add -A fails", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// getConflictedFiles: no conflicts
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("");
			}
			// git add -A fails
			if (args[0] === "add" && args[1] === "-A") {
				return err(createVcsError("COMMAND_FAILED", "git add -A failed"));
			}
			return successResult();
		});

		const result = await mergeService.completeMerge("/tmp/test-repo");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});

	test("returns ok(true) on successful merge commit", async () => {
		const calls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			calls.push([...args]);

			// getConflictedFiles: no conflicts
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("");
			}
			// git add -A
			if (args[0] === "add" && args[1] === "-A") {
				return successResult();
			}
			// git commit --no-edit
			if (args[0] === "commit" && args[1] === "--no-edit") {
				return successResult();
			}
			return successResult();
		});

		const result = await mergeService.completeMerge("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}

		// Verify commit was called
		const commitCalls = calls.filter(
			(c) => c[0] === "commit" && c[1] === "--no-edit",
		);
		expect(commitCalls.length).toBe(1);
	});
});

describe("MergeService.verifyMergeCompleted", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	test("returns true when HEAD is a merge commit", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git rev-parse HEAD^2 — succeeds (HEAD has second parent)
			if (args[0] === "rev-parse" && args[1] === "HEAD^2") {
				return successResult("abc123def456");
			}
			return successResult();
		});

		const result = await mergeService.verifyMergeCompleted("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
	});

	test("returns true when HEAD is a merge commit and advanced from preHeadSha", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git rev-parse HEAD^2 — succeeds
			if (args[0] === "rev-parse" && args[1] === "HEAD^2") {
				return successResult("abc123def456");
			}
			// git rev-parse HEAD — returns different SHA than preHeadSha
			if (args[0] === "rev-parse" && args[1] === "HEAD") {
				return successResult("newsha789");
			}
			return successResult();
		});

		const result = await mergeService.verifyMergeCompleted("/tmp/test-repo", "oldsha123");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
	});

	test("returns false when HEAD is not a merge commit", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git rev-parse HEAD^2 — fails (HEAD has no second parent)
			if (args[0] === "rev-parse" && args[1] === "HEAD^2") {
				return failedResult(128, "fatal: invalid revision 'HEAD^2'");
			}
			return successResult();
		});

		const result = await mergeService.verifyMergeCompleted("/tmp/test-repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}
	});

	test("returns false when HEAD hasn't changed from preHeadSha", async () => {
		const sameSha = "abc123def456";

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git rev-parse HEAD^2 — succeeds
			if (args[0] === "rev-parse" && args[1] === "HEAD^2") {
				return successResult("parent2sha");
			}
			// git rev-parse HEAD — returns same SHA as preHeadSha
			if (args[0] === "rev-parse" && args[1] === "HEAD") {
				return successResult(sameSha);
			}
			return successResult();
		});

		const result = await mergeService.verifyMergeCompleted("/tmp/test-repo", sameSha);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}
	});

	test("propagates git command error", async () => {
		const gitError = createVcsError("COMMAND_FAILED", "git command failed");

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// git rev-parse HEAD^2 — returns an err result
			if (args[0] === "rev-parse" && args[1] === "HEAD^2") {
				return err(gitError);
			}
			return successResult();
		});

		const result = await mergeService.verifyMergeCompleted("/tmp/test-repo");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("git command failed");
		}
	});
});

describe("Cleanup failure warning logging", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let existsSyncSpy: ReturnType<typeof spyOn>;
	let mkdirSyncSpy: ReturnType<typeof spyOn>;
	let rmSyncSpy: ReturnType<typeof spyOn>;
	let logWarnSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
		existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(true);
		mkdirSyncSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined as any);
		rmSyncSpy = spyOn(fs, "rmSync").mockReturnValue(undefined);
		logWarnSpy = spyOn(logger, "logWarn").mockImplementation(() => {});
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
		existsSyncSpy.mockRestore();
		mkdirSyncSpy.mockRestore();
		rmSyncSpy.mockRestore();
		logWarnSpy.mockRestore();
	});

	const noopOperation = async () => {};

	test("mergeInIsolatedWorktree — worktree prune failure in finally logs warning", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			// Pre-setup prune succeeds
			if (args[0] === "worktree" && args[1] === "prune") {
				// Distinguish pre-setup vs finally prune by tracking call count
				const pruneCalls = runGitCommandSpy.mock.calls.filter(
					(c: any) => c[0][0] === "worktree" && c[0][1] === "prune",
				);
				if (pruneCalls.length <= 1) {
					return successResult();
				}
				// Finally block prune fails
				return failedResult(1, "error: worktree prune failed");
			}
			if (args[0] === "worktree" && args[1] === "add") return successResult();
			if (args[0] === "worktree" && args[1] === "remove") return successResult();
			if (args[0] === "merge" && args[1] === "--ff-only") return successResult();
			if (args[0] === "branch" && args[1] === "-D") return successResult();
			return successResult();
		});

		await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		const warnCalls = logWarnSpy.mock.calls.filter(
			(c: any) => typeof c[0] === "string" && c[0].includes("Worktree prune failed during cleanup"),
		);
		expect(warnCalls.length).toBe(1);
	});

	test("mergeInIsolatedWorktree — branch -D failure in finally logs warning", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			if (args[0] === "worktree" && args[1] === "prune") return successResult();
			if (args[0] === "worktree" && args[1] === "add") return successResult();
			if (args[0] === "worktree" && args[1] === "remove") return successResult();
			if (args[0] === "merge" && args[1] === "--ff-only") return successResult();
			if (args[0] === "branch" && args[1] === "-D") {
				return failedResult(1, "error: branch not found");
			}
			return successResult();
		});

		await mergeService.mergeInIsolatedWorktree({
			workDir: "/tmp/test-repo",
			baseBranch: "main",
			operation: noopOperation,
		});

		const warnCalls = logWarnSpy.mock.calls.filter(
			(c: any) => typeof c[0] === "string" && c[0].includes("Failed to delete temp branch"),
		);
		expect(warnCalls.length).toBe(1);
	});

	test("safeMergeInWorktree — merge --abort failure logs warning and still returns conflicts", async () => {
		let mergeCallCount = 0;

		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			if (args[0] === "worktree" && args[1] === "prune") return successResult();
			if (args[0] === "worktree" && args[1] === "add") return successResult();
			if (args[0] === "worktree" && args[1] === "remove") return successResult();
			// Merge source branch — fails with conflicts
			if (args[0] === "merge" && args[1] !== "--abort") {
				return failedResult(1, "CONFLICT (content): Merge conflict in file.ts");
			}
			// merge --abort fails
			if (args[0] === "merge" && args[1] === "--abort") {
				return failedResult(128, "fatal: There is no merge to abort");
			}
			// getConflictedFiles: status --porcelain returns conflicted files
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("UU file.ts");
			}
			return successResult();
		});

		const result = await mergeService.safeMergeInWorktree({
			sourceBranch: "feature",
			targetBranch: "main",
			workDir: "/tmp/test-repo",
			runId: "run-1",
		});

		// Should still return conflict result successfully
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.hasConflicts).toBe(true);
			expect(result.value.conflictedFiles).toEqual(["file.ts"]);
		}

		// Should have logged a warning about merge --abort failure
		const warnCalls = logWarnSpy.mock.calls.filter(
			(c: any) => typeof c[0] === "string" && c[0].includes("merge --abort failed"),
		);
		expect(warnCalls.length).toBe(1);
	});

	test("safeMergeInWorktree — worktree remove failure in finally logs warning", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[], _workDir?: string) => {
			if (args[0] === "worktree" && args[1] === "prune") return successResult();
			if (args[0] === "worktree" && args[1] === "add") return successResult();
			// worktree remove fails
			if (args[0] === "worktree" && args[1] === "remove") {
				return failedResult(1, "error: failed to remove worktree");
			}
			// Merge succeeds
			if (args[0] === "merge") return successResult();
			// rev-parse HEAD for merge commit
			if (args[0] === "rev-parse" && args[1] === "HEAD") return successResult("abc123");
			return successResult();
		});

		const result = await mergeService.safeMergeInWorktree({
			sourceBranch: "feature",
			targetBranch: "main",
			workDir: "/tmp/test-repo",
			runId: "run-1",
		});

		// Should still return success
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.success).toBe(true);
		}

		// Should have logged a warning about worktree remove failure
		const warnCalls = logWarnSpy.mock.calls.filter(
			(c: any) => typeof c[0] === "string" && c[0].includes("Failed to remove merge worktree"),
		);
		expect(warnCalls.length).toBe(1);
	});
});

describe("classifyCheckoutError", () => {
	test("returns DIRTY_WORKTREE for stderr with 'local changes' and 'would be overwritten'", () => {
		const stderr =
			"error: Your local changes to the following files would be overwritten by checkout:\n  file.ts\nPlease commit your changes or stash them before you switch branches.";
		const error = classifyCheckoutError("feature-branch", stderr);

		expect(error.code).toBe("DIRTY_WORKTREE");
	});

	test("returns BRANCH_LOCKED for stderr with 'already used by worktree'", () => {
		const stderr =
			"fatal: 'feature-branch' is already used by worktree at '/tmp/worktrees/wt-1'";
		const error = classifyCheckoutError("feature-branch", stderr);

		expect(error.code).toBe("BRANCH_LOCKED");
	});

	test("returns BRANCH_LOCKED for stderr with 'already checked out at'", () => {
		const stderr =
			"fatal: 'feature-branch' is already checked out at '/tmp/worktrees/wt-1'";
		const error = classifyCheckoutError("feature-branch", stderr);

		expect(error.code).toBe("BRANCH_LOCKED");
	});

	test("returns BRANCH_NOT_FOUND for unrecognized error text", () => {
		const stderr = "error: pathspec 'nonexistent' did not match any file(s) known to git";
		const error = classifyCheckoutError("nonexistent", stderr);

		expect(error.code).toBe("BRANCH_NOT_FOUND");
	});

	test("includes branchName in the error message", () => {
		const error = classifyCheckoutError("my-branch", "some error");

		expect(error.message).toContain("my-branch");
	});

	test("preserves stderr in error context", () => {
		const stderr = "fatal: some checkout error";
		const error = classifyCheckoutError("branch", stderr);

		expect(error.context?.stderr).toBe(stderr);
	});
});

describe("createIntegrationBranch — checkout error classification", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function successResult(stdout = "", stderr = "") {
		return ok({
			exitCode: 0,
			stdout,
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	test("returns BRANCH_LOCKED when checkout fails with 'already used by worktree'", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(1, "fatal: 'main' is already used by worktree at '/tmp/wt'");
			}
			return successResult();
		});

		const result = await mergeService.createIntegrationBranch({
			groupNum: 1,
			baseBranch: "main",
			workDir: "/tmp/test-repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BRANCH_LOCKED");
		}
	});

	test("returns BRANCH_LOCKED when checkout fails with 'already checked out at'", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(1, "fatal: 'main' is already checked out at '/tmp/wt'");
			}
			return successResult();
		});

		const result = await mergeService.createIntegrationBranch({
			groupNum: 1,
			baseBranch: "main",
			workDir: "/tmp/test-repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BRANCH_LOCKED");
		}
	});

	test("returns DIRTY_WORKTREE when checkout fails with dirty worktree stderr", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(
					1,
					"error: Your local changes to the following files would be overwritten by checkout",
				);
			}
			return successResult();
		});

		const result = await mergeService.createIntegrationBranch({
			groupNum: 1,
			baseBranch: "main",
			workDir: "/tmp/test-repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("DIRTY_WORKTREE");
		}
	});

	test("returns BRANCH_NOT_FOUND for unrecognized checkout failure (existing behavior)", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(1, "error: pathspec 'main' did not match any file(s) known to git");
			}
			return successResult();
		});

		const result = await mergeService.createIntegrationBranch({
			groupNum: 1,
			baseBranch: "main",
			workDir: "/tmp/test-repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BRANCH_NOT_FOUND");
		}
	});
});

describe("mergeAgentBranch — checkout error classification", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let mergeService: MergeService;

	function failedResult(exitCode: number, stderr = "") {
		return ok({
			exitCode,
			stdout: "",
			stderr,
			timedOut: false,
			duration: 10,
		});
	}

	beforeEach(() => {
		mergeService = new MergeService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	test("returns BRANCH_LOCKED when target checkout fails with 'already checked out at'", async () => {
		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(1, "fatal: 'main' is already checked out at '/tmp/wt'");
			}
			return ok({ exitCode: 0, stdout: "", stderr: "", timedOut: false, duration: 10 });
		});

		const result = await mergeService.mergeAgentBranch({
			source: "feature",
			target: "main",
			workDir: "/tmp/test-repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BRANCH_LOCKED");
		}
	});
});
