/**
 * @fileoverview Tests for Git/VCS Operations
 *
 * Tests the branchExists and createWorktree functionality to ensure
 * worktree creation handles existing branches correctly.
 *
 * @module tests/git.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as gitCli from "../src/vcs/backends/git-cli.ts";
import {
	branchExists,
	createWorktree,
	ok,
	err,
	createVcsError,
} from "../src/vcs/index.ts";

/**
 * Helper to create a successful git command result
 */
function successResult(stdout = "", stderr = "") {
	return ok({
		exitCode: 0,
		stdout,
		stderr,
		timedOut: false,
		duration: 10,
	});
}

/**
 * Helper to create a failed git command result (non-zero exit)
 */
function failedResult(exitCode: number, stderr = "") {
	return ok({
		exitCode,
		stdout: "",
		stderr,
		timedOut: false,
		duration: 10,
	});
}

describe("branchExists", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	it("returns true when branch exists", async () => {
		// Mock git rev-parse --verify returning exit code 0 (branch exists)
		runGitCommandSpy.mockResolvedValue(successResult("abc123def456\n"));

		const result = await branchExists("feature-branch", "/test/repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(true);
		}
		expect(runGitCommandSpy).toHaveBeenCalledWith(
			["rev-parse", "--verify", "feature-branch"],
			"/test/repo",
		);
	});

	it("returns false when branch does not exist", async () => {
		// Mock git rev-parse --verify returning non-zero exit code (branch doesn't exist)
		runGitCommandSpy.mockResolvedValue(
			failedResult(1, "fatal: Needed a single revision\n"),
		);

		const result = await branchExists("nonexistent-branch", "/test/repo");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(false);
		}
		expect(runGitCommandSpy).toHaveBeenCalledWith(
			["rev-parse", "--verify", "nonexistent-branch"],
			"/test/repo",
		);
	});

	it("handles git command errors gracefully", async () => {
		// Mock git command failure
		const mockError = createVcsError("COMMAND_FAILED", "Git command failed", {
			context: { reason: "not a git repository" },
		});
		runGitCommandSpy.mockResolvedValue(err(mockError));

		const result = await branchExists("any-branch", "/invalid/path");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
			expect(result.error.message).toBe("Git command failed");
		}
	});
});

describe("createWorktree - handling existing branches", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	it("succeeds when branch does not exist (fresh creation)", async () => {
		// Mock successful git commands:
		// 1. worktree prune
		// 2. worktree add -B (creates new branch)
		runGitCommandSpy
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult("Preparing worktree\n"));

		const result = await createWorktree({
			task: "test-task",
			agent: "agent-1",
			baseBranch: "main",
			runId: "run-123",
			workDir: "/test/repo",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.branchName).toMatch(/^mh\/ex\/run-123/);
			expect(result.value.worktreePath).toContain("test-task");
			expect(result.value.worktreeId).toContain("test-task");
		}

		// Verify -B flag is used (force create/reset branch)
		const worktreeAddCall = runGitCommandSpy.mock.calls.find((call: unknown[]) =>
			Array.isArray(call[0]) && call[0].includes("worktree") && call[0].includes("add"),
		);
		expect(worktreeAddCall?.[0]).toContain("-B");
	});

	it("succeeds when branch already exists (uses -B flag to reset)", async () => {
		// Mock successful git commands with -B flag handling existing branch:
		// 1. worktree prune
		// 2. worktree add -B (resets existing branch)
		runGitCommandSpy
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult("Preparing worktree\nUpdating files: 100% done\n"));

		const result = await createWorktree({
			task: "existing-task",
			agent: "agent-2",
			baseBranch: "main",
			runId: "run-456",
			workDir: "/test/repo",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.branchName).toMatch(/^mh\/ex\/run-456/);
		}

		// Verify -B flag is used (this allows resetting existing branch)
		const worktreeAddCall = runGitCommandSpy.mock.calls.find((call: unknown[]) =>
			Array.isArray(call[0]) && call[0].includes("worktree") && call[0].includes("add"),
		);
		expect(worktreeAddCall?.[0]).toContain("-B");
	});

	it("handles worktree creation failure gracefully", async () => {
		// Mock git commands:
		// 1. worktree prune succeeds
		// 2. worktree add -B fails
		runGitCommandSpy
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(failedResult(1, "fatal: invalid reference: main\n"));

		const result = await createWorktree({
			task: "fail-task",
			agent: "agent-3",
			baseBranch: "nonexistent-base",
			runId: "run-789",
			workDir: "/test/repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
			expect(result.error.message).toContain("Failed to create worktree");
		}
	});
});

describe("createWorktree - integration scenarios", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

	it("handles worktree creation after cleanup (directory removed but branch exists)", async () => {
		// Scenario: Previous run created branch, worktree directory was removed,
		// but branch still exists. The -B flag should reset the branch and create worktree.
		runGitCommandSpy
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult("Preparing worktree (resetting branch)\n"));

		const result = await createWorktree({
			task: "resumed-task",
			agent: "agent-4",
			baseBranch: "main",
			runId: "run-resume",
			workDir: "/test/repo",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.branchName).toMatch(/^mh\/ex\/run-resume/);
		}

		// Verify that -B flag is used, allowing the operation to succeed
		// even though the branch already existed
		const worktreeAddCall = runGitCommandSpy.mock.calls.find((call: unknown[]) =>
			Array.isArray(call[0]) && call[0].includes("worktree") && call[0].includes("add"),
		);
		expect(worktreeAddCall).toBeDefined();
		expect(worktreeAddCall?.[0]).toContain("-B");
	});

	it("handles concurrent worktree creation attempts", async () => {
		// Both calls succeed because -B flag handles branch creation atomically
		runGitCommandSpy
			// First worktree: prune + add
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult("Preparing worktree\n"))
			// Second worktree: prune + add
			.mockResolvedValueOnce(successResult())
			.mockResolvedValueOnce(successResult("Preparing worktree\n"));

		const result1 = await createWorktree({
			task: "concurrent-1",
			agent: "agent-5",
			baseBranch: "main",
			runId: "run-concurrent",
			workDir: "/test/repo",
		});

		const result2 = await createWorktree({
			task: "concurrent-2",
			agent: "agent-6",
			baseBranch: "main",
			runId: "run-concurrent",
			workDir: "/test/repo",
		});

		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);
	});

	it("handles prune failure gracefully", async () => {
		// If prune command fails (returns err), createWorktree should propagate the error
		const mockError = createVcsError("COMMAND_FAILED", "Prune failed");
		runGitCommandSpy.mockResolvedValueOnce(err(mockError));

		const result = await createWorktree({
			task: "prune-fail-task",
			agent: "agent-7",
			baseBranch: "main",
			runId: "run-prune-fail",
			workDir: "/test/repo",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("COMMAND_FAILED");
		}
	});
});
