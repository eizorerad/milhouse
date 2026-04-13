/**
 * Resolve — AI-powered merge conflict resolver.
 *
 * Creates a clean integration branch, merges unmerged mh/* branches one by one,
 * and calls AI to resolve any conflicts. Outputs a report and a command to
 * merge the result into main.
 *
 * Does NOT touch the user's main branch.
 */

import { execute } from "./engine.ts";
import {
	abortMerge,
	cleanupWorktree,
	completeMerge,
	createIntegrationWorktree,
	isWorkingTreeDirty,
	listUnmergedBranches,
	tryMerge,
} from "./git.ts";
import { buildResolvePrompt } from "./prompts/resolve.ts";
import type { Config } from "./types.ts";
import { Spinner, log } from "./ui.ts";

export interface MergeAttempt {
	branch: string;
	status: "clean" | "resolved" | "failed";
	conflictFiles: string[];
	resolution?: string;
}

export interface ResolveResult {
	integrationBranch: string;
	attempts: MergeAttempt[];
	succeeded: number;
	failed: number;
}

export interface ResolveGitOps {
	abortMerge(cwd: string): Promise<void>;
	cleanupWorktree(worktreePath: string, baseDir: string): Promise<boolean>;
	completeMerge(cwd: string): Promise<boolean>;
	createIntegrationWorktree(branchName: string, baseDir: string): Promise<string>;
	isWorkingTreeDirty(baseDir: string): Promise<boolean>;
	listUnmergedBranches(baseDir: string): Promise<string[]>;
	tryMerge(branch: string, cwd: string): Promise<{ ok: boolean; conflictFiles: string[] }>;
}

const defaultGitOps: ResolveGitOps = {
	abortMerge,
	cleanupWorktree,
	completeMerge,
	createIntegrationWorktree,
	isWorkingTreeDirty,
	listUnmergedBranches,
	tryMerge,
};

/**
 * Run the AI merge resolver for all unmerged mh/* branches.
 */
export async function runResolve(
	config: Config,
	executeFn = execute,
	gitOps: ResolveGitOps = defaultGitOps,
): Promise<void> {
	const baseDir = process.cwd();

	// 1. Check for dirty working tree
	if (await gitOps.isWorkingTreeDirty(baseDir)) {
		log.warn("Working tree has uncommitted changes.");
		log.warn("Commit or stash them first, then run: milhouse --resolve");
		return;
	}

	// 2. Find unmerged branches
	const branches = await gitOps.listUnmergedBranches(baseDir);
	if (branches.length === 0) {
		log.success("No unmerged mh/* branches found. Nothing to resolve.");
		return;
	}

	log.info(`Found ${branches.length} unmerged branch(es): ${branches.join(", ")}`);

	// 3. Create clean integration worktree
	const integrationBranch = `mh/resolve-${Date.now().toString(36)}`;
	const spinner = new Spinner("Creating integration worktree...").start();
	let worktreePath: string;
	try {
		worktreePath = await gitOps.createIntegrationWorktree(integrationBranch, baseDir);
		spinner.success("Integration worktree ready");
	} catch (err) {
		spinner.fail(
			`Failed to create integration worktree: ${err instanceof Error ? err.message : err}`,
		);
		return;
	}

	// 4. Merge each branch, resolve conflicts with AI
	const attempts: MergeAttempt[] = [];
	let succeeded = 0;
	let failed = 0;

	for (const branch of branches) {
		const branchSpinner = new Spinner(`Merging ${branch}...`).start();

		const merge = await gitOps.tryMerge(branch, worktreePath);

		if (merge.ok) {
			// Clean merge, no conflicts
			branchSpinner.success(`${branch} - clean merge`);
			attempts.push({ branch, status: "clean", conflictFiles: [] });
			succeeded++;
			continue;
		}

		// Conflicts detected — call AI to resolve
		branchSpinner.update(
			`${branch} - ${merge.conflictFiles.length} conflict(s), resolving with AI...`,
		);

		try {
			const prompt = buildResolvePrompt(branch, merge.conflictFiles);
			const { result: aiResult } = await executeFn(prompt, worktreePath, config, {
				maxTurns: 20,
				timeout: 5 * 60 * 1000,
			});

			// Check if AI completed the merge (no more conflicts)
			const committed = await gitOps.completeMerge(worktreePath);
			if (committed) {
				branchSpinner.success(`${branch} - AI resolved ${merge.conflictFiles.length} conflict(s)`);
				attempts.push({
					branch,
					status: "resolved",
					conflictFiles: merge.conflictFiles,
					resolution: aiResult.response.slice(0, 500),
				});
				succeeded++;
			} else {
				// AI didn't fully resolve — abort and skip
				await gitOps.abortMerge(worktreePath);
				branchSpinner.fail(`${branch} - AI could not fully resolve conflicts`);
				attempts.push({ branch, status: "failed", conflictFiles: merge.conflictFiles });
				failed++;
			}
		} catch (err) {
			await gitOps.abortMerge(worktreePath).catch(() => {});
			branchSpinner.fail(`${branch} - resolve error: ${err instanceof Error ? err.message : err}`);
			attempts.push({ branch, status: "failed", conflictFiles: merge.conflictFiles });
			failed++;
		}
	}

	// 5. Cleanup worktree (keep the branch)
	await gitOps.cleanupWorktree(worktreePath, baseDir);

	// 6. Print report
	printResolveReport({ integrationBranch, attempts, succeeded, failed });
}

/**
 * Print a human-readable merge resolution report.
 */
function printResolveReport(result: ResolveResult): void {
	console.log("");
	log.phase("resolve");

	for (const a of result.attempts) {
		if (a.status === "clean") {
			log.success(`${a.branch} - merged cleanly`);
		} else if (a.status === "resolved") {
			log.success(`${a.branch} - AI resolved conflicts in: ${a.conflictFiles.join(", ")}`);
		} else {
			log.error(`${a.branch} - FAILED (conflicts in: ${a.conflictFiles.join(", ")})`);
		}
	}

	console.log("");
	log.info(`Result: ${result.succeeded} merged, ${result.failed} failed`);

	if (result.succeeded > 0) {
		console.log("");
		log.info("Review the integration branch, then merge into main:");
		log.info(`  git log ${result.integrationBranch} --oneline`);
		log.info(`  git diff main..${result.integrationBranch}`);
		log.success(`  git merge --no-ff ${result.integrationBranch}`);
	}

	if (result.failed > 0) {
		console.log("");
		log.warn("Some branches could not be resolved automatically.");
		log.warn("Resolve them manually, or re-run: milhouse --resolve");
	}
}
