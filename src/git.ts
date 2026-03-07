/**
 * Git — worktree + merge. Three functions.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
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

	const existingBranch = await branchExists(branch, baseDir);
	const result = existingBranch
		? await git(["worktree", "add", worktreePath, branch], baseDir)
		: await git(["worktree", "add", "-b", branch, worktreePath], baseDir);
	if (!result.ok) {
		throw new Error(`Failed to create worktree for ${issueGroup.issueId}: ${result.stderr}`);
	}

	log.debug(`[git] Created worktree: ${worktreePath} (branch: ${branch}, reused: ${existingBranch})`);
	return worktreePath;
}

const CLEANUP_MAX_RETRIES = 3;
const CLEANUP_RETRY_DELAY_MS = 2000;

function isEBUSY(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EBUSY";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cleanup a worktree after execution.
 * Returns true if cleanup succeeded, false otherwise.
 * On Windows, retries with delay on EBUSY and uses rename-then-delete fallback.
 */
export async function cleanupWorktree(
	worktreePath: string,
	baseDir: string,
): Promise<boolean> {
	const isWindows = process.platform === "win32";

	for (let attempt = 0; attempt < CLEANUP_MAX_RETRIES; attempt++) {
		// First try: git worktree remove --force
		const result = await git(["worktree", "remove", "--force", worktreePath], baseDir);
		if (result.ok) {
			await git(["worktree", "prune"], baseDir);
			return true;
		}

		// Fallback: manual removal (with rename-then-delete on Windows)
		try {
			if (isWindows) {
				const tempPath = `${worktreePath}._removing_${Date.now()}`;
				renameSync(worktreePath, tempPath);
				rmSync(tempPath, { recursive: true, force: true });
			} else {
				rmSync(worktreePath, { recursive: true, force: true });
			}
			await git(["worktree", "prune"], baseDir);
			return true;
		} catch (err) {
			if (isEBUSY(err) && attempt < CLEANUP_MAX_RETRIES - 1) {
				log.debug(`[git] EBUSY on worktree cleanup, retrying in ${CLEANUP_RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${CLEANUP_MAX_RETRIES})`);
				await sleep(CLEANUP_RETRY_DELAY_MS);
				continue;
			}
			// Non-EBUSY error or final attempt
			if (attempt === CLEANUP_MAX_RETRIES - 1) {
				log.warn(`Failed to remove worktree after ${CLEANUP_MAX_RETRIES} attempts: ${worktreePath}`);
			}
		}
	}

	return false;
}

/**
 * Retry cleanup of worktree paths that failed during the run.
 * Called after merge phase to give file locks more time to release.
 */
export async function cleanupDeferredWorktrees(
	paths: string[],
	baseDir: string,
): Promise<void> {
	if (paths.length === 0) return;

	log.info(`Retrying cleanup of ${paths.length} deferred worktree(s)...`);

	for (const worktreePath of paths) {
		if (!existsSync(worktreePath)) continue;
		const ok = await cleanupWorktree(worktreePath, baseDir);
		if (!ok) {
			log.warn(`Deferred cleanup still failed: ${worktreePath} — manual removal may be needed`);
		}
	}
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

	const mergedBranches: string[] = [];
	for (const branch of branches) {
		const result = await git(
			["merge", "--no-ff", branch, "-m", `Merge ${branch}`],
			baseDir,
		);
		if (result.ok) {
			log.success(`Merged ${branch}`);
			mergedBranches.push(branch);
		} else {
			log.warn(`Merge failed for ${branch}, aborting and skipping. Branch preserved.`);
			await git(["merge", "--abort"], baseDir);
		}
	}

	if (mergedBranches.length < branches.length) {
		const failed = branches.length - mergedBranches.length;
		log.warn(`${failed} branch(es) failed to merge. Run: milhouse --resolve`);
	}

	// Cleanup only successfully merged branches
	for (const branch of mergedBranches) {
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

/**
 * Parse task numbers from git log output.
 * Matches commit messages like `[ISSUE-ID] Task N: title`.
 */
export function parseTaskNumbersFromLog(logOutput: string): Set<number> {
	const result = new Set<number>();
	const regex = /\[.+?\]\s+Task\s+(\d+):/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(logOutput)) !== null) {
		result.add(Number(match[1]));
	}
	return result;
}

/**
 * Get task numbers that have commits on a branch for a given issue.
 */
export async function getCommittedTaskNumbers(
	issueId: string,
	branch: string,
	cwd: string,
): Promise<Set<number>> {
	const result = await git(
		["log", branch, "--oneline", `--grep=[${issueId}]`],
		cwd,
	);
	if (!result.ok) return new Set();
	return parseTaskNumbersFromLog(result.stdout);
}

/**
 * Check if a branch exists.
 */
export async function branchExists(branch: string, cwd: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd);
	return result.ok;
}

// ─── Merge Resolver Helpers ─────────────────────────────────────────────────

/**
 * List mh/* branches that are NOT merged into HEAD.
 */
export async function listUnmergedBranches(baseDir: string): Promise<string[]> {
	const result = await git(["branch", "--list", "mh/*", "--no-merged", "HEAD"], baseDir);
	if (!result.ok || !result.stdout) return [];
	return result.stdout
		.split("\n")
		.map((b) => b.replace(/^\*?\s+/, "").trim())
		.filter(Boolean);
}

/**
 * List files with merge conflicts in the working tree.
 */
export async function getConflictFiles(cwd: string): Promise<string[]> {
	const result = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
	if (!result.ok || !result.stdout) return [];
	return result.stdout.split("\n").filter(Boolean);
}

/**
 * Create a clean integration worktree with a new branch based on HEAD.
 * Returns the worktree path.
 */
export async function createIntegrationWorktree(
	branchName: string,
	baseDir: string,
): Promise<string> {
	const worktreePath = join(baseDir, ".milhouse", "work", "integration", branchName);

	// Clean up if exists
	if (existsSync(worktreePath)) {
		await git(["worktree", "remove", "--force", worktreePath], baseDir);
	}
	await git(["worktree", "prune"], baseDir);

	// Delete branch if leftover from previous resolve
	await git(["branch", "-D", branchName], baseDir);

	const result = await git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], baseDir);
	if (!result.ok) {
		throw new Error(`Failed to create integration worktree: ${result.stderr}`);
	}
	return worktreePath;
}

/**
 * Try merging a branch. Returns { ok, conflictFiles }.
 */
export async function tryMerge(
	branch: string,
	cwd: string,
): Promise<{ ok: boolean; conflictFiles: string[] }> {
	const result = await git(["merge", "--no-ff", branch, "-m", `Merge ${branch}`], cwd);
	if (result.ok) return { ok: true, conflictFiles: [] };
	const files = await getConflictFiles(cwd);
	return { ok: false, conflictFiles: files };
}

/**
 * Complete a merge after conflicts have been resolved.
 */
export async function completeMerge(cwd: string): Promise<boolean> {
	await git(["add", "-A"], cwd);
	const result = await git(["commit", "--no-edit"], cwd);
	return result.ok;
}

/**
 * Abort an in-progress merge.
 */
export async function abortMerge(cwd: string): Promise<void> {
	await git(["merge", "--abort"], cwd);
}

/**
 * Check if working tree has uncommitted changes.
 */
export async function isWorkingTreeDirty(baseDir: string): Promise<boolean> {
	const result = await git(["status", "--porcelain"], baseDir);
	return result.ok && result.stdout.trim().length > 0;
}
