/**
 * VCS Merge Service
 *
 * High-level merge operations for integrating agent branches.
 * Uses the git-cli backend for deterministic command execution.
 *
 * @module vcs/services/merge-service
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../../events/bus.ts";
import { logDebug, logWarn } from "../../ui/logger.ts";
import { parseStatusPorcelain, runGitCommand } from "../backends/git-cli.ts";
import { makeIntegrationBranchName } from "../policies/naming.ts";
import type {
	BatchMergeResult,
	CreateIntegrationBranchOptions,
	IMergeService,
	MergeBranchOptions,
	MergeResult,
	VcsResult,
} from "../types.ts";
import { createVcsError, err, ok } from "../types.ts";

/**
 * Classify a checkout failure based on stderr output.
 *
 * Parses git checkout stderr to distinguish between:
 * - DIRTY_WORKTREE: uncommitted changes would be overwritten
 * - BRANCH_LOCKED: branch is checked out in another worktree
 * - BRANCH_NOT_FOUND: fallback for unrecognized errors
 */
export function classifyCheckoutError(branchName: string, stderr: string) {
	if (stderr.includes("local changes") && stderr.includes("would be overwritten")) {
		return createVcsError(
			"DIRTY_WORKTREE",
			`Cannot checkout ${branchName}: uncommitted changes would be overwritten`,
			{ context: { stderr } },
		);
	}

	if (
		stderr.includes("already used by worktree") ||
		stderr.includes("already checked out at")
	) {
		return createVcsError(
			"BRANCH_LOCKED",
			`Cannot checkout ${branchName}: branch is checked out in another worktree`,
			{ context: { stderr } },
		);
	}

	return createVcsError(
		"BRANCH_NOT_FOUND",
		`Failed to checkout ${branchName}`,
		{ context: { stderr } },
	);
}

/**
 * Merge Service implementation
 *
 * Provides high-level merge operations with proper error handling
 * and event emission for observability.
 */
export class MergeService implements IMergeService {
	/**
	 * Merge an agent branch into a target branch
	 *
	 * This operation:
	 * 1. Checks out the target branch
	 * 2. Attempts to merge the source branch
	 * 3. Detects and reports conflicts
	 * 4. Emits events for observability
	 */
	async mergeAgentBranch(options: MergeBranchOptions): Promise<VcsResult<MergeResult>> {
		const { source, target, workDir, message, allowFastForward = false } = options;

		// Emit start event
		bus.emit("git:merge:start", { source, target });

		// Checkout target branch
		const checkoutResult = await runGitCommand(["checkout", target], workDir);
		if (!checkoutResult.ok) {
			return checkoutResult;
		}

		if (checkoutResult.value.exitCode !== 0) {
			return err(
				createVcsError("BRANCH_NOT_FOUND", `Failed to checkout ${target}`, {
					context: { stderr: checkoutResult.value.stderr },
				}),
			);
		}

		// Build merge command
		const mergeArgs = ["merge", source];
		if (!allowFastForward) {
			mergeArgs.push("--no-ff");
		}
		if (message) {
			mergeArgs.push("-m", message);
		} else {
			mergeArgs.push("-m", `Merge ${source} into ${target}`);
		}

		// Attempt merge
		const mergeResult = await runGitCommand(mergeArgs, workDir);
		if (!mergeResult.ok) {
			return mergeResult;
		}

		if (mergeResult.value.exitCode === 0) {
			// Merge succeeded
			bus.emit("git:merge:complete", { source, target });

			// Get merge commit hash
			const headResult = await runGitCommand(["rev-parse", "HEAD"], workDir);
			const mergeCommit =
				headResult.ok && headResult.value.exitCode === 0
					? headResult.value.stdout.trim()
					: undefined;

			return ok({
				success: true,
				hasConflicts: false,
				conflictedFiles: [],
				mergeCommit,
			});
		}

		// Check if we have conflicts
		const conflictedFilesResult = await this.getConflictedFiles(workDir);
		if (!conflictedFilesResult.ok) {
			return conflictedFilesResult;
		}

		if (conflictedFilesResult.value.length > 0) {
			// Emit conflict event
			bus.emit("git:merge:conflict", {
				source,
				target,
				files: conflictedFilesResult.value,
			});

			return ok({
				success: false,
				hasConflicts: true,
				conflictedFiles: conflictedFilesResult.value,
			});
		}

		// Some other merge error
		return err(
			createVcsError("MERGE_FAILED", "Merge failed", {
				context: { stderr: mergeResult.value.stderr },
			}),
		);
	}

	/**
	 * Create an integration branch for a parallel group
	 */
	async createIntegrationBranch(
		options: CreateIntegrationBranchOptions,
	): Promise<VcsResult<string>> {
		const { groupNum, baseBranch, workDir } = options;

		const branchName = makeIntegrationBranchName({ groupNum });

		// Checkout base branch first
		const checkoutResult = await runGitCommand(["checkout", baseBranch], workDir);
		if (!checkoutResult.ok) {
			return checkoutResult;
		}

		if (checkoutResult.value.exitCode !== 0) {
			return err(classifyCheckoutError(baseBranch, checkoutResult.value.stderr));
		}

		// Delete the branch if it exists (failure is expected if branch doesn't exist)
		const deleteResult = await runGitCommand(["branch", "-D", branchName], workDir);
		if (deleteResult.ok && deleteResult.value.exitCode !== 0) {
			logDebug(`Branch ${branchName} did not exist (expected for fresh creation)`);
		}

		// Create new branch from base
		const createResult = await runGitCommand(["checkout", "-b", branchName], workDir);
		if (!createResult.ok) {
			return createResult;
		}

		if (createResult.value.exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", `Failed to create branch ${branchName}`, {
					context: { stderr: createResult.value.stderr },
				}),
			);
		}

		// Emit event
		bus.emit("git:branch:create", { name: branchName });

		return ok(branchName);
	}

	/**
	 * Merge multiple source branches into a target branch
	 * Returns lists of succeeded and failed branches
	 */
	async mergeIntoBranch(
		sourceBranches: string[],
		targetBranch: string,
		workDir: string,
	): Promise<VcsResult<BatchMergeResult>> {
		const succeeded: string[] = [];
		const failed: string[] = [];
		const conflicted: string[] = [];

		for (const branch of sourceBranches) {
			const result = await this.mergeAgentBranch({
				source: branch,
				target: targetBranch,
				workDir,
			});

			if (!result.ok) {
				failed.push(branch);
				continue;
			}

			if (result.value.success) {
				succeeded.push(branch);
			} else if (result.value.hasConflicts) {
				conflicted.push(branch);
				// Abort the merge to continue with next branch
				await this.abortMerge(workDir);
			} else {
				failed.push(branch);
			}
		}

		return ok({ succeeded, failed, conflicted });
	}

	/**
	 * Abort an in-progress merge.
	 * Returns ok if abort succeeded or no merge was in progress.
	 * Returns err only if the abort command itself failed unexpectedly.
	 */
	async abortMerge(workDir: string): Promise<VcsResult<void>> {
		const result = await runGitCommand(["merge", "--abort"], workDir);
		if (!result.ok) {
			return result;
		}
		// Exit code 128 = no merge in progress (not an error)
		if (result.value.exitCode !== 0 && !result.value.stderr.includes("no merge")) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to abort merge", {
					context: { stderr: result.value.stderr },
				}),
			);
		}
		return ok(undefined);
	}

	/**
	 * Complete a merge after conflicts have been resolved
	 * Only stages the specific resolved files and commits if there are no remaining conflicts
	 */
	async completeMerge(workDir: string, resolvedFiles: string[]): Promise<VcsResult<boolean>> {
		// Verify no conflicts remain
		const remainingConflictsResult = await this.getConflictedFiles(workDir);
		if (!remainingConflictsResult.ok) {
			return remainingConflictsResult;
		}

		if (remainingConflictsResult.value.length > 0) {
			return ok(false);
		}

		// Stage only the specific resolved files to avoid staging unrelated changes
		for (const file of resolvedFiles) {
			const addResult = await runGitCommand(["add", file], workDir);
			if (!addResult.ok) {
				return addResult;
			}
		}

		// Use --no-edit to preserve Git's prepared merge message
		const commitResult = await runGitCommand(["commit", "--no-edit"], workDir);
		if (!commitResult.ok) {
			return commitResult;
		}

		if (commitResult.value.exitCode !== 0) {
			return ok(false);
		}

		// Emit completion event
		bus.emit("git:merge:complete", {
			source: "resolved",
			target: "current",
		});

		return ok(true);
	}

	/**
	 * Get list of files with merge conflicts
	 */
	async getConflictedFiles(workDir: string): Promise<VcsResult<string[]>> {
		const result = await runGitCommand(["status", "--porcelain"], workDir);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			return err(
				createVcsError("NOT_A_REPOSITORY", "Not a git repository", {
					context: { stderr: result.value.stderr },
				}),
			);
		}

		const entries = parseStatusPorcelain(result.value.stdout);

		// Conflicted files have 'U' in either index or worktree status
		// or both sides modified (DD, AU, UD, UA, DU, AA, UU)
		const conflictedFiles = entries
			.filter((e) => {
				const combined = e.index + e.worktree;
				return combined.includes("U") || combined === "DD" || combined === "AA";
			})
			.map((e) => e.path);

		return ok(conflictedFiles);
	}

	/**
	 * Check if a merge is currently in progress
	 */
	async isMergeInProgress(workDir: string): Promise<VcsResult<boolean>> {
		// Check for MERGE_HEAD file
		const result = await runGitCommand(["rev-parse", "--verify", "MERGE_HEAD"], workDir);
		if (!result.ok) {
			return result;
		}

		// Exit code 0 means MERGE_HEAD exists (merge in progress)
		return ok(result.value.exitCode === 0);
	}

	/**
	 * Get the merge base commit between two branches
	 */
	async getMergeBase(
		branch1: string,
		branch2: string,
		workDir: string,
	): Promise<VcsResult<string>> {
		const result = await runGitCommand(["merge-base", branch1, branch2], workDir);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			return err(
				createVcsError("BRANCH_NOT_FOUND", "Could not find merge base", {
					context: { stderr: result.value.stderr, branch1, branch2 },
				}),
			);
		}

		return ok(result.value.stdout.trim());
	}

	/**
	 * Rebase a branch onto another branch
	 *
	 * This operation:
	 * 1. Checks out the source branch
	 * 2. Rebases onto the target branch
	 * 3. Returns whether rebase succeeded or has conflicts
	 */
	async rebaseBranch(
		sourceBranch: string,
		targetBranch: string,
		workDir: string,
	): Promise<VcsResult<RebaseResult>> {
		// Emit start event
		bus.emit("git:rebase:start", { source: sourceBranch, target: targetBranch });

		// Checkout source branch
		const checkoutResult = await runGitCommand(["checkout", sourceBranch], workDir);
		if (!checkoutResult.ok) {
			return checkoutResult;
		}

		if (checkoutResult.value.exitCode !== 0) {
			const stderr = checkoutResult.value.stderr;

			// Detect specific error conditions from stderr
			if (stderr.includes("local changes") && stderr.includes("would be overwritten")) {
				return err(
					createVcsError(
						"DIRTY_WORKTREE",
						`Cannot checkout ${sourceBranch}: uncommitted changes in workDir would be overwritten`,
						{
							context: { stderr },
						},
					),
				);
			}

			if (
				stderr.includes("already used by worktree") ||
				stderr.includes("already checked out at")
			) {
				return err(
					createVcsError(
						"BRANCH_LOCKED",
						`Cannot checkout ${sourceBranch}: branch is checked out in another worktree`,
						{
							context: { stderr },
						},
					),
				);
			}

			return err(
				createVcsError("BRANCH_NOT_FOUND", `Failed to checkout ${sourceBranch}`, {
					context: { stderr },
				}),
			);
		}

		// Attempt rebase
		const rebaseResult = await runGitCommand(["rebase", targetBranch], workDir);
		if (!rebaseResult.ok) {
			return rebaseResult;
		}

		if (rebaseResult.value.exitCode === 0) {
			// Rebase succeeded
			bus.emit("git:rebase:complete", { source: sourceBranch, target: targetBranch });
			return ok({
				success: true,
				hasConflicts: false,
				conflictedFiles: [],
			});
		}

		// Check if we have conflicts
		const conflictedFilesResult = await this.getConflictedFiles(workDir);
		if (!conflictedFilesResult.ok) {
			return conflictedFilesResult;
		}

		if (conflictedFilesResult.value.length > 0) {
			// Emit conflict event
			bus.emit("git:rebase:conflict", {
				source: sourceBranch,
				target: targetBranch,
				files: conflictedFilesResult.value,
			});

			return ok({
				success: false,
				hasConflicts: true,
				conflictedFiles: conflictedFilesResult.value,
			});
		}

		// Some other rebase error
		return err(
			createVcsError("REBASE_FAILED", "Rebase failed", {
				context: { stderr: rebaseResult.value.stderr },
			}),
		);
	}

	/**
	 * Abort an in-progress rebase.
	 * Returns ok if abort succeeded or no rebase was in progress.
	 * Returns err only if the abort command itself failed unexpectedly.
	 */
	async abortRebase(workDir: string): Promise<VcsResult<void>> {
		const result = await runGitCommand(["rebase", "--abort"], workDir);
		if (!result.ok) {
			return result;
		}
		// Exit code 128 = no rebase in progress (not an error)
		if (result.value.exitCode !== 0 && !result.value.stderr.includes("no rebase")) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to abort rebase", {
					context: { stderr: result.value.stderr },
				}),
			);
		}
		return ok(undefined);
	}

	/**
	 * Continue a rebase after conflicts have been resolved.
	 * Sets GIT_EDITOR=true to prevent editor prompts in automated mode.
	 * After a failed continue, checks if the rebase actually completed
	 * (e.g., AI already ran rebase --continue itself).
	 */
	async continueRebase(workDir: string): Promise<VcsResult<boolean>> {
		// Stage all resolved files
		const addResult = await runGitCommand(["add", "-A"], workDir);
		if (!addResult.ok) {
			return addResult;
		}

		// Continue the rebase with GIT_EDITOR=true to prevent editor prompts
		const continueResult = await runGitCommand(
			["-c", "core.editor=true", "rebase", "--continue"],
			workDir,
		);
		if (!continueResult.ok) {
			return continueResult;
		}

		if (continueResult.value.exitCode !== 0) {
			// Check if rebase is still in progress — if not, it actually completed
			// (e.g., the AI already ran git rebase --continue itself)
			const rebaseActive = await this.isRebaseInProgress(workDir);
			if (rebaseActive.ok && !rebaseActive.value) {
				// Rebase is no longer active. Check reflog to distinguish
				// successful completion from abort (the AI may have already
				// run rebase --continue or --abort before we got here).
				const reflogResult = await runGitCommand(
					["reflog", "-1", "--format=%gs"],
					workDir,
				);
				if (reflogResult.ok && reflogResult.value.exitCode === 0) {
					const subject = reflogResult.value.stdout.trim();
					if (subject.includes("rebase (abort)")) {
						logDebug(
							`continueRebase: reflog indicates rebase was aborted: ${subject}`,
						);
						return ok(false);
					}
					if (
						subject.includes("rebase (finish)") ||
						subject.includes("rebase (continue)")
					) {
						logDebug(
							`continueRebase: reflog confirms rebase completed: ${subject}`,
						);
						return ok(true);
					}
				}
				// Reflog unavailable or unrecognized — fall back to assuming success
				logDebug(
					"continueRebase: rebase no longer active, reflog inconclusive — assuming success",
				);
				return ok(true);
			}

			// Check if there are new conflicts (multi-commit rebase)
			const conflictedFilesResult = await this.getConflictedFiles(workDir);
			if (conflictedFilesResult.ok && conflictedFilesResult.value.length > 0) {
				logDebug(
					`continueRebase: new conflicts after continue (multi-commit rebase): ${conflictedFilesResult.value.join(", ")}`,
				);
				return ok(false);
			}

			// Unknown failure — log stderr for debugging
			logDebug(
				`continueRebase: rebase --continue failed (exit ${continueResult.value.exitCode}): ${continueResult.value.stderr}`,
			);
			return ok(false);
		}

		return ok(true);
	}

	/**
	 * Check if a rebase is currently in progress
	 */
	async isRebaseInProgress(workDir: string): Promise<VcsResult<boolean>> {
		// Check for rebase-merge or rebase-apply directories
		const result = await runGitCommand(["rev-parse", "--git-path", "rebase-merge"], workDir);
		if (!result.ok) {
			return result;
		}

		// If the path exists, a rebase is in progress
		const checkResult = await runGitCommand(["rev-parse", "--verify", "REBASE_HEAD"], workDir);
		return ok(checkResult.ok && checkResult.value.exitCode === 0);
	}
	/**
	 * Verify that a merge actually completed by checking if HEAD is a merge commit.
	 *
	 * Checks:
	 * 1. HEAD has a second parent (i.e., is a merge commit) via `git rev-parse HEAD^2`
	 * 2. If preHeadSha is provided, HEAD must have advanced from it
	 *
	 * @param workDir - Working directory
	 * @param preHeadSha - Optional SHA of HEAD before the merge attempt
	 * @returns ok(true) if positive evidence of merge completion, ok(false) otherwise
	 */
	async verifyMergeCompleted(
		workDir: string,
		preHeadSha?: string,
	): Promise<VcsResult<boolean>> {
		// Check if HEAD is a merge commit by verifying it has a second parent
		const headParent2Result = await runGitCommand(["rev-parse", "HEAD^2"], workDir);
		if (!headParent2Result.ok) {
			return headParent2Result;
		}

		if (headParent2Result.value.exitCode !== 0) {
			// HEAD is not a merge commit (no second parent)
			return ok(false);
		}

		// If preHeadSha is provided, verify HEAD actually advanced
		if (preHeadSha) {
			const headResult = await runGitCommand(["rev-parse", "HEAD"], workDir);
			if (!headResult.ok) {
				return headResult;
			}

			if (headResult.value.exitCode === 0 && headResult.value.stdout.trim() === preHeadSha) {
				// HEAD didn't advance — merge didn't complete
				return ok(false);
			}
		}

		return ok(true);
	}

	/**
	 * Check if workDir is clean enough for merge operations
	 */
	async checkMergeReadiness(workDir: string): Promise<VcsResult<MergeReadinessResult>> {
		const statusResult = await runGitCommand(["status", "--porcelain"], workDir);
		if (!statusResult.ok) {
			return statusResult;
		}

		const hasChanges = statusResult.value.stdout.trim().length > 0;

		if (hasChanges) {
			return ok({
				ready: false,
				reason: "DIRTY_WORKTREE",
				suggestion: "Commit or stash changes before merge, or use --skip-merge flag",
			});
		}

		return ok({ ready: true });
	}

	/**
	 * Stash uncommitted changes with a descriptive message
	 *
	 * @param workDir - Working directory
	 * @param message - Stash message
	 * @returns Whether stash was created (false if nothing to stash)
	 */
	async stashChanges(workDir: string, message?: string): Promise<VcsResult<StashResult>> {
		// Check if there are changes to stash
		const statusResult = await runGitCommand(["status", "--porcelain"], workDir);
		if (!statusResult.ok) {
			return statusResult;
		}

		const hasChanges = statusResult.value.stdout.trim().length > 0;
		if (!hasChanges) {
			return ok({ stashed: false, message: "Nothing to stash" });
		}

		// Stash with message
		const stashArgs = ["stash", "push", "-u"];
		if (message) {
			stashArgs.push("-m", message);
		}

		const stashResult = await runGitCommand(stashArgs, workDir);
		if (!stashResult.ok) {
			return stashResult;
		}

		if (stashResult.value.exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to stash changes", {
					context: { stderr: stashResult.value.stderr },
				}),
			);
		}

		// Note: No event emitted for stash - not in MilhouseEvents

		return ok({ stashed: true, message: message || "auto-stash" });
	}

	/**
	 * Pop the most recent stash
	 *
	 * @param workDir - Working directory
	 * @returns Whether stash was popped successfully
	 */
	async popStash(workDir: string): Promise<VcsResult<boolean>> {
		const popResult = await runGitCommand(["stash", "pop"], workDir);
		if (!popResult.ok) {
			return popResult;
		}

		if (popResult.value.exitCode !== 0) {
			// Check if there's no stash to pop
			if (popResult.value.stderr.includes("No stash entries found")) {
				return ok(false);
			}
			return err(
				createVcsError("COMMAND_FAILED", "Failed to pop stash", {
					context: { stderr: popResult.value.stderr },
				}),
			);
		}

		// Note: No event emitted for stash pop - not in MilhouseEvents

		return ok(true);
	}

	/**
	 * Auto-stash changes, perform an operation, then restore stash
	 *
	 * This is useful for merge operations that require a clean worktree.
	 *
	 * @param workDir - Working directory
	 * @param operation - Async operation to perform while changes are stashed
	 * @returns Result of the operation
	 */
	async withAutoStash<T>(
		workDir: string,
		operation: () => Promise<T>,
	): Promise<VcsResult<AutoStashResult<T>>> {
		// Stash any uncommitted changes
		const stashResult = await this.stashChanges(workDir, "milhouse-auto-stash-before-merge");
		if (!stashResult.ok) {
			return stashResult;
		}

		const wasStashed = stashResult.value.stashed;

		const autoStashResult: AutoStashResult<T> = {
			result: undefined as unknown as T,
			wasStashed,
			stashRestored: false,
		};

		try {
			autoStashResult.result = await operation();
			return ok(autoStashResult);
		} finally {
			// Restore stash if we created one
			if (wasStashed) {
				const popResult = await this.popStash(workDir);
				autoStashResult.stashRestored = !!(popResult.ok && popResult.value);
			}
		}
	}

	/**
	 * Merge a branch using a temporary worktree to avoid dirty workDir issues
	 *
	 * This method:
	 * 1. Creates a temporary worktree from target branch
	 * 2. Merges the source branch in that worktree
	 * 3. Cleans up the worktree (branch remains with merged commits)
	 */
	async safeMergeInWorktree(options: SafeMergeOptions): Promise<VcsResult<SafeMergeResult>> {
		const { sourceBranch, targetBranch, workDir, runId, message } = options;

		// Generate unique ID for merge worktree
		const mergeId = `merge-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
		const mergeWorktreePath = join(workDir, ".milhouse", "runs", runId, "merge-worktrees", mergeId);

		// Prune stale worktrees before creating merge worktree
		const pruneResult = await runGitCommand(["worktree", "prune"], workDir);
		if (!pruneResult.ok) {
			logDebug(`Worktree prune failed before safe merge: ${pruneResult.error.message}`);
		}

		// Create worktree from target branch
		const createResult = await runGitCommand(
			["worktree", "add", mergeWorktreePath, targetBranch],
			workDir,
		);

		if (!createResult.ok) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to create merge worktree", {
					context: { error: createResult.error.message },
				}),
			);
		}

		if (createResult.value.exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to create merge worktree", {
					context: { stderr: createResult.value.stderr },
				}),
			);
		}

		try {
			// In the worktree, merge the source branch
			// Use custom message if provided, otherwise use default
			const commitMessage = message || `Merge ${sourceBranch} into ${targetBranch}`;
			const mergeArgs = ["merge", sourceBranch, "-m", commitMessage];
			const mergeResult = await runGitCommand(mergeArgs, mergeWorktreePath);

			if (!mergeResult.ok) {
				return mergeResult;
			}

			if (mergeResult.value.exitCode === 0) {
				// Get merge commit
				const headResult = await runGitCommand(["rev-parse", "HEAD"], mergeWorktreePath);
				const mergeCommit =
					headResult.ok && headResult.value.exitCode === 0
						? headResult.value.stdout.trim()
						: undefined;

				bus.emit("git:merge:complete", { source: sourceBranch, target: targetBranch });

				return ok({
					success: true,
					hasConflicts: false,
					conflictedFiles: [],
					mergeCommit,
				});
			}

			// Check for conflicts
			const conflictedFilesResult = await this.getConflictedFiles(mergeWorktreePath);
			if (conflictedFilesResult.ok && conflictedFilesResult.value.length > 0) {
				// Abort merge in worktree
				const abortResult = await runGitCommand(["merge", "--abort"], mergeWorktreePath);
				if (!abortResult.ok || abortResult.value.exitCode !== 0) {
					logWarn(
						`merge --abort failed in worktree: ${!abortResult.ok ? abortResult.error.message : abortResult.value.stderr}`,
					);
				}

				bus.emit("git:merge:conflict", {
					source: sourceBranch,
					target: targetBranch,
					files: conflictedFilesResult.value,
				});

				return ok({
					success: false,
					hasConflicts: true,
					conflictedFiles: conflictedFilesResult.value,
				});
			}

			return err(
				createVcsError("MERGE_FAILED", "Merge failed", {
					context: { stderr: mergeResult.value.stderr },
				}),
			);
		} finally {
			// Always cleanup the temporary worktree
			const worktreeRemoveResult = await runGitCommand(["worktree", "remove", "-f", mergeWorktreePath], workDir);
			if (!worktreeRemoveResult.ok || worktreeRemoveResult.value.exitCode !== 0) {
				logWarn(
					`Failed to remove merge worktree ${mergeWorktreePath}: ${!worktreeRemoveResult.ok ? worktreeRemoveResult.error.message : worktreeRemoveResult.value.stderr}`,
				);
			}
		}
	}

	/**
	 * Merge multiple branches with retry logic and worktree isolation
	 *
	 * Uses safe merge in temporary worktree to avoid dirty workDir issues.
	 *
	 * @param options - Batch merge options
	 * @param options.branches - Branches to merge
	 * @param options.targetBranch - Target branch to merge into
	 * @param options.workDir - Main repository directory
	 * @param options.runId - Run ID for worktree naming
	 * @param options.maxRetries - Maximum retry attempts (default: 3)
	 * @param options.onConflict - Optional callback for AI conflict resolution
	 */
	async batchMergeWithRetry(
		options: BatchMergeWithRetryOptions,
	): Promise<VcsResult<BatchMergeWithRetryResult>> {
		const { branches, targetBranch, workDir, runId, maxRetries = 3, onConflict } = options;

		const succeeded: Array<{ branch: string; commit?: string }> = [];
		const failed: Array<{ branch: string; error: string }> = [];
		const conflicted: Array<{ branch: string; files: string[] }> = [];

		for (const branch of branches) {
			let success = false;
			let lastError = "";

			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				// Use safe merge in worktree
				const mergeResult = await this.safeMergeInWorktree({
					sourceBranch: branch,
					targetBranch,
					workDir,
					runId,
				});

				if (!mergeResult.ok) {
					lastError = mergeResult.error.message;
					continue;
				}

				if (mergeResult.value.success) {
					succeeded.push({
						branch,
						commit: mergeResult.value.mergeCommit,
					});
					success = true;
					break;
				}

				if (mergeResult.value.hasConflicts) {
					// Try conflict resolution if callback provided
					if (onConflict) {
						const resolved = await onConflict(mergeResult.value.conflictedFiles, branch, workDir);

						if (resolved) {
							// Retry after resolution
							continue;
						}
					}

					// Cannot resolve conflicts
					conflicted.push({
						branch,
						files: mergeResult.value.conflictedFiles,
					});
					success = true; // Mark as handled
					break;
				}

				lastError = "Unknown merge error";
			}

			if (!success) {
				failed.push({ branch, error: lastError });
			}
		}

		return ok({ succeeded, failed, conflicted });
	}

	/**
	 * Execute a merge operation in an isolated worktree, then fast-forward
	 * the base branch in the main worktree.
	 *
	 * This avoids the stash/pop pattern entirely for the common case.
	 * If the main worktree has dirty files that overlap with merged changes,
	 * falls back to stash with automatic conflict resolution.
	 *
	 * @param options - Isolated merge options
	 * @returns Result with success status and any stash conflict details
	 */
	async mergeInIsolatedWorktree(
		options: IsolatedMergeOptions,
	): Promise<VcsResult<IsolatedMergeResult>> {
		const { workDir, baseBranch, operation } = options;
		const mergeId = `mh-merge-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
		const tempBranch = `mh/temp-merge/${mergeId}`;
		const tempWorktreePath = join(workDir, ".milhouse", "work", "merge-worktrees", mergeId);

		// Prune stale worktrees before creating a new one
		const preSetupPruneResult = await runGitCommand(["worktree", "prune"], workDir);
		if (!preSetupPruneResult.ok || preSetupPruneResult.value.exitCode !== 0) {
			logWarn(
				`Worktree prune before isolated merge failed: ${!preSetupPruneResult.ok ? preSetupPruneResult.error.message : preSetupPruneResult.value.stderr}`,
			);
		}

		// Ensure parent directory exists
		const parentDir = join(workDir, ".milhouse", "work", "merge-worktrees");
		if (!existsSync(parentDir)) {
			mkdirSync(parentDir, { recursive: true });
		}

		// Create temp worktree with a temp branch forked from baseBranch
		const createResult = await runGitCommand(
			["worktree", "add", "-b", tempBranch, tempWorktreePath, baseBranch],
			workDir,
		);

		if (!createResult.ok || createResult.value.exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to create merge worktree", {
					context: {
						stderr: createResult.ok ? createResult.value.stderr : createResult.error.message,
					},
				}),
			);
		}

		try {
			// Run the merge operation in the isolated worktree
			await operation(tempWorktreePath, tempBranch);

			// Fast-forward baseBranch to tempBranch in the main worktree
			const ffResult = await runGitCommand(["merge", "--ff-only", tempBranch], workDir);

			if (ffResult.ok && ffResult.value.exitCode === 0) {
				return ok({
					success: true,
					stashWasNeeded: false,
					stashConflictsResolved: [],
				});
			}

			// ff-only failed — likely dirty files overlap with merged changes
			// Fall back to stash → ff-only → pop with auto-resolution
			logDebug("Fast-forward merge blocked by dirty files. Falling back to stash...");

			const stashResult = await this.stashChanges(workDir, "milhouse-merge-ff-fallback");
			if (!stashResult.ok || !stashResult.value.stashed) {
				return err(
					createVcsError(
						"COMMAND_FAILED",
						"Fast-forward merge failed and could not stash changes",
						{
							context: { ffStderr: ffResult.ok ? ffResult.value.stderr : "" },
						},
					),
				);
			}

			// Retry ff-only with clean worktree
			const ffRetryResult = await runGitCommand(["merge", "--ff-only", tempBranch], workDir);
			if (!ffRetryResult.ok || ffRetryResult.value.exitCode !== 0) {
				// Restore stash and report failure
				await this.popStash(workDir);
				return err(
					createVcsError("MERGE_FAILED", "Fast-forward merge failed even after stashing", {
						context: {
							stderr: ffRetryResult.ok ? ffRetryResult.value.stderr : "",
						},
					}),
				);
			}

			// Pop stash to restore user's changes
			const popResult = await runGitCommand(["stash", "pop"], workDir);
			if (popResult.ok && popResult.value.exitCode === 0) {
				return ok({
					success: true,
					stashWasNeeded: true,
					stashConflictsResolved: [],
				});
			}

			// Stash pop had conflicts — auto-resolve with --ours (keep merged version)
			const conflictedResult = await this.getConflictedFiles(workDir);
			if (conflictedResult.ok && conflictedResult.value.length > 0) {
				const resolvedFiles = conflictedResult.value;

				// Best-effort backup: save the stash commit as a named ref before auto-resolving
				let stashBackupRef: string | undefined;
				try {
					const revParseResult = await runGitCommand(["rev-parse", "stash@{0}"], workDir);
					if (revParseResult.ok && revParseResult.value.exitCode === 0) {
						const stashSha = revParseResult.value.stdout.trim();
						const refName = `refs/milhouse/stash-backup/${mergeId}`;
						const updateRefResult = await runGitCommand(
							["update-ref", refName, stashSha],
							workDir,
						);
						if (updateRefResult.ok && updateRefResult.value.exitCode === 0) {
							stashBackupRef = refName;
						} else {
							logDebug(`Failed to create stash backup ref: update-ref failed`);
						}
					} else {
						logDebug(`Failed to capture stash SHA for backup: rev-parse failed`);
					}
				} catch (backupErr) {
					logDebug(
						`Stash backup failed (proceeding with auto-resolution): ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`,
					);
				}

				for (const file of resolvedFiles) {
					const checkoutResult = await runGitCommand(["checkout", "--ours", "--", file], workDir);
					if (!checkoutResult.ok || checkoutResult.value.exitCode !== 0) {
						return err(
							createVcsError("COMMAND_FAILED", `checkout --ours failed for file: ${file}`, {
								context: { stderr: checkoutResult.ok ? checkoutResult.value.stderr : "" },
							}),
						);
					}
					const addResult = await runGitCommand(["add", "--", file], workDir);
					if (!addResult.ok || addResult.value.exitCode !== 0) {
						return err(
							createVcsError("COMMAND_FAILED", `git add failed for file: ${file}`, {
								context: { stderr: addResult.ok ? addResult.value.stderr : "" },
							}),
						);
					}
				}
				// After conflicted stash pop, the stash entry is NOT auto-dropped
				const stashDropResult = await runGitCommand(["stash", "drop"], workDir);
				if (!stashDropResult.ok || stashDropResult.value.exitCode !== 0) {
					return err(
						createVcsError("COMMAND_FAILED", "stash drop failed after conflict resolution", {
							context: { stderr: stashDropResult.ok ? stashDropResult.value.stderr : "" },
						}),
					);
				}
				// Reset index so resolved files don't stay staged
				const resetResult = await runGitCommand(["reset", "HEAD"], workDir);
				if (!resetResult.ok || resetResult.value.exitCode !== 0) {
					return err(
						createVcsError("COMMAND_FAILED", "reset HEAD failed after conflict resolution", {
							context: { stderr: resetResult.ok ? resetResult.value.stderr : "" },
						}),
					);
				}

				return ok({
					success: true,
					stashWasNeeded: true,
					stashConflictsResolved: resolvedFiles,
					stashBackupRef,
				});
			}

			// Unknown stash pop failure
			return err(
				createVcsError("COMMAND_FAILED", "Stash pop failed for unknown reason", {
					context: { stderr: popResult.ok ? popResult.value.stderr : "" },
				}),
			);
		} catch (opError) {
			return err(
				createVcsError(
					"COMMAND_FAILED",
					`Merge operation failed: ${opError instanceof Error ? opError.message : String(opError)}`,
				),
			);
		} finally {
			// Always clean up temp worktree and branch
			const removeResult = await runGitCommand(
				["worktree", "remove", "--force", tempWorktreePath],
				workDir,
			);
			if (!removeResult.ok || removeResult.value.exitCode !== 0) {
				// Force-remove directory if git couldn't
				try {
					rmSync(tempWorktreePath, { recursive: true, force: true });
				} catch {
					logDebug(`Failed to remove merge worktree directory: ${tempWorktreePath}`);
				}
			}

			const pruneResult = await runGitCommand(["worktree", "prune"], workDir);
			if (!pruneResult.ok || pruneResult.value.exitCode !== 0) {
				logWarn(
					`Worktree prune failed during cleanup: ${!pruneResult.ok ? pruneResult.error.message : pruneResult.value.stderr}`,
				);
			}

			const branchDeleteResult = await runGitCommand(["branch", "-D", tempBranch], workDir);
			if (!branchDeleteResult.ok || branchDeleteResult.value.exitCode !== 0) {
				logWarn(
					`Failed to delete temp branch ${tempBranch}: ${!branchDeleteResult.ok ? branchDeleteResult.error.message : branchDeleteResult.value.stderr}`,
				);
			}
		}
	}
}

/**
 * Result of a rebase operation
 */
export interface RebaseResult {
	success: boolean;
	hasConflicts: boolean;
	conflictedFiles: string[];
}

/**
 * Result of merge readiness check
 */
export interface MergeReadinessResult {
	ready: boolean;
	reason?: string;
	suggestion?: string;
}

/**
 * Result of stash operation
 */
export interface StashResult {
	/** Whether changes were stashed */
	stashed: boolean;
	/** Stash message */
	message?: string;
}

/**
 * Result of auto-stash operation
 */
export interface AutoStashResult<T> {
	/** Result of the wrapped operation */
	result: T;
	/** Whether changes were stashed before operation */
	wasStashed: boolean;
	/** Whether stash was restored after operation */
	stashRestored: boolean;
}

/**
 * Options for safe merge in worktree
 */
export interface SafeMergeOptions {
	/** Source branch to merge */
	sourceBranch: string;
	/** Target branch to merge into */
	targetBranch: string;
	/** Main repository directory */
	workDir: string;
	/** Run ID for worktree naming */
	runId: string;
	/** Custom commit message for the merge (human-readable, no technical metadata) */
	message?: string;
}

/**
 * Result of safe merge operation
 */
export interface SafeMergeResult {
	success: boolean;
	hasConflicts: boolean;
	conflictedFiles: string[];
	mergeCommit?: string;
}

/**
 * Options for worktree-isolated merge operations.
 *
 * Instead of stashing user changes and merging in the main worktree,
 * this runs merge operations in a temporary worktree and then
 * fast-forwards the base branch in the main worktree.
 */
export interface IsolatedMergeOptions {
	/** Working directory of the main repo */
	workDir: string;
	/** Base branch currently checked out in main worktree */
	baseBranch: string;
	/** Operation to run in the isolated worktree. Receives tempWorkDir and tempBranch. */
	operation: (tempWorkDir: string, tempBranch: string) => Promise<void>;
}

/**
 * Result of worktree-isolated merge
 */
export interface IsolatedMergeResult {
	/** Whether the merge into baseBranch succeeded */
	success: boolean;
	/** Whether stash was needed for the fast-forward step */
	stashWasNeeded: boolean;
	/** Files where stash pop conflicts were auto-resolved (kept merged version) */
	stashConflictsResolved: string[];
	/** Named ref backing up the stash before auto-resolution, if conflicts occurred */
	stashBackupRef?: string;
}

/**
 * Options for batch merge with retry
 */
export interface BatchMergeWithRetryOptions {
	/** Branches to merge */
	branches: string[];
	/** Target branch to merge into */
	targetBranch: string;
	/** Main repository directory */
	workDir: string;
	/** Run ID for worktree naming */
	runId: string;
	/** Maximum retry attempts per branch (default: 3) */
	maxRetries?: number;
	/** Optional callback for AI conflict resolution */
	onConflict?: (files: string[], branch: string, workDir: string) => Promise<boolean>;
}

/**
 * Result of batch merge with retry
 */
export interface BatchMergeWithRetryResult {
	succeeded: Array<{ branch: string; commit?: string }>;
	failed: Array<{ branch: string; error: string }>;
	conflicted: Array<{ branch: string; files: string[] }>;
}

// ============================================================================
// Standalone Function Exports (for convenience)
// ============================================================================

const defaultService = new MergeService();

/**
 * Merge an agent branch into a target branch
 * @see MergeService.mergeAgentBranch
 */
export async function mergeAgentBranch(
	source: string,
	target: string,
	workDir: string,
	options?: Partial<MergeBranchOptions>,
): Promise<VcsResult<MergeResult>> {
	return defaultService.mergeAgentBranch({
		source,
		target,
		workDir,
		...options,
	});
}

/**
 * Create an integration branch for a parallel group
 * @see MergeService.createIntegrationBranch
 */
export async function createIntegrationBranch(
	groupNum: number,
	baseBranch: string,
	workDir: string,
): Promise<VcsResult<string>> {
	return defaultService.createIntegrationBranch({ groupNum, baseBranch, workDir });
}

/**
 * Merge multiple source branches into a target branch
 * @see MergeService.mergeIntoBranch
 */
export async function mergeIntoBranch(
	sourceBranches: string[],
	targetBranch: string,
	workDir: string,
): Promise<VcsResult<BatchMergeResult>> {
	return defaultService.mergeIntoBranch(sourceBranches, targetBranch, workDir);
}

/**
 * Abort an in-progress merge
 * @see MergeService.abortMerge
 */
export async function abortMerge(workDir: string): Promise<VcsResult<void>> {
	return defaultService.abortMerge(workDir);
}

/**
 * Complete a merge after conflicts have been resolved
 * @see MergeService.completeMerge
 */
export async function completeMerge(
	workDir: string,
	resolvedFiles: string[],
): Promise<VcsResult<boolean>> {
	return defaultService.completeMerge(workDir, resolvedFiles);
}

/**
 * Get list of files with merge conflicts
 * @see MergeService.getConflictedFiles
 */
export async function getConflictedFiles(workDir: string): Promise<VcsResult<string[]>> {
	return defaultService.getConflictedFiles(workDir);
}

/**
 * Check if a merge is currently in progress
 * @see MergeService.isMergeInProgress
 */
export async function isMergeInProgress(workDir: string): Promise<VcsResult<boolean>> {
	return defaultService.isMergeInProgress(workDir);
}

/**
 * Verify that a merge actually completed by checking if HEAD is a merge commit
 * @see MergeService.verifyMergeCompleted
 */
export async function verifyMergeCompleted(
	workDir: string,
	preHeadSha?: string,
): Promise<VcsResult<boolean>> {
	return defaultService.verifyMergeCompleted(workDir, preHeadSha);
}

/**
 * Get the merge base commit between two branches
 * @see MergeService.getMergeBase
 */
export async function getMergeBase(
	branch1: string,
	branch2: string,
	workDir: string,
): Promise<VcsResult<string>> {
	return defaultService.getMergeBase(branch1, branch2, workDir);
}

/**
 * Rebase a branch onto another branch
 * @see MergeService.rebaseBranch
 */
export async function rebaseBranch(
	sourceBranch: string,
	targetBranch: string,
	workDir: string,
): Promise<VcsResult<RebaseResult>> {
	return defaultService.rebaseBranch(sourceBranch, targetBranch, workDir);
}

/**
 * Abort an in-progress rebase
 * @see MergeService.abortRebase
 */
export async function abortRebase(workDir: string): Promise<VcsResult<void>> {
	return defaultService.abortRebase(workDir);
}

/**
 * Continue a rebase after conflicts have been resolved
 * @see MergeService.continueRebase
 */
export async function continueRebase(workDir: string): Promise<VcsResult<boolean>> {
	return defaultService.continueRebase(workDir);
}

/**
 * Check if a rebase is currently in progress
 * @see MergeService.isRebaseInProgress
 */
export async function isRebaseInProgress(workDir: string): Promise<VcsResult<boolean>> {
	return defaultService.isRebaseInProgress(workDir);
}

/**
 * Check if workDir is clean enough for merge operations
 * @see MergeService.checkMergeReadiness
 */
export async function checkMergeReadiness(
	workDir: string,
): Promise<VcsResult<MergeReadinessResult>> {
	return defaultService.checkMergeReadiness(workDir);
}

/**
 * Merge a branch using a temporary worktree
 * @see MergeService.safeMergeInWorktree
 */
export async function safeMergeInWorktree(
	options: SafeMergeOptions,
): Promise<VcsResult<SafeMergeResult>> {
	return defaultService.safeMergeInWorktree(options);
}

/**
 * Merge multiple branches with retry logic and worktree isolation
 * @see MergeService.batchMergeWithRetry
 */
export async function batchMergeWithRetry(
	options: BatchMergeWithRetryOptions,
): Promise<VcsResult<BatchMergeWithRetryResult>> {
	return defaultService.batchMergeWithRetry(options);
}

/**
 * Stash uncommitted changes
 * @see MergeService.stashChanges
 */
export async function stashChanges(
	workDir: string,
	message?: string,
): Promise<VcsResult<StashResult>> {
	return defaultService.stashChanges(workDir, message);
}

/**
 * Pop the most recent stash
 * @see MergeService.popStash
 */
export async function popStash(workDir: string): Promise<VcsResult<boolean>> {
	return defaultService.popStash(workDir);
}

/**
 * Auto-stash changes, perform an operation, then restore stash
 * @see MergeService.withAutoStash
 */
export async function withAutoStash<T>(
	workDir: string,
	operation: () => Promise<T>,
): Promise<VcsResult<AutoStashResult<T>>> {
	return defaultService.withAutoStash(workDir, operation);
}

/**
 * Execute a merge operation in an isolated worktree, then fast-forward
 * the base branch. Avoids stash/pop conflicts with dirty worktrees.
 * @see MergeService.mergeInIsolatedWorktree
 */
export async function mergeInIsolatedWorktree(
	options: IsolatedMergeOptions,
): Promise<VcsResult<IsolatedMergeResult>> {
	return defaultService.mergeInIsolatedWorktree(options);
}
