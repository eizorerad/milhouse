/**
 * VCS Worktree Location Policies
 *
 * Centralized configuration for worktree directory structure.
 * Uses .milhouse/work/worktrees/ for all worktrees to avoid
 * polluting the runs/ directory with temporary execution data.
 *
 * @module vcs/policies/worktree-locations
 */

import { join } from "node:path";

/**
 * Configuration for worktree locations
 */
export interface WorktreeConfig {
	/** Base directory name for Milhouse state */
	stateDir: string;
	/** Subdirectory for work (worktrees, branches) */
	workDir: string;
	/** Subdirectory for worktrees within work/ */
	worktreesDir: string;
	/** Legacy base directory name (for backward compatibility) */
	legacyBaseDirName: string;
	/** Legacy runs-based worktree pattern (for cleanup) */
	legacyRunsPattern: RegExp;
	/** Pattern to identify Milhouse worktrees */
	identifierPattern: RegExp;
}

/**
 * Default worktree configuration for Milhouse
 */
export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
	stateDir: ".milhouse",
	workDir: "work",
	worktreesDir: "worktrees",
	legacyBaseDirName: ".milhouse-worktrees",
	legacyRunsPattern: /\.milhouse\/runs\/(?:issue-|run-)[^/]+\/worktrees/,
	identifierPattern: /\.milhouse(?:-worktrees|\/work\/worktrees|\/runs\/[^/]+\/worktrees)/,
};

/**
 * Get the root directory for all worktrees
 *
 * New layout: .milhouse/work/worktrees/
 * This keeps worktrees separate from runs/ to avoid polluting
 * the pipeline run directories with temporary execution data.
 *
 * @param workDir - The working directory (main repo)
 * @param _runId - The run identifier (kept for API compatibility, but not used in path)
 * @returns The worktree root directory path
 *
 * @example
 * ```ts
 * getWorktreeRoot("/path/to/repo", "run-abc123")
 * // "/path/to/repo/.milhouse/work/worktrees"
 * ```
 */
export function getWorktreeRoot(workDir: string, _runId: string): string {
	return join(
		workDir,
		DEFAULT_WORKTREE_CONFIG.stateDir,
		DEFAULT_WORKTREE_CONFIG.workDir,
		DEFAULT_WORKTREE_CONFIG.worktreesDir,
	);
}

/**
 * Get the path for a specific worktree
 *
 * @param workDir - The working directory (main repo)
 * @param runId - The run identifier (used in worktree subdirectory name)
 * @param taskId - The task identifier
 * @returns The worktree directory path
 *
 * @example
 * ```ts
 * getWorktreePath("/path/to/repo", "run-abc123", "task-1")
 * // "/path/to/repo/.milhouse/work/worktrees/run-abc123-task-1"
 * ```
 */
export function getWorktreePath(workDir: string, runId: string, taskId: string): string {
	// Combine runId and taskId into a single directory name to keep flat structure
	const worktreeName = `${runId}-${taskId}`;
	return join(getWorktreeRoot(workDir, runId), worktreeName);
}

/**
 * Check if a path is a Milhouse-managed worktree
 *
 * Detects:
 * - New layout (.milhouse/work/worktrees/)
 * - Legacy runs layout (.milhouse/runs/{runId}/worktrees/)
 * - Legacy base layout (.milhouse-worktrees/)
 *
 * @param path - The path to check
 * @returns True if the path is a Milhouse worktree
 *
 * @example
 * ```ts
 * isMillhouseWorktree("/path/to/repo/.milhouse/work/worktrees/run-123-task-1")
 * // true
 *
 * isMillhouseWorktree("/path/to/repo/.milhouse/runs/run-123/worktrees/task-1")
 * // true (legacy runs layout)
 *
 * isMillhouseWorktree("/path/to/repo/.milhouse-worktrees/agent-1")
 * // true (legacy base layout)
 *
 * isMillhouseWorktree("/path/to/other/worktree")
 * // false
 * ```
 */
export function isMillhouseWorktree(path: string): boolean {
	return DEFAULT_WORKTREE_CONFIG.identifierPattern.test(path);
}

/**
 * Check if a path is using the legacy runs-based worktree layout
 *
 * @param path - The path to check
 * @returns True if using legacy runs layout (.milhouse/runs/{id}/worktrees/)
 */
export function isLegacyRunsWorktreePath(path: string): boolean {
	return DEFAULT_WORKTREE_CONFIG.legacyRunsPattern.test(path);
}

/**
 * Get the legacy worktree base directory
 *
 * Used for backward compatibility with existing worktrees.
 *
 * @param workDir - The working directory
 * @returns The legacy worktree base directory path
 */
export function getLegacyWorktreeBase(workDir: string): string {
	return join(workDir, DEFAULT_WORKTREE_CONFIG.legacyBaseDirName);
}

/**
 * Extract run ID from a worktree path
 *
 * Supports both new and legacy layouts:
 * - New: .milhouse/work/worktrees/{runId}-{taskId} -> extracts runId
 * - Legacy: .milhouse/runs/{runId}/worktrees/{taskId} -> extracts runId
 *
 * @param path - The worktree path
 * @returns The run ID or null if not found
 *
 * @example
 * ```ts
 * extractRunIdFromWorktreePath("/path/to/repo/.milhouse/work/worktrees/issue-123-task-1")
 * // "issue-123"
 *
 * extractRunIdFromWorktreePath("/path/to/repo/.milhouse/runs/run-abc123/worktrees/task-1")
 * // "run-abc123" (legacy)
 * ```
 */
export function extractRunIdFromWorktreePath(path: string): string | null {
	// Try new layout first: .milhouse/work/worktrees/{runId}-{taskId}
	const newMatch = path.match(/\.milhouse\/work\/worktrees\/([^-]+-[^-]+(?:-[^-]+)?)-/);
	if (newMatch) {
		return newMatch[1];
	}

	// Try legacy layout: .milhouse/runs/{runId}/worktrees/
	const legacyMatch = path.match(/\.milhouse\/runs\/([^/]+)\/worktrees/);
	return legacyMatch ? legacyMatch[1] : null;
}

/**
 * Extract task ID from a worktree path
 *
 * Supports both new and legacy layouts:
 * - New: .milhouse/work/worktrees/{runId}-{taskId} -> extracts taskId
 * - Legacy: .milhouse/runs/{runId}/worktrees/{taskId} -> extracts taskId
 *
 * @param path - The worktree path
 * @returns The task ID or null if not found
 *
 * @example
 * ```ts
 * extractTaskIdFromWorktreePath("/path/to/repo/.milhouse/work/worktrees/issue-123-agent-1-task-456")
 * // "agent-1-task-456"
 *
 * extractTaskIdFromWorktreePath("/path/to/repo/.milhouse/runs/run-abc123/worktrees/task-1")
 * // "task-1" (legacy)
 * ```
 */
export function extractTaskIdFromWorktreePath(path: string): string | null {
	// Try new layout first: .milhouse/work/worktrees/{runId}-{taskId}
	// The taskId is everything after the runId prefix
	const newMatch = path.match(/\.milhouse\/work\/worktrees\/[^-]+-[^-]+(?:-[^-]+)?-(.+)$/);
	if (newMatch) {
		return newMatch[1];
	}

	// Try legacy layout: .milhouse/runs/{runId}/worktrees/{taskId}
	const legacyMatch = path.match(/\.milhouse\/runs\/[^/]+\/worktrees\/([^/]+)/);
	return legacyMatch ? legacyMatch[1] : null;
}

/**
 * Check if a path is using the legacy worktree layout
 *
 * @param path - The path to check
 * @returns True if using legacy layout (.milhouse-worktrees/ or .milhouse/runs/{id}/worktrees/)
 */
export function isLegacyWorktreePath(path: string): boolean {
	return (
		path.includes(DEFAULT_WORKTREE_CONFIG.legacyBaseDirName) ||
		DEFAULT_WORKTREE_CONFIG.legacyRunsPattern.test(path)
	);
}

/**
 * Generate a unique worktree identifier
 *
 * @param taskId - The task identifier
 * @param agentId - Optional agent identifier
 * @returns A unique worktree identifier
 */
export function generateWorktreeId(taskId: string, agentId?: string): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);

	if (agentId) {
		return `${agentId}-${taskId}-${timestamp}-${random}`;
	}

	return `${taskId}-${timestamp}-${random}`;
}
