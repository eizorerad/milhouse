/**
 * Regression tests for the resolve flow.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execute } from "../src/engine.ts";
import type { ResolveGitOps } from "../src/resolve.ts";
import type { Config } from "../src/types.ts";

const mockExecute = mock<typeof execute>();
const mockAbortMerge = mock<(cwd: string) => Promise<void>>();
const mockCleanupWorktree = mock<(worktreePath: string, baseDir: string) => Promise<boolean>>();
const mockCompleteMerge = mock<(cwd: string) => Promise<boolean>>();
const mockCreateIntegrationWorktree =
	mock<(branchName: string, baseDir: string) => Promise<string>>();
const mockIsWorkingTreeDirty = mock<(baseDir: string) => Promise<boolean>>();
const mockListUnmergedBranches = mock<(baseDir: string) => Promise<string[]>>();
const mockTryMerge =
	mock<(branch: string, cwd: string) => Promise<{ ok: boolean; conflictFiles: string[] }>>();

const { runResolve } = await import("../src/resolve.ts");

describe("runResolve", () => {
	let tempDir: string;
	let originalCwd: string;
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "milhouse-resolve-flow-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);

		mockExecute.mockReset();
		mockAbortMerge.mockReset();
		mockCleanupWorktree.mockReset();
		mockCompleteMerge.mockReset();
		mockCreateIntegrationWorktree.mockReset();
		mockIsWorkingTreeDirty.mockReset();
		mockListUnmergedBranches.mockReset();
		mockTryMerge.mockReset();

		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("counts an AI-resolved merge as success and records the resolution summary", async () => {
		const config = { engine: "claude", model: "sonnet" } as Config;

		mockIsWorkingTreeDirty.mockResolvedValue(false);
		mockListUnmergedBranches.mockResolvedValue(["mh/issue-1"]);
		mockCreateIntegrationWorktree.mockResolvedValue("/tmp/integration");
		mockTryMerge.mockResolvedValue({ ok: false, conflictFiles: ["src/app.ts"] });
		mockExecute.mockResolvedValue({
			result: {
				response: "Resolved by keeping both changes and updating the call site.",
				inputTokens: 10,
				outputTokens: 20,
			},
			proc: { kill: () => {}, exited: Promise.resolve(0) },
		});
		mockCompleteMerge.mockResolvedValue(true);
		mockCleanupWorktree.mockResolvedValue(true);

		const gitOps: ResolveGitOps = {
			abortMerge: mockAbortMerge,
			cleanupWorktree: mockCleanupWorktree,
			completeMerge: mockCompleteMerge,
			createIntegrationWorktree: mockCreateIntegrationWorktree,
			isWorkingTreeDirty: mockIsWorkingTreeDirty,
			listUnmergedBranches: mockListUnmergedBranches,
			tryMerge: mockTryMerge,
		};

		await runResolve(config, mockExecute, gitOps);

		const stdout = logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

		expect(mockExecute).toHaveBeenCalledTimes(1);
		expect(mockCompleteMerge).toHaveBeenCalledTimes(1);
		expect(mockAbortMerge).not.toHaveBeenCalled();
		expect(stdout).toContain("mh/issue-1");
		expect(stdout).toContain("Result: 1 merged, 0 failed");
		expect(stdout).toContain("AI resolved conflicts in: src/app.ts");
	});
});
