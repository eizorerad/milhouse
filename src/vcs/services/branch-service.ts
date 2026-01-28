/**
 * VCS Branch Service
 *
 * High-level branch operations for task management.
 * Uses the git-cli backend for deterministic command execution.
 *
 * @module vcs/services/branch-service
 */

import { bus } from "../../events/bus.ts";
import {
	parseBranchListPorcelain,
	parseStatusPorcelain,
	runGitCommand,
} from "../backends/git-cli.ts";
import { DEFAULT_NAMING_CONFIG, makeTaskBranchName, slugify } from "../policies/naming.ts";
import type {
	BranchInfo,
	CreateTaskBranchOptions,
	CreateTaskBranchResult,
	DeleteBranchResult,
	IBranchService,
	ReturnToBaseBranchOptions,
	VcsResult,
} from "../types.ts";
import { createVcsError, err, ok } from "../types.ts";

/**
 * Branch Service implementation
 *
 * Provides high-level branch operations with proper error handling
 * and event emission for observability.
 */
export class BranchService implements IBranchService {
	/**
	 * Create a task branch with automatic stashing
	 *
	 * This operation:
	 * 1. Stashes any uncommitted changes (if enabled)
	 * 2. Checks out the base branch and pulls latest
	 * 3. Creates or checks out the task branch
	 * 4. Restores stashed changes (if stashed)
	 */
	async createTaskBranch(
		options: CreateTaskBranchOptions,
	): Promise<VcsResult<CreateTaskBranchResult>> {
		const workDir = options.workDir ?? process.cwd();
		const stashChanges = options.stashChanges ?? true;
		const branchPrefix = options.branchPrefix ?? DEFAULT_NAMING_CONFIG.taskPrefix;

		// Get current branch first
		const currentBranchResult = await this.getCurrentBranch(workDir);
		if (!currentBranchResult.ok) {
			return currentBranchResult;
		}
		const previousBranch = currentBranchResult.value;

		// Generate branch name
		const branchName = makeTaskBranchName({
			prefix: branchPrefix,
			taskSlug: options.task,
		});

		// Check for uncommitted changes and stash if needed
		let stashed = false;
		if (stashChanges) {
			const hasChangesResult = await this.hasUncommittedChanges(workDir);
			if (!hasChangesResult.ok) {
				return hasChangesResult;
			}

			if (hasChangesResult.value) {
				const stashResult = await runGitCommand(
					["stash", "push", "-m", DEFAULT_NAMING_CONFIG.stashIdentifier],
					workDir,
				);
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
				stashed = true;
			}
		}

		try {
			// Checkout base branch
			const checkoutBaseResult = await runGitCommand(["checkout", options.baseBranch], workDir);
			if (!checkoutBaseResult.ok) {
				throw checkoutBaseResult.error;
			}
			if (checkoutBaseResult.value.exitCode !== 0) {
				throw createVcsError("COMMAND_FAILED", `Failed to checkout ${options.baseBranch}`, {
					context: { stderr: checkoutBaseResult.value.stderr },
				});
			}

			// Pull latest (ignore errors - may be offline or no remote)
			await runGitCommand(["pull", "origin", options.baseBranch], workDir);

			// Check if branch exists
			const branchExistsResult = await this.branchExists(branchName, workDir);
			if (!branchExistsResult.ok) {
				throw branchExistsResult.error;
			}

			// Create or checkout branch
			if (branchExistsResult.value) {
				// Branch exists, checkout
				const checkoutResult = await runGitCommand(["checkout", branchName], workDir);
				if (!checkoutResult.ok) {
					throw checkoutResult.error;
				}
				if (checkoutResult.value.exitCode !== 0) {
					throw createVcsError("COMMAND_FAILED", `Failed to checkout ${branchName}`, {
						context: { stderr: checkoutResult.value.stderr },
					});
				}
			} else {
				// Create new branch
				const createResult = await runGitCommand(["checkout", "-b", branchName], workDir);
				if (!createResult.ok) {
					throw createResult.error;
				}
				if (createResult.value.exitCode !== 0) {
					throw createVcsError("COMMAND_FAILED", `Failed to create branch ${branchName}`, {
						context: { stderr: createResult.value.stderr },
					});
				}
			}

			// Emit event for branch creation
			bus.emit("git:branch:create", { name: branchName });

			// Restore stash on success before returning
			if (stashed) {
				await runGitCommand(["stash", "pop"], workDir);
			}

			return ok({
				branchName,
				stashed,
				previousBranch,
			});
		} catch (error) {
			// Restore stash on failure
			if (stashed) {
				await runGitCommand(["stash", "pop"], workDir);
			}

			// Check if error is a VcsError by verifying it has the required shape
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				"message" in error &&
				typeof (error as { code: unknown }).code === "string" &&
				typeof (error as { message: unknown }).message === "string"
			) {
				return err(error as ReturnType<typeof createVcsError>);
			}

			return err(
				createVcsError("UNKNOWN_ERROR", String(error), {
					cause: error instanceof Error ? error : undefined,
				}),
			);
		}
	}

	/**
	 * Get the current branch name
	 */
	async getCurrentBranch(workDir?: string): Promise<VcsResult<string>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
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

		return ok(result.value.stdout.trim());
	}

	/**
	 * Get the default base branch (main or master)
	 */
	async getDefaultBaseBranch(workDir?: string): Promise<VcsResult<string>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["branch", "--list"], cwd);
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

		const branches = parseBranchListPorcelain(result.value.stdout);
		const branchNames = branches.map((b) => b.name);

		// Try main first, then master
		if (branchNames.includes("main")) {
			return ok("main");
		}
		if (branchNames.includes("master")) {
			return ok("master");
		}

		// Fall back to current branch
		const currentBranch = branches.find((b) => b.current);
		if (currentBranch) {
			return ok(currentBranch.name);
		}

		return err(createVcsError("BRANCH_NOT_FOUND", "No default branch found"));
	}

	/**
	 * Return to the base branch
	 */
	async returnToBaseBranch(options: ReturnToBaseBranchOptions): Promise<VcsResult<void>> {
		const workDir = options.workDir ?? process.cwd();

		const result = await runGitCommand(["checkout", options.baseBranch], workDir);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			// Ignore checkout errors - branch may not exist
			return ok(undefined);
		}

		return ok(undefined);
	}

	/**
	 * Check if there are uncommitted changes
	 */
	async hasUncommittedChanges(workDir?: string): Promise<VcsResult<boolean>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["status", "--porcelain"], cwd);
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
		return ok(entries.length > 0);
	}

	/**
	 * Check if a branch exists locally
	 */
	async branchExists(branchName: string, workDir?: string): Promise<VcsResult<boolean>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["rev-parse", "--verify", branchName], cwd);
		if (!result.ok) {
			return result;
		}

		// Exit code 0 means branch exists
		return ok(result.value.exitCode === 0);
	}

	/**
	 * Delete a local branch
	 */
	async deleteLocalBranch(
		branchName: string,
		workDir?: string,
		force = false,
	): Promise<VcsResult<DeleteBranchResult>> {
		const cwd = workDir ?? process.cwd();
		const flag = force ? "-D" : "-d";

		const result = await runGitCommand(["branch", flag, branchName], cwd);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			return ok({
				deleted: false,
				branchName,
			});
		}

		return ok({
			deleted: true,
			branchName,
		});
	}

	/**
	 * List all local branches
	 */
	async listLocalBranches(workDir?: string): Promise<VcsResult<BranchInfo[]>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["branch", "--list", "-v"], cwd);
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

		const entries = parseBranchListPorcelain(result.value.stdout);
		return ok(
			entries.map((entry) => ({
				name: entry.name,
				current: entry.current,
				commit: entry.commit,
				upstream: entry.upstream,
			})),
		);
	}
}

// ============================================================================
// Standalone Function Exports (for convenience)
// ============================================================================

const defaultService = new BranchService();

/**
 * Create a task branch with automatic stashing
 * @see BranchService.createTaskBranch
 */
export async function createTaskBranch(
	task: string,
	baseBranch: string,
	workDir?: string,
): Promise<VcsResult<CreateTaskBranchResult>> {
	return defaultService.createTaskBranch({ task, baseBranch, workDir });
}

/**
 * Get the current branch name
 * @see BranchService.getCurrentBranch
 */
export async function getCurrentBranch(workDir?: string): Promise<VcsResult<string>> {
	return defaultService.getCurrentBranch(workDir);
}

/**
 * Get the default base branch (main or master)
 * @see BranchService.getDefaultBaseBranch
 */
export async function getDefaultBaseBranch(workDir?: string): Promise<VcsResult<string>> {
	return defaultService.getDefaultBaseBranch(workDir);
}

/**
 * Return to the base branch
 * @see BranchService.returnToBaseBranch
 */
export async function returnToBaseBranch(
	baseBranch: string,
	workDir?: string,
): Promise<VcsResult<void>> {
	return defaultService.returnToBaseBranch({ baseBranch, workDir });
}

/**
 * Check if there are uncommitted changes
 * @see BranchService.hasUncommittedChanges
 */
export async function hasUncommittedChanges(workDir?: string): Promise<VcsResult<boolean>> {
	return defaultService.hasUncommittedChanges(workDir);
}

/**
 * Check if a branch exists locally
 * @see BranchService.branchExists
 */
export async function branchExists(
	branchName: string,
	workDir?: string,
): Promise<VcsResult<boolean>> {
	return defaultService.branchExists(branchName, workDir);
}

/**
 * Delete a local branch
 * @see BranchService.deleteLocalBranch
 */
export async function deleteLocalBranch(
	branchName: string,
	workDir?: string,
	force = false,
): Promise<VcsResult<DeleteBranchResult>> {
	return defaultService.deleteLocalBranch(branchName, workDir, force);
}

/**
 * List all local branches
 * @see BranchService.listLocalBranches
 */
export async function listLocalBranches(workDir?: string): Promise<VcsResult<BranchInfo[]>> {
	return defaultService.listLocalBranches(workDir);
}

// Re-export slugify for convenience
export { slugify };
