/**
 * Milhouse VCS Abstraction Layer Types
 *
 * This module defines the core types and interfaces for the version control
 * system abstraction layer. It provides a clean separation between VCS
 * operations and their underlying implementations.
 *
 * @module vcs/types
 */

// ============================================================================
// Core Result Types
// ============================================================================

/**
 * Discriminated union for operation results
 * Provides type-safe success/failure handling
 */
export type VcsResult<T, E = VcsError> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Base error type for VCS operations
 */
export interface VcsError {
	/** Error code for programmatic handling */
	code: VcsErrorCode;
	/** Human-readable error message */
	message: string;
	/** Original error if wrapped */
	cause?: Error;
	/** Additional context for debugging */
	context?: Record<string, unknown>;
}

/**
 * Error codes for VCS operations
 */
export type VcsErrorCode =
	| "COMMAND_FAILED"
	| "COMMAND_TIMEOUT"
	| "NOT_A_REPOSITORY"
	| "BRANCH_NOT_FOUND"
	| "BRANCH_EXISTS"
	| "BRANCH_LOCKED" // Branch checked out in another worktree
	| "DIRTY_WORKTREE" // Uncommitted changes prevent checkout
	| "WORKTREE_NOT_FOUND"
	| "WORKTREE_EXISTS"
	| "MERGE_CONFLICT"
	| "MERGE_FAILED"
	| "REBASE_FAILED"
	| "PUSH_FAILED"
	| "PR_CREATION_FAILED"
	| "GH_CLI_NOT_AVAILABLE"
	| "GIT_LOG_FAILED" // git log command failed
	| "UNCOMMITTED_CHANGES"
	| "INVALID_ARGUMENT"
	| "UNKNOWN_ERROR";

// ============================================================================
// Branch Service Types
// ============================================================================

/**
 * Options for creating a task branch
 */
export interface CreateTaskBranchOptions {
	/** Task identifier for branch naming */
	task: string;
	/** Base branch to create from */
	baseBranch: string;
	/** Working directory for git operations */
	workDir?: string;
	/** Whether to stash uncommitted changes */
	stashChanges?: boolean;
	/** Custom branch prefix override */
	branchPrefix?: string;
}

/**
 * Result of creating a task branch
 */
export interface CreateTaskBranchResult {
	/** The created branch name */
	branchName: string;
	/** Whether changes were stashed */
	stashed: boolean;
	/** Previous branch before operation */
	previousBranch: string;
}

/**
 * Options for returning to base branch
 */
export interface ReturnToBaseBranchOptions {
	/** The base branch to return to */
	baseBranch: string;
	/** Working directory for git operations */
	workDir?: string;
	/** Whether to restore stashed changes */
	restoreStash?: boolean;
}

/**
 * Information about a local branch
 */
export interface BranchInfo {
	/** Branch name */
	name: string;
	/** Whether this is the current branch */
	current: boolean;
	/** Commit hash at branch tip */
	commit?: string;
	/** Upstream tracking branch */
	upstream?: string;
}

/**
 * Result of deleting a branch
 */
export interface DeleteBranchResult {
	/** Whether deletion succeeded */
	deleted: boolean;
	/** Branch name that was deleted */
	branchName: string;
}

// ============================================================================
// Worktree Service Types
// ============================================================================

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
	/** Task identifier for naming */
	task: string;
	/** Agent identifier (optional) */
	agent?: string;
	/** Base branch to create from */
	baseBranch: string;
	/** Run ID for isolation */
	runId: string;
	/** Working directory (main repo) */
	workDir: string;
}

/**
 * Result of creating a worktree
 */
export interface CreateWorktreeResult {
	/** Path to the created worktree */
	worktreePath: string;
	/** Branch name associated with worktree */
	branchName: string;
	/** Unique worktree identifier */
	worktreeId: string;
}

/**
 * Options for cleaning up a worktree
 */
export interface CleanupWorktreeOptions {
	/** Path to the worktree */
	path: string;
	/** Original repository directory */
	originalDir: string;
	/** Whether to force removal even with changes */
	force?: boolean;
}

/**
 * Result of cleaning up a worktree
 */
export interface CleanupWorktreeResult {
	/** Whether worktree was left in place (due to changes) */
	leftInPlace: boolean;
	/** Reason if left in place */
	reason?: string;
}

/**
 * Information about a worktree
 */
export interface WorktreeInfo {
	/** Worktree path */
	path: string;
	/** Associated branch name */
	branch: string;
	/** HEAD commit hash */
	head: string;
	/** Whether this is the main worktree */
	isMain: boolean;
	/** Whether this is a Milhouse-managed worktree */
	isMillhouse: boolean;
}

/**
 * Status information for a worktree
 */
export interface WorktreeStatus {
	/** Whether the worktree exists */
	exists: boolean;
	/** Whether there are uncommitted changes */
	hasChanges: boolean;
	/** Number of modified files */
	modifiedCount: number;
	/** Number of untracked files */
	untrackedCount: number;
}

// ============================================================================
// Merge Service Types
// ============================================================================

/**
 * Options for merging a branch
 */
export interface MergeBranchOptions {
	/** Source branch to merge from */
	source: string;
	/** Target branch to merge into */
	target: string;
	/** Working directory for git operations */
	workDir: string;
	/** Custom merge message */
	message?: string;
	/** Whether to allow fast-forward merges */
	allowFastForward?: boolean;
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
	/** Whether merge succeeded */
	success: boolean;
	/** Whether there are conflicts */
	hasConflicts: boolean;
	/** List of conflicted files */
	conflictedFiles: string[];
	/** Merge commit hash if successful */
	mergeCommit?: string;
}

/**
 * Result of batch merge operation
 */
export interface BatchMergeResult {
	/** Branches that merged successfully */
	succeeded: string[];
	/** Branches that failed to merge */
	failed: string[];
	/** Branches with conflicts */
	conflicted: string[];
}

/**
 * Options for creating an integration branch
 */
export interface CreateIntegrationBranchOptions {
	/** Group number for naming */
	groupNum: number;
	/** Base branch to create from */
	baseBranch: string;
	/** Working directory for git operations */
	workDir: string;
}

// ============================================================================
// PR Service Types
// ============================================================================

/**
 * Options for pushing a branch
 */
export interface PushBranchOptions {
	/** Branch to push */
	branch: string;
	/** Working directory for git operations */
	workDir?: string;
	/** Whether to set upstream tracking */
	setUpstream?: boolean;
	/** Whether to force push */
	force?: boolean;
}

/**
 * Result of pushing a branch
 */
export interface PushBranchResult {
	/** Whether push succeeded */
	success: boolean;
	/** Remote URL pushed to */
	remote?: string;
}

/**
 * Options for creating a pull request
 */
export interface CreatePullRequestOptions {
	/** Branch to create PR from */
	branch: string;
	/** Base branch for the PR */
	baseBranch: string;
	/** PR title */
	title: string;
	/** PR body/description */
	body: string;
	/** Working directory for git operations */
	workDir?: string;
	/** Whether to create as draft */
	draft?: boolean;
	/** Labels to add */
	labels?: string[];
	/** Reviewers to request */
	reviewers?: string[];
}

/**
 * Result of creating a pull request
 */
export interface CreatePullRequestResult {
	/** PR URL */
	url: string;
	/** PR number */
	number: number;
}

/**
 * PR state information
 */
export interface PrStatus {
	/** Whether a PR exists */
	exists: boolean;
	/** PR state (open, closed, merged) */
	state?: "open" | "closed" | "merged";
	/** PR URL */
	url?: string;
	/** PR number */
	number?: number;
	/** PR title */
	title?: string;
}

/**
 * Information about an open PR
 */
export interface PrInfo {
	/** PR number */
	number: number;
	/** PR title */
	title: string;
	/** PR URL */
	url: string;
	/** Head branch */
	headBranch: string;
	/** Base branch */
	baseBranch: string;
	/** PR state */
	state: "open" | "closed" | "merged";
	/** Whether it's a draft */
	isDraft: boolean;
}

// ============================================================================
// Backend Types
// ============================================================================

/**
 * Options for executing a git command
 */
export interface GitCommandOptions {
	/** Working directory */
	cwd?: string;
	/** Command timeout in milliseconds */
	timeout?: number;
	/** Environment variables */
	env?: Record<string, string>;
	/** Whether to capture stderr */
	captureStderr?: boolean;
}

/**
 * Result of a git command execution
 */
export interface GitCommandResult {
	/** Exit code */
	exitCode: number;
	/** Standard output */
	stdout: string;
	/** Standard error */
	stderr: string;
	/** Whether command timed out */
	timedOut: boolean;
	/** Execution duration in milliseconds */
	duration: number;
}

/**
 * Structured error for git command failures
 */
export interface GitCommandError extends VcsError {
	code: "COMMAND_FAILED" | "COMMAND_TIMEOUT";
	/** The command that was executed */
	command: string;
	/** Command arguments */
	args: string[];
	/** Exit code if available */
	exitCode?: number;
	/** Standard error output */
	stderr?: string;
}

// ============================================================================
// Event Types (for observability middleware)
// ============================================================================

/**
 * VCS event types for observability
 */
export type VcsEventType =
	| "vcs:branch:create"
	| "vcs:branch:delete"
	| "vcs:branch:checkout"
	| "vcs:worktree:create"
	| "vcs:worktree:cleanup"
	| "vcs:merge:start"
	| "vcs:merge:complete"
	| "vcs:merge:conflict"
	| "vcs:push:start"
	| "vcs:push:complete"
	| "vcs:pr:create"
	| "vcs:command:execute";

/**
 * Base event payload
 */
export interface VcsEventPayload {
	/** Timestamp of the event */
	timestamp: number;
	/** Working directory */
	workDir?: string;
}

/**
 * Branch event payload
 */
export interface BranchEventPayload extends VcsEventPayload {
	/** Branch name */
	branchName: string;
}

/**
 * Worktree event payload
 */
export interface WorktreeEventPayload extends VcsEventPayload {
	/** Worktree path */
	path: string;
	/** Associated branch */
	branch?: string;
}

/**
 * Merge event payload
 */
export interface MergeEventPayload extends VcsEventPayload {
	/** Source branch */
	source: string;
	/** Target branch */
	target: string;
	/** Conflicted files (if any) */
	conflictedFiles?: string[];
}

/**
 * Command event payload
 */
export interface CommandEventPayload extends VcsEventPayload {
	/** Command executed */
	command: string;
	/** Command arguments */
	args: string[];
	/** Execution duration */
	duration?: number;
	/** Exit code */
	exitCode?: number;
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Branch service interface
 */
export interface IBranchService {
	createTaskBranch(options: CreateTaskBranchOptions): Promise<VcsResult<CreateTaskBranchResult>>;
	getCurrentBranch(workDir?: string): Promise<VcsResult<string>>;
	getDefaultBaseBranch(workDir?: string): Promise<VcsResult<string>>;
	returnToBaseBranch(options: ReturnToBaseBranchOptions): Promise<VcsResult<void>>;
	hasUncommittedChanges(workDir?: string): Promise<VcsResult<boolean>>;
	branchExists(branchName: string, workDir?: string): Promise<VcsResult<boolean>>;
	deleteLocalBranch(
		branchName: string,
		workDir?: string,
		force?: boolean,
	): Promise<VcsResult<DeleteBranchResult>>;
	listLocalBranches(workDir?: string): Promise<VcsResult<BranchInfo[]>>;
}

/**
 * Worktree service interface
 */
export interface IWorktreeService {
	createWorktree(options: CreateWorktreeOptions): Promise<VcsResult<CreateWorktreeResult>>;
	cleanupWorktree(options: CleanupWorktreeOptions): Promise<VcsResult<CleanupWorktreeResult>>;
	listWorktrees(workDir: string): Promise<VcsResult<WorktreeInfo[]>>;
	cleanupAllWorktrees(workDir: string): Promise<VcsResult<void>>;
	getWorktreeBase(workDir: string): string;
	worktreeExists(path: string): Promise<VcsResult<boolean>>;
	getWorktreeStatus(path: string): Promise<VcsResult<WorktreeStatus>>;
}

/**
 * Merge service interface
 */
export interface IMergeService {
	mergeAgentBranch(options: MergeBranchOptions): Promise<VcsResult<MergeResult>>;
	createIntegrationBranch(options: CreateIntegrationBranchOptions): Promise<VcsResult<string>>;
	mergeIntoBranch(
		sourceBranches: string[],
		targetBranch: string,
		workDir: string,
	): Promise<VcsResult<BatchMergeResult>>;
	abortMerge(workDir: string): Promise<VcsResult<void>>;
	completeMerge(workDir: string, resolvedFiles: string[]): Promise<VcsResult<boolean>>;
	getConflictedFiles(workDir: string): Promise<VcsResult<string[]>>;
	isMergeInProgress(workDir: string): Promise<VcsResult<boolean>>;
	getMergeBase(branch1: string, branch2: string, workDir: string): Promise<VcsResult<string>>;
}

/**
 * PR service interface
 */
export interface IPrService {
	pushBranch(options: PushBranchOptions): Promise<VcsResult<PushBranchResult>>;
	createPullRequest(options: CreatePullRequestOptions): Promise<VcsResult<CreatePullRequestResult>>;
	isGhAvailable(): Promise<boolean>;
	getPrStatus(branch: string, workDir?: string): Promise<VcsResult<PrStatus>>;
	prExistsForBranch(branch: string, workDir?: string): Promise<VcsResult<boolean>>;
	getPrUrlForBranch(branch: string, workDir?: string): Promise<VcsResult<string | null>>;
	listOpenPrs(workDir?: string, limit?: number): Promise<VcsResult<PrInfo[]>>;
	getOriginUrl(workDir?: string): Promise<VcsResult<string | null>>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a successful result
 */
export function ok<T>(value: T): VcsResult<T> {
	return { ok: true, value };
}

/**
 * Create a failed result
 */
export function err<E extends VcsError>(error: E): VcsResult<never, E> {
	return { ok: false, error };
}

/**
 * Create a VCS error
 */
export function createVcsError(
	code: VcsErrorCode,
	message: string,
	options?: { cause?: Error; context?: Record<string, unknown> },
): VcsError {
	return {
		code,
		message,
		cause: options?.cause,
		context: options?.context,
	};
}
