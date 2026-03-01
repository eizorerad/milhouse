/**
 * @fileoverview Tests for rebase-merge abort behavior after merge failures.
 *
 * Validates that the correct abort function (abortMerge vs abortRebase) is called
 * depending on whether the failure occurs during a merge or rebase context.
 *
 * @module execution/merge/rebase-merge.test
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as mergeService from "../../vcs/services/merge-service.ts";
import * as branchService from "../../vcs/services/branch-service.ts";
import * as conflictResolution from "../runtime/conflict-resolution.ts";
import * as logger from "../../ui/logger.ts";
import { mergeCompletedBranches } from "./rebase-merge.ts";
import type { AIEngine } from "../../engines/types.ts";

describe("mergeCompletedBranches — abort behavior after merge failure", () => {
	let rebaseBranchSpy: ReturnType<typeof spyOn>;
	let mergeAgentBranchSpy: ReturnType<typeof spyOn>;
	let abortMergeSpy: ReturnType<typeof spyOn>;
	let abortRebaseSpy: ReturnType<typeof spyOn>;
	let branchExistsSpy: ReturnType<typeof spyOn>;
	let deleteLocalBranchSpy: ReturnType<typeof spyOn>;
	let resolveConflictsSpy: ReturnType<typeof spyOn>;
	let createMergeConflictInfoSpy: ReturnType<typeof spyOn>;

	const fakeEngine = { name: "test", cliCommand: "test" } as AIEngine;
	const workDir = "/tmp/test-repo";
	const targetBranch = "main";

	beforeEach(() => {
		// Suppress logger output
		spyOn(logger, "logInfo").mockImplementation(() => {});
		spyOn(logger, "logDebug").mockImplementation(() => {});
		spyOn(logger, "logError").mockImplementation(() => {});
		spyOn(logger, "logWarn").mockImplementation(() => {});
		spyOn(logger, "logSuccess").mockImplementation(() => {});

		// Mock branch-service
		branchExistsSpy = spyOn(branchService, "branchExists").mockResolvedValue({
			ok: true,
			value: true,
		});
		deleteLocalBranchSpy = spyOn(branchService, "deleteLocalBranch").mockResolvedValue({
			ok: true,
			value: undefined as any,
		});

		// Mock abort functions — these are the ones we're testing
		abortMergeSpy = spyOn(mergeService, "abortMerge").mockResolvedValue({
			ok: true,
			value: undefined,
		});
		abortRebaseSpy = spyOn(mergeService, "abortRebase").mockResolvedValue({
			ok: true,
			value: undefined,
		});

		// Mock conflict resolution helpers
		createMergeConflictInfoSpy = spyOn(conflictResolution, "createMergeConflictInfo").mockReturnValue([
			{ filePath: "file.ts", sourceBranch: "feature", targetBranch: "main" },
		] as any);
	});

	afterEach(() => {
		mock.restore();
	});

	test("calls abortMerge (not abortRebase) when merge fails after clean rebase (baseline, line 219)", async () => {
		// Clean rebase succeeds
		rebaseBranchSpy = spyOn(mergeService, "rebaseBranch").mockResolvedValue({
			ok: true,
			value: { success: true, hasConflicts: false, conflictedFiles: [] },
		});

		// Merge after rebase fails
		mergeAgentBranchSpy = spyOn(mergeService, "mergeAgentBranch").mockResolvedValue({
			ok: true,
			value: { success: false, hasConflicts: false, conflictedFiles: [] },
		});

		const results = await mergeCompletedBranches({
			branches: ["feature"],
			targetBranch,
			engine: fakeEngine,
			workDir,
			branchToIssueInfo: new Map([["feature", { id: "1", title: "Test" }]]),
			maxRetries: 1,
		});

		expect(abortMergeSpy).toHaveBeenCalledWith(workDir);
		expect(abortRebaseSpy).not.toHaveBeenCalled();
		expect(results[0].success).toBe(false);
	});

	test("calls abortMerge (not abortRebase) when merge fails after AI conflict resolution", async () => {
		// Rebase has conflicts
		rebaseBranchSpy = spyOn(mergeService, "rebaseBranch").mockResolvedValue({
			ok: true,
			value: {
				success: false,
				hasConflicts: true,
				conflictedFiles: ["file.ts"],
			},
		});

		// AI resolves conflicts successfully
		resolveConflictsSpy = spyOn(conflictResolution, "resolveConflictsWithEngine").mockResolvedValue({
			success: true,
			resolvedFiles: ["file.ts"],
			unresolvedFiles: [],
			tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		});

		// Merge after AI resolution fails
		mergeAgentBranchSpy = spyOn(mergeService, "mergeAgentBranch").mockResolvedValue({
			ok: true,
			value: { success: false, hasConflicts: false, conflictedFiles: [] },
		});

		const results = await mergeCompletedBranches({
			branches: ["feature"],
			targetBranch,
			engine: fakeEngine,
			workDir,
			branchToIssueInfo: new Map([["feature", { id: "1", title: "Test" }]]),
			maxRetries: 1,
		});

		// After successful rebase + failed merge, we are in merge context.
		// abortMerge should be called (not abortRebase).
		expect(abortMergeSpy).toHaveBeenCalledWith(workDir);
		expect(abortRebaseSpy).not.toHaveBeenCalled();
		expect(results[0].success).toBe(false);
	});
});
