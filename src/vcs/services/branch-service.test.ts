/**
 * @fileoverview Unit Tests for VCS Branch Service
 *
 * Tests the BranchService class and related functionality.
 *
 * @module vcs/services/branch-service.test
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as gitCli from "../backends/git-cli";
import { type VcsError, createVcsError, ok } from "../types";
import { BranchService } from "./branch-service";

/**
 * Helper function to check if an error is a VcsError
 * This mirrors the logic used in the catch block of createTaskBranch
 */
function isVcsError(error: unknown): error is VcsError {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		"message" in error &&
		typeof (error as { code: unknown }).code === "string" &&
		typeof (error as { message: unknown }).message === "string"
	);
}

describe("VcsError type guard", () => {
	test("identifies valid VcsError", () => {
		const vcsError = createVcsError("COMMAND_FAILED", "Test error message");

		expect(isVcsError(vcsError)).toBe(true);
	});

	test("identifies VcsError with context", () => {
		const vcsError = createVcsError("BRANCH_NOT_FOUND", "Branch not found", {
			context: { branch: "feature/test" },
		});

		expect(isVcsError(vcsError)).toBe(true);
	});

	test("identifies VcsError with cause", () => {
		const originalError = new Error("Original error");
		const vcsError = createVcsError("UNKNOWN_ERROR", "Wrapped error", {
			cause: originalError,
		});

		expect(isVcsError(vcsError)).toBe(true);
	});

	test("rejects null", () => {
		expect(isVcsError(null)).toBe(false);
	});

	test("rejects undefined", () => {
		expect(isVcsError(undefined)).toBe(false);
	});

	test("rejects primitive values", () => {
		expect(isVcsError("error string")).toBe(false);
		expect(isVcsError(123)).toBe(false);
		expect(isVcsError(true)).toBe(false);
	});

	test("rejects Error instances without VcsError shape", () => {
		const standardError = new Error("Standard error");

		expect(isVcsError(standardError)).toBe(false);
	});

	test("rejects objects with only code property", () => {
		const partialObject = { code: "COMMAND_FAILED" };

		expect(isVcsError(partialObject)).toBe(false);
	});

	test("rejects objects with only message property", () => {
		const partialObject = { message: "Some message" };

		expect(isVcsError(partialObject)).toBe(false);
	});

	test("rejects objects with non-string code", () => {
		const invalidObject = { code: 123, message: "Some message" };

		expect(isVcsError(invalidObject)).toBe(false);
	});

	test("rejects objects with non-string message", () => {
		const invalidObject = { code: "COMMAND_FAILED", message: 123 };

		expect(isVcsError(invalidObject)).toBe(false);
	});

	test("accepts objects with code and message strings (duck typing)", () => {
		const duckTypedObject = {
			code: "CUSTOM_CODE",
			message: "Custom message",
		};

		expect(isVcsError(duckTypedObject)).toBe(true);
	});

	test("accepts objects with extra properties", () => {
		const extendedObject = {
			code: "COMMAND_FAILED",
			message: "Extended error",
			customProp: "extra data",
			nested: { data: true },
		};

		expect(isVcsError(extendedObject)).toBe(true);
	});
});

describe("BranchService.createTaskBranch", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;
	let branchService: BranchService;

	beforeEach(() => {
		branchService = new BranchService();
		runGitCommandSpy = spyOn(gitCli, "runGitCommand");
	});

	afterEach(() => {
		runGitCommandSpy.mockRestore();
	});

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

	test("pops stash exactly once on success with uncommitted changes", async () => {
		const stashPopCalls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// Track stash pop calls
			if (args[0] === "stash" && args[1] === "pop") {
				stashPopCalls.push(args);
			}

			// getCurrentBranch
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
				return successResult("main");
			}

			// hasUncommittedChanges - return some changes
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("M  some-file.ts");
			}

			// stash push
			if (args[0] === "stash" && args[1] === "push") {
				return successResult();
			}

			// checkout base branch
			if (args[0] === "checkout" && args[1] === "main") {
				return successResult();
			}

			// pull
			if (args[0] === "pull") {
				return successResult();
			}

			// branchExists (rev-parse --verify)
			if (args[0] === "rev-parse" && args[1] === "--verify") {
				return failedResult(128); // Branch doesn't exist
			}

			// create branch
			if (args[0] === "checkout" && args[1] === "-b") {
				return successResult();
			}

			// stash pop
			if (args[0] === "stash" && args[1] === "pop") {
				return successResult();
			}

			return successResult();
		});

		const result = await branchService.createTaskBranch({
			task: "test-task",
			baseBranch: "main",
			workDir: "/tmp/test",
			stashChanges: true,
		});

		expect(result.ok).toBe(true);
		expect(stashPopCalls.length).toBe(1);
	});

	test("pops stash exactly once on failure after stashing", async () => {
		const stashPopCalls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// Track stash pop calls
			if (args[0] === "stash" && args[1] === "pop") {
				stashPopCalls.push(args);
			}

			// getCurrentBranch
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
				return successResult("main");
			}

			// hasUncommittedChanges - return some changes
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("M  some-file.ts");
			}

			// stash push
			if (args[0] === "stash" && args[1] === "push") {
				return successResult();
			}

			// checkout base branch - FAIL to trigger error path
			if (args[0] === "checkout" && args[1] === "main") {
				return failedResult(1, "error: cannot checkout");
			}

			// stash pop - should only be called once
			if (args[0] === "stash" && args[1] === "pop") {
				return successResult();
			}

			return successResult();
		});

		const result = await branchService.createTaskBranch({
			task: "test-task",
			baseBranch: "main",
			workDir: "/tmp/test",
			stashChanges: true,
		});

		expect(result.ok).toBe(false);
		expect(stashPopCalls.length).toBe(1);
	});

	test("does not pop stash when no changes were stashed", async () => {
		const stashPopCalls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// Track stash pop calls
			if (args[0] === "stash" && args[1] === "pop") {
				stashPopCalls.push(args);
			}

			// getCurrentBranch
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
				return successResult("main");
			}

			// hasUncommittedChanges - NO changes
			if (args[0] === "status" && args[1] === "--porcelain") {
				return successResult("");
			}

			// checkout base branch
			if (args[0] === "checkout" && args[1] === "main") {
				return successResult();
			}

			// pull
			if (args[0] === "pull") {
				return successResult();
			}

			// branchExists
			if (args[0] === "rev-parse" && args[1] === "--verify") {
				return failedResult(128);
			}

			// create branch
			if (args[0] === "checkout" && args[1] === "-b") {
				return successResult();
			}

			return successResult();
		});

		const result = await branchService.createTaskBranch({
			task: "test-task",
			baseBranch: "main",
			workDir: "/tmp/test",
			stashChanges: true,
		});

		expect(result.ok).toBe(true);
		expect(stashPopCalls.length).toBe(0);
	});

	test("does not stash or pop when stashChanges is false", async () => {
		const stashCalls: string[][] = [];

		runGitCommandSpy.mockImplementation(async (args: string[]) => {
			// Track all stash calls
			if (args[0] === "stash") {
				stashCalls.push(args);
			}

			// getCurrentBranch
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
				return successResult("main");
			}

			// checkout base branch
			if (args[0] === "checkout" && args[1] === "main") {
				return successResult();
			}

			// pull
			if (args[0] === "pull") {
				return successResult();
			}

			// branchExists
			if (args[0] === "rev-parse" && args[1] === "--verify") {
				return failedResult(128);
			}

			// create branch
			if (args[0] === "checkout" && args[1] === "-b") {
				return successResult();
			}

			return successResult();
		});

		const result = await branchService.createTaskBranch({
			task: "test-task",
			baseBranch: "main",
			workDir: "/tmp/test",
			stashChanges: false,
		});

		expect(result.ok).toBe(true);
		expect(stashCalls.length).toBe(0);
	});
});
