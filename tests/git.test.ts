/**
 * Tests for git utilities.
 */

import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskNumbersFromLog, createWorktree } from "../src/git.ts";
import type { IssueGroup, Issue } from "../src/types.ts";

describe("parseTaskNumbersFromLog", () => {
	it("parses multiple task commits correctly", () => {
		const log = [
			"abc1234 [P-abc123] Task 1: Add utility function",
			"def5678 [P-abc123] Task 2: Update tests",
			"ghi9012 [P-abc123] Task 3: Fix linting",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 2, 3]));
	});

	it("ignores unrelated commits", () => {
		const log = [
			"abc1234 [P-abc123] Task 1: Add utility function",
			"def5678 Merge branch 'main'",
			"ghi9012 fix: unrelated commit",
			"jkl3456 [P-abc123] Task 3: Fix linting",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 3]));
	});

	it("handles empty log", () => {
		expect(parseTaskNumbersFromLog("")).toEqual(new Set());
	});

	it("handles duplicate task numbers", () => {
		const log = [
			"abc1234 [P-abc123] Task 2: First attempt",
			"def5678 [P-abc123] Task 2: Second attempt",
			"ghi9012 [P-abc123] Task 1: Done",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 2]));
	});
});

// ─── createWorktree tests ───────────────────────────────────────────────────

async function shell(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

function makeIssueGroup(issueId: string): IssueGroup {
	return {
		issueId,
		issue: { id: issueId } as Issue,
		tasks: [],
	};
}

describe("createWorktree", () => {
	const tempDirs: string[] = [];

	async function setupRepo(): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "mh-git-test-"));
		tempDirs.push(dir);
		await shell(["git", "init", "--initial-branch=main"], dir);
		await shell(["git", "config", "user.email", "test@test.com"], dir);
		await shell(["git", "config", "user.name", "Test"], dir);
		// Need at least one commit for worktree to work
		await shell(["git", "commit", "--allow-empty", "-m", "init"], dir);
		return dir;
	}

	afterAll(() => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("creates a new branch when none exists (fresh run)", async () => {
		const baseDir = await setupRepo();
		const group = makeIssueGroup("test-fresh");

		const wtPath = await createWorktree(group, baseDir);

		expect(existsSync(wtPath)).toBe(true);
		// Verify branch was created
		const branches = await shell(["git", "branch", "--list", "mh/test-fresh"], baseDir);
		expect(branches).toContain("mh/test-fresh");

		// Cleanup
		await shell(["git", "worktree", "remove", "--force", wtPath], baseDir);
	});

	it("reuses an existing branch without error (resume after prior run)", async () => {
		const baseDir = await setupRepo();
		const group = makeIssueGroup("test-reuse");

		// Simulate a prior run: create the branch manually
		await shell(["git", "branch", "mh/test-reuse"], baseDir);

		// Verify branch already exists
		const branchesBefore = await shell(["git", "branch", "--list", "mh/test-reuse"], baseDir);
		expect(branchesBefore).toContain("mh/test-reuse");

		// createWorktree should succeed despite existing branch
		const wtPath = await createWorktree(group, baseDir);

		expect(existsSync(wtPath)).toBe(true);

		// Cleanup
		await shell(["git", "worktree", "remove", "--force", wtPath], baseDir);
	});
});
