/**
 * Milhouse VCS Abstraction Layer
 *
 * This module provides a clean abstraction over version control operations,
 * separating business logic from the underlying Git implementation.
 *
 * Architecture:
 * - `backends/` - Low-level Git command execution
 * - `services/` - High-level business operations
 * - `policies/` - Naming conventions and configuration
 * - `types.ts` - Type definitions and interfaces
 *
 * @module vcs
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
	// Core result types
	VcsResult,
	VcsError,
	VcsErrorCode,
	// Branch types
	CreateTaskBranchOptions,
	CreateTaskBranchResult,
	ReturnToBaseBranchOptions,
	BranchInfo,
	DeleteBranchResult,
	// Worktree types
	CreateWorktreeOptions,
	CreateWorktreeResult,
	CleanupWorktreeOptions,
	CleanupWorktreeResult,
	WorktreeInfo,
	WorktreeStatus,
	// Merge types
	MergeBranchOptions,
	MergeResult,
	BatchMergeResult,
	CreateIntegrationBranchOptions,
	// PR types
	PushBranchOptions,
	PushBranchResult,
	CreatePullRequestOptions,
	CreatePullRequestResult,
	PrStatus,
	PrInfo,
	// Backend types
	GitCommandOptions,
	GitCommandResult,
	GitCommandError,
	// Event types
	VcsEventType,
	VcsEventPayload,
	BranchEventPayload,
	WorktreeEventPayload,
	MergeEventPayload,
	CommandEventPayload,
	// Service interfaces
	IBranchService,
	IWorktreeService,
	IMergeService,
	IPrService,
} from "./types";

// ============================================================================
// Helper Function Exports
// ============================================================================

export { ok, err, createVcsError } from "./types";

// ============================================================================
// Backend Exports
// ============================================================================

export {
	runGitCommand,
	parseStatusPorcelain,
	parseWorktreeListPorcelain,
	parseBranchListPorcelain,
	parseDiffNameOnly,
	parseGitLogOneline,
	parseDiffNumstat,
	getCommitsSinceBase,
	getDiffStats,
	getDiffContent,
	GitCliError,
	gitCliBackend,
} from "./backends/git-cli";

export type { VcsBackend, CommitEntry, DiffStats } from "./backends/types";

// ============================================================================
// Policy Exports
// ============================================================================

export {
	makeAgentBranchName,
	makeTaskBranchName,
	makeIntegrationBranchName,
	slugify,
	DEFAULT_NAMING_CONFIG,
} from "./policies/naming";

export {
	getWorktreeRoot,
	getWorktreePath,
	isMillhouseWorktree,
	DEFAULT_WORKTREE_CONFIG,
} from "./policies/worktree-locations";

// ============================================================================
// Service Exports
// ============================================================================

export {
	BranchService,
	createTaskBranch,
	getCurrentBranch,
	getDefaultBaseBranch,
	returnToBaseBranch,
	hasUncommittedChanges,
	branchExists,
	deleteLocalBranch,
	listLocalBranches,
} from "./services/branch-service";

export {
	WorktreeService,
	createWorktree,
	cleanupWorktree,
	listWorktrees,
	cleanupAllWorktrees,
	getWorktreeBase,
	worktreeExists,
	getWorktreeStatus,
} from "./services/worktree-service";

export {
	MergeService,
	mergeAgentBranch,
	createIntegrationBranch,
	mergeIntoBranch,
	abortMerge,
	completeMerge,
	getConflictedFiles,
	isMergeInProgress,
	getMergeBase,
	rebaseBranch,
	abortRebase,
	continueRebase,
	isRebaseInProgress,
	checkMergeReadiness,
	safeMergeInWorktree,
	batchMergeWithRetry,
	stashChanges,
	popStash,
	withAutoStash,
} from "./services/merge-service";

export type {
	RebaseResult,
	MergeReadinessResult,
	SafeMergeOptions,
	SafeMergeResult,
	BatchMergeWithRetryOptions,
	BatchMergeWithRetryResult,
	StashResult,
	AutoStashResult,
} from "./services/merge-service";

export {
	PrService,
	pushBranch,
	createPullRequest,
	isGhAvailable,
	getPrStatus,
	prExistsForBranch,
	getPrUrlForBranch,
	listOpenPrs,
	getOriginUrl,
} from "./services/pr-service";
