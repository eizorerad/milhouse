/**
 * Tests for git utilities.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, getCommittedTaskNumbers, parseTaskNumbersFromLog } from "../src/git.ts";
import type { Issue, IssueGroup } from "../src/types.ts";

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

describe("getCommittedTaskNumbers", () => {
	const tempDirs: string[] = [];

	async function setupRepo(): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "mh-git-log-test-"));
		tempDirs.push(dir);
		await shell(["git", "init", "--initial-branch=main"], dir);
		await shell(["git", "config", "user.email", "test@test.com"], dir);
		await shell(["git", "config", "user.name", "Test"], dir);
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

	it("matches the issue id literally instead of as a regex character class", async () => {
		const dir = await setupRepo();

		await shell(["git", "commit", "--allow-empty", "-m", "[P-aaa] Task 1: correct issue"], dir);
		await shell(["git", "commit", "--allow-empty", "-m", "[Q-bbb] Task 2: unrelated issue"], dir);

		const committed = await getCommittedTaskNumbers("P-zzz", "HEAD", dir);

		expect(committed).toEqual(new Set());
	});
});
