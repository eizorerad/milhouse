/**
 * @fileoverview Tests for conflict resolution — auto-detection of git state
 *
 * Tests that `detectConflictMode` correctly identifies rebase vs merge state,
 * and that `resolveConflictsWithEngine` + `buildConflictResolutionPrompt`
 * respond appropriately when mode is 'auto'.
 *
 * @module execution/runtime/conflict-resolution.test
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as mergeService from "../../vcs/services/merge-service.ts";
import * as gitCli from "../../vcs/backends/git-cli.ts";
import * as logger from "../../ui/logger.ts";
import { ok } from "../../vcs/types.ts";
import {
	buildConflictResolutionPrompt,
	detectConflictMode,
	buildSimpleConflictPrompt,
} from "./conflict-resolution.ts";

// ============================================================================
// detectConflictMode
// ============================================================================

describe("detectConflictMode", () => {
	let isRebaseInProgressSpy: ReturnType<typeof spyOn>;
	let isMergeInProgressSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spyOn(logger, "logDebug").mockImplementation(() => {});
		isRebaseInProgressSpy = spyOn(mergeService, "isRebaseInProgress");
		isMergeInProgressSpy = spyOn(mergeService, "isMergeInProgress");
	});

	afterEach(() => {
		mock.restore();
	});

	test("returns 'rebase' when REBASE_HEAD is active", async () => {
		isRebaseInProgressSpy.mockResolvedValue(ok(true));
		isMergeInProgressSpy.mockResolvedValue(ok(false));

		const mode = await detectConflictMode("/tmp/repo");
		expect(mode).toBe("rebase");
	});

	test("returns 'merge' when MERGE_HEAD is active and no rebase", async () => {
		isRebaseInProgressSpy.mockResolvedValue(ok(false));
		isMergeInProgressSpy.mockResolvedValue(ok(true));

		const mode = await detectConflictMode("/tmp/repo");
		expect(mode).toBe("merge");
	});

	test("returns 'merge' when neither rebase nor merge is active (safe fallback)", async () => {
		isRebaseInProgressSpy.mockResolvedValue(ok(false));
		isMergeInProgressSpy.mockResolvedValue(ok(false));

		const mode = await detectConflictMode("/tmp/repo");
		expect(mode).toBe("merge");
	});

	test("prefers rebase when both rebase and merge appear active (edge case)", async () => {
		isRebaseInProgressSpy.mockResolvedValue(ok(true));
		isMergeInProgressSpy.mockResolvedValue(ok(true));

		const mode = await detectConflictMode("/tmp/repo");
		// Rebase is checked first and takes priority
		expect(mode).toBe("rebase");
	});

	test("returns 'merge' when isRebaseInProgress errors", async () => {
		isRebaseInProgressSpy.mockResolvedValue({
			ok: false,
			error: { code: "COMMAND_FAILED", message: "git not found" },
		} as any);
		isMergeInProgressSpy.mockResolvedValue(ok(true));

		const mode = await detectConflictMode("/tmp/repo");
		expect(mode).toBe("merge");
	});

	test("returns 'merge' when both queries error (safe fallback)", async () => {
		isRebaseInProgressSpy.mockResolvedValue({
			ok: false,
			error: { code: "COMMAND_FAILED", message: "err" },
		} as any);
		isMergeInProgressSpy.mockResolvedValue({
			ok: false,
			error: { code: "COMMAND_FAILED", message: "err" },
		} as any);

		const mode = await detectConflictMode("/tmp/repo");
		expect(mode).toBe("merge");
	});
});

// ============================================================================
// buildConflictResolutionPrompt — mode-aware output
// ============================================================================

describe("buildConflictResolutionPrompt — mode-aware", () => {
	const conflicts = [
		{
			filePath: "src/app.ts",
			sourceBranch: "feature-x",
			targetBranch: "main",
			hasMarkers: true,
		},
	];

	test("merge mode: includes 'merge' context and git commit --no-edit instruction", () => {
		const prompt = buildConflictResolutionPrompt(conflicts, undefined, undefined, "merge");

		expect(prompt).toContain("merge");
		expect(prompt).toContain("git commit --no-edit");
		expect(prompt).toContain("Merging branch");
	});

	test("rebase mode: includes 'rebase' context and git rebase --continue instruction", () => {
		const prompt = buildConflictResolutionPrompt(conflicts, undefined, undefined, "rebase");

		expect(prompt).toContain("rebase");
		expect(prompt).toContain("git rebase --continue");
		expect(prompt).toContain("Rebasing branch");
	});

	test("prompt includes REBASE_HEAD detection instruction for AI self-verification", () => {
		const prompt = buildConflictResolutionPrompt(conflicts, undefined, undefined, "merge");

		// The prompt should tell the AI to verify git state itself
		expect(prompt).toContain("REBASE_HEAD");
		expect(prompt).toContain("git rev-parse --verify REBASE_HEAD");
	});

	test("prompt includes issue context when provided", () => {
		const prompt = buildConflictResolutionPrompt(
			conflicts,
			undefined,
			{ id: "P-abc123", title: "Fix memory leak in parser" },
			"merge",
		);

		expect(prompt).toContain("P-abc123");
		expect(prompt).toContain("Fix memory leak in parser");
	});

	test("default mode (no arg) produces merge prompt", () => {
		const prompt = buildConflictResolutionPrompt(conflicts);
		expect(prompt).toContain("merge");
		expect(prompt).toContain("Merging branch");
	});
});

// ============================================================================
// buildSimpleConflictPrompt — adaptive instruction
// ============================================================================

describe("buildSimpleConflictPrompt — adaptive", () => {
	test("includes REBASE_HEAD detection for AI self-verification", () => {
		const prompt = buildSimpleConflictPrompt("file.ts", "feature");

		expect(prompt).toContain("REBASE_HEAD");
		expect(prompt).toContain("git rebase --continue");
		expect(prompt).toContain("git commit --no-edit");
	});
});
