/**
 * Git — worktree + merge. Three functions.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IssueGroup, PhaseResult } from "./types.ts";
import { log } from "./ui.ts";

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Create an isolated worktree for an issue group.
 * Returns the worktree path.
 */
export async function createWorktree(
	issueGroup: IssueGroup,
	baseDir: string,
): Promise<string> {
	const branch = `mh/${issueGroup.issueId}`;
	const worktreePath = join(baseDir, ".milhouse", "work", "worktrees", issueGroup.issueId);

	// Clean up if exists
	if (existsSync(worktreePath)) {
		await git(["worktree", "remove", "--force", worktreePath], baseDir);
	}
	await git(["worktree", "prune"], baseDir);

	const result = await git(["worktree", "add", "-b", branch, worktreePath], baseDir);
	if (!result.ok) {
		throw new Error(`Failed to create worktree for ${issueGroup.issueId}: ${result.stderr}`);
	}

	log.debug(`[git] Created worktree: ${worktreePath} (branch: ${branch})`);
	return worktreePath;
}

/**
 * Cleanup a worktree after execution.
 */
export async function cleanupWorktree(
	worktreePath: string,
	baseDir: string,
): Promise<void> {
	const result = await git(["worktree", "remove", "--force", worktreePath], baseDir);
	if (!result.ok) {
		// Fallback: manual removal
		try {
			rmSync(worktreePath, { recursive: true, force: true });
		} catch {
			log.warn(`Failed to remove worktree: ${worktreePath}`);
		}
	}
	await git(["worktree", "prune"], baseDir);
}

/**
 * Merge completed branches back to base branch, then cleanup.
 */
export async function mergeCompletedBranches(
	results: PhaseResult[],
	baseDir: string,
): Promise<void> {
	const branches = results
		.filter((r) => r.success)
		.map((r) => `mh/${(r.item as IssueGroup).issueId}`);

	if (branches.length === 0) return;

	log.info(`Merging ${branches.length} branch(es)...`);

	for (const branch of branches) {
		const result = await git(
			["merge", "--no-ff", branch, "-m", `Merge ${branch}`],
			baseDir,
		);
		if (result.ok) {
			log.success(`Merged ${branch}`);
		} else {
			log.warn(`Merge failed for ${branch}, aborting and skipping`);
			await git(["merge", "--abort"], baseDir);
		}
	}

	// Cleanup merged branches
	for (const branch of branches) {
		await git(["branch", "-D", branch], baseDir);
	}
}

/**
 * Get current branch name.
 */
export async function getCurrentBranch(baseDir: string): Promise<string> {
	const result = await git(["branch", "--show-current"], baseDir);
	return result.stdout || "main";
}
