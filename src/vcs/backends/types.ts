/**
 * VCS Backend Types
 *
 * Defines the interface for VCS backend implementations.
 * Backends handle low-level command execution and output parsing.
 *
 * @module vcs/backends/types
 */

import type { GitCommandOptions, GitCommandResult, VcsResult } from "../types.ts";

/**
 * Parsed status entry from git status --porcelain
 */
export interface StatusEntry {
	/** Index status (staged) */
	index: string;
	/** Worktree status (unstaged) */
	worktree: string;
	/** File path */
	path: string;
	/** Original path (for renames) */
	origPath?: string;
}

/**
 * Parsed worktree entry from git worktree list --porcelain
 */
export interface WorktreeEntry {
	/** Worktree path */
	worktree: string;
	/** HEAD commit hash */
	head: string;
	/** Branch name (without refs/heads/) */
	branch?: string;
	/** Whether HEAD is detached */
	detached: boolean;
	/** Whether this is bare */
	bare: boolean;
}

/**
 * Parsed branch entry from git branch --list
 */
export interface BranchEntry {
	/** Branch name */
	name: string;
	/** Whether this is the current branch */
	current: boolean;
	/** Commit hash */
	commit?: string;
	/** Upstream tracking branch */
	upstream?: string;
	/** Ahead/behind counts */
	tracking?: {
		ahead: number;
		behind: number;
	};
}

/**
 * Commit entry from git log --oneline output
 */
export interface CommitEntry {
	/** Short or full commit hash */
	hash: string;
	/** Commit message (first line) */
	message: string;
}

/**
 * Git diff statistics for a file
 */
export interface DiffStats {
	/** File path */
	file: string;
	/** Number of lines added */
	linesAdded: number;
	/** Number of lines removed */
	linesRemoved: number;
	/** Whether file is new */
	isNew: boolean;
	/** Whether file is deleted */
	isDeleted: boolean;
	/** Whether file is renamed */
	isRenamed: boolean;
	/** Original file path if renamed */
	originalPath?: string;
	/** Binary file flag */
	isBinary: boolean;
}

/**
 * VCS Backend interface
 *
 * Backends provide low-level access to version control operations.
 * They handle command execution, output parsing, and error handling.
 */
export interface VcsBackend {
	/**
	 * Execute a git command
	 *
	 * @param args - Command arguments (without 'git' prefix)
	 * @param options - Execution options
	 * @returns Command result with stdout, stderr, exit code
	 */
	runCommand(args: string[], options?: GitCommandOptions): Promise<VcsResult<GitCommandResult>>;

	/**
	 * Parse git status --porcelain output
	 *
	 * @param output - Raw porcelain output
	 * @returns Parsed status entries
	 */
	parseStatusPorcelain(output: string): StatusEntry[];

	/**
	 * Parse git worktree list --porcelain output
	 *
	 * @param output - Raw porcelain output
	 * @returns Parsed worktree entries
	 */
	parseWorktreeListPorcelain(output: string): WorktreeEntry[];

	/**
	 * Parse git branch --list output
	 *
	 * @param output - Raw branch list output
	 * @returns Parsed branch entries
	 */
	parseBranchListPorcelain(output: string): BranchEntry[];

	/**
	 * Parse git diff --name-only output
	 *
	 * @param output - Raw diff output
	 * @returns Array of file paths
	 */
	parseDiffNameOnly(output: string): string[];

	/**
	 * Parse git log --oneline output
	 *
	 * @param output - Raw git log --oneline output
	 * @returns Parsed commit entries
	 */
	parseGitLogOneline(output: string): CommitEntry[];

	/**
	 * Parse git diff --numstat output
	 *
	 * @param output - Raw numstat output
	 * @returns Parsed diff stats entries
	 */
	parseDiffNumstat(output: string): DiffStats[];
}

/**
 * Default timeout for git commands in milliseconds
 */
export const DEFAULT_GIT_TIMEOUT = 30_000;

/**
 * Default environment variables for git commands
 */
export const DEFAULT_GIT_ENV: Record<string, string> = {
	// Disable pager for all commands
	GIT_PAGER: "",
	// Use English for consistent parsing
	LANG: "C",
	LC_ALL: "C",
};
