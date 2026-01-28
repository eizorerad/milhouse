/**
 * VCS Worktree Service
 *
 * High-level worktree operations for parallel agent execution.
 * Uses the git-cli backend for deterministic command execution.
 *
 * @module vcs/services/worktree-service
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../../events/bus.ts";
import { logDebug, logInfo } from "../../ui/logger.ts";
import {
	parseStatusPorcelain,
	parseWorktreeListPorcelain,
	runGitCommand,
} from "../backends/git-cli.ts";
import { generateNonce, makeAgentBranchName, slugify } from "../policies/naming.ts";
import {
	DEFAULT_WORKTREE_CONFIG,
	generateWorktreeId,
	getWorktreePath,
	getWorktreeRoot,
	isLegacyRunsWorktreePath,
	isMillhouseWorktree,
} from "../policies/worktree-locations.ts";
import type {
	CleanupWorktreeOptions,
	CleanupWorktreeResult,
	CreateWorktreeOptions,
	CreateWorktreeResult,
	IWorktreeService,
	VcsResult,
	WorktreeInfo,
	WorktreeStatus,
} from "../types.ts";
import { createVcsError, err, ok } from "../types.ts";

/**
 * Worktree Service implementation
 *
 * Provides high-level worktree operations with proper error handling
 * and event emission for observability.
 */
export class WorktreeService implements IWorktreeService {
	/**
	 * Create a worktree for parallel agent execution
	 *
	 * This operation:
	 * 1. Generates a unique worktree ID
	 * 2. Prunes stale worktrees
	 * 3. Creates a new worktree with an associated branch
	 * 4. Emits events for observability
	 */
	async createWorktree(options: CreateWorktreeOptions): Promise<VcsResult<CreateWorktreeResult>> {
		const { task, agent, baseBranch, runId, workDir } = options;

		// Generate unique identifiers
		const worktreeId = generateWorktreeId(slugify(task), agent);
		const nonce = generateNonce();

		// Generate branch name using runId-based naming
		const branchName = makeAgentBranchName({
			runId,
			agentId: agent,
			taskSlug: task,
			nonce,
		});

		// Get worktree path
		const worktreePath = getWorktreePath(workDir, runId, worktreeId);

		// Ensure worktree root exists
		const worktreeRoot = getWorktreeRoot(workDir, runId);
		if (!existsSync(worktreeRoot)) {
			mkdirSync(worktreeRoot, { recursive: true });
		}

		// Prune stale worktrees first
		const pruneResult = await runGitCommand(["worktree", "prune"], workDir);
		if (!pruneResult.ok) {
			return pruneResult;
		}

		// Remove existing worktree dir if any (from previous failed runs)
		if (existsSync(worktreePath)) {
			rmSync(worktreePath, { recursive: true, force: true });
			// Prune again after removing directory
			await runGitCommand(["worktree", "prune"], workDir);
		}

		// Use atomic -B flag to create/reset branch in one operation
		// This eliminates the race condition between delete and create
		const addResult = await runGitCommand(
			["worktree", "add", "-B", branchName, worktreePath, baseBranch],
			workDir,
		);

		if (!addResult.ok) {
			return addResult;
		}

		if (addResult.value.exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to create worktree", {
					context: { stderr: addResult.value.stderr, worktreePath, branchName },
				}),
			);
		}

		// Emit event for worktree creation
		bus.emit("git:worktree:create", {
			path: worktreePath,
			branch: branchName,
		});

		return ok({
			worktreePath,
			branchName,
			worktreeId,
		});
	}

	/**
	 * Cleanup a worktree after agent completes
	 *
	 * This operation:
	 * 1. Checks for uncommitted changes
	 * 2. Leaves worktree in place if changes exist
	 * 3. Removes the worktree if clean
	 * 4. Emits events for observability
	 */
	async cleanupWorktree(
		options: CleanupWorktreeOptions,
	): Promise<VcsResult<CleanupWorktreeResult>> {
		const { path: worktreePath, originalDir, force = false } = options;

		// Check for uncommitted changes
		if (existsSync(worktreePath) && !force) {
			const statusResult = await this.getWorktreeStatus(worktreePath);
			if (!statusResult.ok) {
				return statusResult;
			}

			if (statusResult.value.hasChanges) {
				// Leave worktree in place due to uncommitted changes
				bus.emit("git:worktree:cleanup", { path: worktreePath });
				return ok({
					leftInPlace: true,
					reason: "Uncommitted changes detected",
				});
			}
		}

		// Remove the worktree
		const removeResult = await runGitCommand(
			["worktree", "remove", "-f", worktreePath],
			originalDir,
		);

		if (!removeResult.ok) {
			logDebug(`Failed to remove worktree ${worktreePath}: ${removeResult.error.message}`);
		} else if (removeResult.value.exitCode !== 0) {
			logDebug(`Failed to remove worktree ${worktreePath}: ${removeResult.value.stderr}`);
		}

		// Emit event for worktree cleanup
		bus.emit("git:worktree:cleanup", { path: worktreePath });

		// Don't delete branch - it may have commits we want to keep/PR
		return ok({ leftInPlace: false });
	}

	/**
	 * List all worktrees
	 */
	async listWorktrees(workDir: string): Promise<VcsResult<WorktreeInfo[]>> {
		const result = await runGitCommand(["worktree", "list", "--porcelain"], workDir);
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

		const entries = parseWorktreeListPorcelain(result.value.stdout);

		return ok(
			entries.map((entry) => ({
				path: entry.worktree,
				branch: entry.branch || "",
				head: entry.head,
				isMain: !entry.branch?.startsWith("mh/") && !isMillhouseWorktree(entry.worktree),
				isMillhouse: isMillhouseWorktree(entry.worktree),
			})),
		);
	}

	/**
	 * Clean up all Milhouse worktrees
	 */
	async cleanupAllWorktrees(workDir: string): Promise<VcsResult<void>> {
		const listResult = await this.listWorktrees(workDir);
		if (!listResult.ok) {
			return listResult;
		}

		const millhouseWorktrees = listResult.value.filter((wt) => wt.isMillhouse);

		for (const worktree of millhouseWorktrees) {
			const removeResult = await runGitCommand(
				["worktree", "remove", "-f", worktree.path],
				workDir,
			);

			if (removeResult.ok && removeResult.value.exitCode === 0) {
				bus.emit("git:worktree:cleanup", { path: worktree.path });
			} else {
				logDebug(`Failed to remove worktree ${worktree.path}`);
			}
		}

		// Prune any stale worktrees
		await runGitCommand(["worktree", "prune"], workDir);

		// Clean up legacy empty directories
		await this.cleanupLegacyWorktreeDirectories(workDir);

		return ok(undefined);
	}

	/**
	 * Clean up legacy worktree directories in .milhouse/runs/
	 *
	 * This removes empty issue-* and run-* directories that were created
	 * by the old worktree layout (.milhouse/runs/{runId}/worktrees/).
	 * The new layout uses .milhouse/work/worktrees/ instead.
	 */
	async cleanupLegacyWorktreeDirectories(workDir: string): Promise<VcsResult<number>> {
		const runsDir = join(workDir, DEFAULT_WORKTREE_CONFIG.stateDir, "runs");

		if (!existsSync(runsDir)) {
			return ok(0);
		}

		let cleanedCount = 0;

		try {
			const entries = readdirSync(runsDir, { withFileTypes: true });

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const dirPath = join(runsDir, entry.name);

				// Check if this is a legacy worktree container (issue-* or run-* with only worktrees/ subdir)
				if (isLegacyRunsWorktreePath(join(dirPath, "worktrees"))) {
					const contents = readdirSync(dirPath);

					// If directory only contains empty "worktrees" folder, remove it
					if (contents.length === 1 && contents[0] === "worktrees") {
						const worktreesPath = join(dirPath, "worktrees");
						const worktreeContents = readdirSync(worktreesPath);

						if (worktreeContents.length === 0) {
							// Remove empty worktrees directory and parent
							rmSync(dirPath, { recursive: true, force: true });
							logInfo(`Cleaned up legacy worktree directory: ${entry.name}`);
							cleanedCount++;
						}
					}
					// If directory is completely empty, remove it
					else if (contents.length === 0) {
						rmSync(dirPath, { recursive: true, force: true });
						logInfo(`Cleaned up empty legacy directory: ${entry.name}`);
						cleanedCount++;
					}
				}
			}
		} catch (error) {
			logDebug(`Error cleaning up legacy directories: ${error}`);
		}

		return ok(cleanedCount);
	}

	/**
	 * Get worktree base directory (creates if needed)
	 */
	getWorktreeBase(workDir: string): string {
		// For backward compatibility, return the legacy base if it exists
		const legacyBase = join(workDir, DEFAULT_WORKTREE_CONFIG.legacyBaseDirName);
		if (existsSync(legacyBase)) {
			return legacyBase;
		}

		// Otherwise use the new state directory
		const stateBase = join(workDir, DEFAULT_WORKTREE_CONFIG.stateDir);
		if (!existsSync(stateBase)) {
			mkdirSync(stateBase, { recursive: true });
		}
		return stateBase;
	}

	/**
	 * Check if a worktree exists
	 */
	async worktreeExists(path: string): Promise<VcsResult<boolean>> {
		return ok(existsSync(path));
	}

	/**
	 * Get worktree status
	 */
	async getWorktreeStatus(path: string): Promise<VcsResult<WorktreeStatus>> {
		if (!existsSync(path)) {
			return ok({
				exists: false,
				hasChanges: false,
				modifiedCount: 0,
				untrackedCount: 0,
			});
		}

		const result = await runGitCommand(["status", "--porcelain"], path);
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

		const modifiedCount = entries.filter((e) => e.index !== "?" && e.worktree !== "?").length;
		const untrackedCount = entries.filter((e) => e.index === "?" && e.worktree === "?").length;

		return ok({
			exists: true,
			hasChanges: entries.length > 0,
			modifiedCount,
			untrackedCount,
		});
	}
}

// ============================================================================
// Standalone Function Exports (for convenience)
// ============================================================================

const defaultService = new WorktreeService();

/**
 * Create a worktree for parallel agent execution
 * @see WorktreeService.createWorktree
 */
export async function createWorktree(
	options: CreateWorktreeOptions,
): Promise<VcsResult<CreateWorktreeResult>> {
	return defaultService.createWorktree(options);
}

/**
 * Cleanup a worktree after agent completes
 * @see WorktreeService.cleanupWorktree
 */
export async function cleanupWorktree(
	options: CleanupWorktreeOptions,
): Promise<VcsResult<CleanupWorktreeResult>> {
	return defaultService.cleanupWorktree(options);
}

/**
 * List all worktrees
 * @see WorktreeService.listWorktrees
 */
export async function listWorktrees(workDir: string): Promise<VcsResult<WorktreeInfo[]>> {
	return defaultService.listWorktrees(workDir);
}

/**
 * Clean up all Milhouse worktrees
 * @see WorktreeService.cleanupAllWorktrees
 */
export async function cleanupAllWorktrees(workDir: string): Promise<VcsResult<void>> {
	return defaultService.cleanupAllWorktrees(workDir);
}

/**
 * Clean up legacy worktree directories
 * @see WorktreeService.cleanupLegacyWorktreeDirectories
 */
export async function cleanupLegacyWorktreeDirectories(workDir: string): Promise<VcsResult<number>> {
	return defaultService.cleanupLegacyWorktreeDirectories(workDir);
}

/**
 * Get worktree base directory
 * @see WorktreeService.getWorktreeBase
 */
export function getWorktreeBase(workDir: string): string {
	return defaultService.getWorktreeBase(workDir);
}

/**
 * Check if a worktree exists
 * @see WorktreeService.worktreeExists
 */
export async function worktreeExists(path: string): Promise<VcsResult<boolean>> {
	return defaultService.worktreeExists(path);
}

/**
 * Get worktree status
 * @see WorktreeService.getWorktreeStatus
 */
export async function getWorktreeStatus(path: string): Promise<VcsResult<WorktreeStatus>> {
	return defaultService.getWorktreeStatus(path);
}
