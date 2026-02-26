/**
 * Rebase-Then-Merge Module
 *
 * Extracts the merge/rebase orchestration logic from issue-executor into
 * a shared module. The exec phase merges completed branches back to the
 * base branch after all parallel agents finish. This module encapsulates
 * that sequential rebase-then-merge strategy.
 *
 * Strategy overview:
 * 1. Process branches SEQUENTIALLY (order matters — each merge changes target)
 * 2. Rebase each branch onto latest target
 * 3. If rebase conflicts, use AI to resolve
 * 4. Fast-forward merge after clean rebase
 * 5. Retry up to MAX_MERGE_RETRIES times per branch
 * 6. Fall back to direct merge if rebase fails
 *
 * @module execution/merge/rebase-merge
 * @since 0.2.0
 */

import type { AIEngine } from "../../engines/types.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../../ui/logger.ts";
import { branchExists, deleteLocalBranch } from "../../vcs/services/branch-service.ts";
import {
	type RebaseResult,
	abortMerge,
	abortRebase,
	mergeAgentBranch,
	rebaseBranch,
} from "../../vcs/services/merge-service.ts";
import {
	type ConflictIssueContext,
	createMergeConflictInfo,
	resolveConflictsWithEngine,
} from "../runtime/conflict-resolution.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Info about an issue for creating human-readable merge commit messages
 */
export interface IssueInfo {
	/** Issue ID */
	id: string;
	/** Human-readable description (title or symptom) */
	title: string;
}

/**
 * Result of a single branch merge attempt
 */
export interface BranchMergeResult {
	/** Branch name */
	branch: string;
	/** Whether merge succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Options for the rebase-then-merge orchestration
 */
export interface RebaseMergeOptions {
	/** Branches to merge (processed sequentially) */
	branches: string[];
	/** Target branch to merge into */
	targetBranch: string;
	/** AI engine for conflict resolution */
	engine: AIEngine;
	/** Working directory */
	workDir: string;
	/** Map of branch name to issue info for commit messages */
	branchToIssueInfo: Map<string, IssueInfo>;
	/** Optional model override for AI engine */
	modelOverride?: string;
	/** Maximum retry attempts per branch (default: 3) */
	maxRetries?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default maximum number of retry attempts for merge conflicts
 */
const DEFAULT_MAX_MERGE_RETRIES = 3;

// ============================================================================
// Main Function
// ============================================================================

/**
 * Merge completed branches back to base using rebase-then-merge strategy.
 *
 * Processes branches SEQUENTIALLY because each successful merge changes
 * the target branch state. Subsequent branches must rebase onto the NEW
 * target state. Parallel merges would cause conflicts and race conditions.
 *
 * For each branch the algorithm attempts:
 * 1. Rebase onto latest target
 * 2. If clean rebase -> fast-forward merge
 * 3. If rebase conflicts -> AI resolution -> merge
 * 4. If rebase error -> direct merge fallback
 * 5. Retry up to maxRetries times
 *
 * @param options - Merge options
 * @returns Array of results for each branch
 */
export async function mergeCompletedBranches(
	options: RebaseMergeOptions,
): Promise<BranchMergeResult[]> {
	const {
		branches,
		targetBranch,
		engine,
		workDir,
		branchToIssueInfo,
		modelOverride,
		maxRetries = DEFAULT_MAX_MERGE_RETRIES,
	} = options;

	const results: BranchMergeResult[] = [];

	if (branches.length === 0) return results;

	logInfo(
		`Merging ${branches.length} branch(es) into ${targetBranch} using rebase-then-merge strategy`,
	);
	logInfo("Branches will be merged SEQUENTIALLY to avoid conflicts");

	for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
		const branch = branches[branchIndex];
		let success = false;
		let lastError: string | undefined;

		logInfo(`\n[Branch ${branchIndex + 1}/${branches.length}] Processing ${branch}...`);

		// Check if branch exists (it might have been deleted during cleanup)
		const existsResult = await branchExists(branch, workDir);
		if (!existsResult.ok || !existsResult.value) {
			logWarn(`Branch ${branch} does not exist (may have been cleaned up), skipping`);
			results.push({ branch, success: false, error: "Branch does not exist" });
			continue;
		}

		// Retry loop for this branch
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			logInfo(`  [Attempt ${attempt}/${maxRetries}]`);

			logDebug(`  Checking out target branch ${targetBranch} before rebase...`);

			// Try to rebase the branch onto the latest target
			const rebaseResultVcs = await rebaseBranch(branch, targetBranch, workDir);

			// Handle VcsResult — extract the RebaseResult or create error result
			let rebaseResult: RebaseResult & { error?: string; stderr?: string; errorCode?: string };
			if (!rebaseResultVcs.ok) {
				const errorCode = rebaseResultVcs.error.code;
				const errorMessage = rebaseResultVcs.error.message;
				const stderr = rebaseResultVcs.error.context?.stderr as string | undefined;

				rebaseResult = {
					success: false,
					hasConflicts: false,
					conflictedFiles: [],
					error: errorMessage,
					stderr,
					errorCode,
				};

				if (errorCode === "DIRTY_WORKTREE") {
					logError("  ✗ Cannot rebase: worktree has uncommitted changes");
					logInfo("    Suggestion: Commit or stash changes before merge");
				} else if (errorCode === "BRANCH_LOCKED") {
					logError("  ✗ Cannot rebase: branch is checked out in another worktree");
					logDebug(
						"    This is likely caused by a worktree cleanup failure during the cleanup phase. " +
							"The branch lock cannot be released by retrying.",
					);
					logInfo(`    Suggestion: Remove the worktree first with 'git worktree remove'`);
					// BRANCH_LOCKED is permanent - retrying cannot succeed, break immediately
					lastError = `Branch ${branch} is locked by another worktree (cleanup failure)`;
					break;
				} else if (errorCode === "BRANCH_NOT_FOUND") {
					logError(`  ✗ Cannot rebase: branch ${branch} not found`);
				} else {
					logError(`  ✗ Rebase failed: ${errorMessage}`);
				}
			} else {
				rebaseResult = rebaseResultVcs.value;
			}

			// --- Clean rebase: fast-forward merge ---
			if (rebaseResult.success) {
				logDebug("  ✓ Rebase succeeded, performing merge...");

				const issueInfo = branchToIssueInfo.get(branch);
				const commitMessage = issueInfo ? issueInfo.title : undefined;

				const mergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
					message: commitMessage,
				});

				if (mergeResultVcs.ok && mergeResultVcs.value.success) {
					logSuccess(`  ✓ Successfully merged ${branch}`);
					await deleteLocalBranch(branch, workDir, true);
					success = true;
					break;
				}

				lastError = !mergeResultVcs.ok
					? mergeResultVcs.error.message
					: "Merge failed after successful rebase";
				logWarn(`  ✗ Merge failed after rebase: ${lastError}`);
				await abortMerge(workDir);
				continue;
			}

			// --- Rebase conflicts: AI resolution ---
			if (rebaseResult.hasConflicts && rebaseResult.conflictedFiles) {
				logWarn(
					`  ⚠ Rebase conflict (${rebaseResult.conflictedFiles.length} files): ${rebaseResult.conflictedFiles.join(", ")}`,
				);
				logInfo("  Attempting AI resolution...");

				const conflicts = createMergeConflictInfo(
					rebaseResult.conflictedFiles,
					branch,
					targetBranch,
				);
				const issueCtx = branchToIssueInfo.get(branch);
				const conflictIssueCtx: ConflictIssueContext | undefined = issueCtx
					? { id: issueCtx.id, title: issueCtx.title }
					: undefined;
				const resolutionResult = await resolveConflictsWithEngine(
					engine,
					conflicts,
					workDir,
					modelOverride,
					conflictIssueCtx,
				);
				const resolved = resolutionResult.success;

				const issueInfoForConflict = branchToIssueInfo.get(branch);

				if (resolved) {
					logDebug("  ✓ AI resolved conflicts");

					const mergeResultVcs2 = await mergeAgentBranch(branch, targetBranch, workDir, {
						message: issueInfoForConflict?.title,
					});

					if (mergeResultVcs2.ok && mergeResultVcs2.value.success) {
						logSuccess(`  ✓ Successfully merged ${branch} after AI conflict resolution`);
						await deleteLocalBranch(branch, workDir, true);
						success = true;
						break;
					}

					lastError = !mergeResultVcs2.ok
						? mergeResultVcs2.error.message
						: "Merge failed after conflict resolution";
					logWarn(`  ✗ Merge failed after AI resolution: ${lastError}`);
					await abortMerge(workDir);
					continue;
				}

				// AI couldn't resolve conflicts
				lastError = `AI failed to resolve rebase conflicts (${rebaseResult.conflictedFiles.join(", ")})`;
				logWarn(`  ✗ ${lastError}`);
				await abortRebase(workDir);

				// Fall back to direct merge with AI resolution
				if (attempt < maxRetries) {
					const directResult = await tryDirectMerge(
						branch,
						targetBranch,
						workDir,
						engine,
						issueInfoForConflict,
						modelOverride,
						conflictIssueCtx,
					);
					if (directResult.success) {
						success = true;
						break;
					}
				}

				continue;
			}

			// --- Other rebase error (not conflict) ---
			lastError = rebaseResult.error || "Unknown rebase error";
			logError(`  ✗ Rebase error: ${lastError}`);

			if (rebaseResult.stderr) {
				logDebug(`  Git stderr: ${rebaseResult.stderr}`);
			}
			if (rebaseResult.errorCode) {
				logDebug(`  Error code: ${rebaseResult.errorCode}`);
			}

			await abortRebase(workDir);

			// For non-conflict errors, try direct merge as fallback
			if (attempt < maxRetries) {
				logInfo("  Attempting direct merge as fallback for non-conflict error...");

				const issueInfoForDirect = branchToIssueInfo.get(branch);
				const directMergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
					message: issueInfoForDirect?.title,
				});

				if (directMergeResultVcs.ok && directMergeResultVcs.value.success) {
					logSuccess("  ✓ Direct merge succeeded (bypassed rebase)");
					await deleteLocalBranch(branch, workDir, true);
					success = true;
					break;
				}

				if (directMergeResultVcs.ok && directMergeResultVcs.value.hasConflicts) {
					logWarn("  ⚠ Direct merge has conflicts");
					await abortMerge(workDir);
				}
			}
		}

		results.push({
			branch,
			success,
			error: success ? undefined : lastError,
		});

		if (!success) {
			logError(`  ✗ Failed to merge ${branch} after ${maxRetries} attempts`);
			logWarn("  Branch preserved for manual inspection");
			logInfo(`  Manual merge: git checkout ${targetBranch} && git merge --no-ff ${branch}`);
		}
	}

	// Summary
	logInfo(`\n${"─".repeat(60)}`);
	const succeeded = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;

	if (failed > 0) {
		logWarn(`Merge summary: ${succeeded}/${branches.length} succeeded, ${failed} failed`);
		logInfo("\nFailed branches:");
		for (const result of results.filter((r) => !r.success)) {
			logError(`  - ${result.branch}: ${result.error}`);
		}
	} else {
		logSuccess(`All ${succeeded} branch(es) merged successfully`);
	}

	return results;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Attempt a direct merge (skip rebase) with optional AI conflict resolution.
 *
 * This is used as a fallback when rebase fails.
 */
async function tryDirectMerge(
	branch: string,
	targetBranch: string,
	workDir: string,
	engine: AIEngine,
	issueInfo: IssueInfo | undefined,
	modelOverride?: string,
	issueContext?: ConflictIssueContext,
): Promise<{ success: boolean }> {
	logInfo("  Attempting direct merge as fallback...");

	const directMergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
		message: issueInfo?.title,
	});

	if (directMergeResultVcs.ok && directMergeResultVcs.value.success) {
		logSuccess("  ✓ Direct merge succeeded");
		await deleteLocalBranch(branch, workDir, true);
		return { success: true };
	}

	if (
		directMergeResultVcs.ok &&
		directMergeResultVcs.value.hasConflicts &&
		directMergeResultVcs.value.conflictedFiles
	) {
		logWarn("  ⚠ Direct merge has conflicts, attempting AI resolution...");

		const directConflicts = createMergeConflictInfo(
			directMergeResultVcs.value.conflictedFiles,
			branch,
			targetBranch,
		);
		const directResolutionResult = await resolveConflictsWithEngine(
			engine,
			directConflicts,
			workDir,
			modelOverride,
			issueContext,
		);

		if (directResolutionResult.success) {
			logSuccess("  ✓ Direct merge with AI resolution succeeded");
			await deleteLocalBranch(branch, workDir, true);
			return { success: true };
		}

		await abortMerge(workDir);
	}

	return { success: false };
}
