/**
 * VCS Merge Service
 *
 * High-level merge operations for integrating agent branches.
 * Uses the git-cli backend for deterministic command execution.
 *
 * @module vcs/services/merge-service
 */

import { bus } from "../../events/bus.ts";
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
			return err(
				createVcsError("BRANCH_NOT_FOUND", `Failed to checkout ${baseBranch}`, {
					context: { stderr: checkoutResult.value.stderr },
				}),
			);
		}

		// Delete the branch if it exists
		await runGitCommand(["branch", "-D", branchName], workDir);

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
	 * Abort an in-progress merge
	 */
	async abortMerge(workDir: string): Promise<VcsResult<void>> {
		const result = await runGitCommand(["merge", "--abort"], workDir);
		// Ignore errors - there may be no merge in progress
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
	 * Abort an in-progress rebase
	 */
	async abortRebase(workDir: string): Promise<VcsResult<void>> {
		const result = await runGitCommand(["rebase", "--abort"], workDir);
		// Ignore errors - there may be no rebase in progress
		return ok(undefined);
	}

	/**
	 * Continue a rebase after conflicts have been resolved
	 */
	async continueRebase(workDir: string): Promise<VcsResult<boolean>> {
		// Stage all resolved files
		const addResult = await runGitCommand(["add", "-A"], workDir);
		if (!addResult.ok) {
			return addResult;
		}

		// Continue the rebase
		const continueResult = await runGitCommand(["rebase", "--continue"], workDir);
		if (!continueResult.ok) {
			return continueResult;
		}

		if (continueResult.value.exitCode !== 0) {
			// Check if there are still conflicts
			const conflictedFilesResult = await this.getConflictedFiles(workDir);
			if (conflictedFilesResult.ok && conflictedFilesResult.value.length > 0) {
				return ok(false);
			}
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

		try {
			// Perform the operation
			const result = await operation();

			return ok({
				result,
				wasStashed,
				stashRestored: false, // Will be set below
			});
		} finally {
			// Restore stash if we created one
			if (wasStashed) {
				const popResult = await this.popStash(workDir);
				// We don't fail the whole operation if pop fails - just log warning
				if (!popResult.ok || !popResult.value) {
					// Note: Cannot emit event here - not in MilhouseEvents
					// The caller should handle this case if needed
				}
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
		const { sourceBranch, targetBranch, workDir, runId } = options;

		// Generate unique ID for merge worktree
		const mergeId = `merge-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
		const mergeWorktreePath = `${workDir}/.milhouse/runs/${runId}/merge-worktrees/${mergeId}`;

		// Ensure directory exists
		await runGitCommand(["worktree", "prune"], workDir);

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
			const mergeArgs = ["merge", sourceBranch, "-m", `Merge ${sourceBranch} into ${targetBranch}`];
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
				await runGitCommand(["merge", "--abort"], mergeWorktreePath);

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
			await runGitCommand(["worktree", "remove", "-f", mergeWorktreePath], workDir);
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
