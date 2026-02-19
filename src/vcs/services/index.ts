/**
 * VCS Services
 *
 * High-level VCS operations for task management.
 *
 * @module vcs/services
 */

export {
	// Branch Service
	BranchService,
	createTaskBranch,
	getCurrentBranch,
	getDefaultBaseBranch,
	returnToBaseBranch,
	hasUncommittedChanges,
	branchExists,
	deleteLocalBranch,
	listLocalBranches,
	slugify,
} from "./branch-service.ts";

export {
	// Worktree Service
	WorktreeService,
	createWorktree,
	cleanupWorktree,
	listWorktrees,
	cleanupAllWorktrees,
	getWorktreeBase,
	worktreeExists,
	getWorktreeStatus,
} from "./worktree-service.ts";

export {
	// Merge Service
	MergeService,
	mergeAgentBranch,
	createIntegrationBranch,
	mergeIntoBranch,
	abortMerge,
	completeMerge,
	getConflictedFiles,
	isMergeInProgress,
	getMergeBase,
	// Rebase operations
	rebaseBranch,
	abortRebase,
	continueRebase,
	isRebaseInProgress,
	// New safe merge operations
	checkMergeReadiness,
	safeMergeInWorktree,
	batchMergeWithRetry,
	// Types
	type RebaseResult,
	type MergeReadinessResult,
	type SafeMergeOptions,
	type SafeMergeResult,
	type BatchMergeWithRetryOptions,
	type BatchMergeWithRetryResult,
} from "./merge-service.ts";

export {
	// PR Service
	PrService,
	pushBranch,
	createPullRequest,
	isGhAvailable,
	getPrStatus,
	prExistsForBranch,
	getPrUrlForBranch,
	listOpenPrs,
	getOriginUrl,
} from "./pr-service.ts";
