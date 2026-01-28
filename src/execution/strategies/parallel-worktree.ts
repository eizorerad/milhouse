/**
 * Parallel Worktree Execution Strategy
 *
 * Executes tasks in parallel using git worktrees.
 * Each task runs in its own worktree with a dedicated branch.
 * Best for:
 * - Independent tasks that can run concurrently
 * - Tasks grouped by parallel_group
 * - Large task batches
 */

import pLimit from "p-limit";
import { createDefaultExecutor, getPlugin } from "../../engines";
import { bus } from "../../events";
import { deleteLocalBranch, slugify } from "../../vcs/services/branch-service.ts";
import { abortMerge, mergeAgentBranch } from "../../vcs/services/merge-service.ts";
import { cleanupWorktree, createWorktree, getWorktreeBase } from "../../vcs/services/worktree-service.ts";
import { loggers } from "../../observability";
import type { Task } from "../../schemas/tasks.schema";
import type {
	ExecutionContext,
	ExecutionOptions,
	IExecutionStrategy,
	TaskExecutionResult,
} from "./types";

/**
 * Parallel worktree execution strategy.
 * Tasks are executed in parallel using git worktrees.
 */
export class ParallelWorktreeStrategy implements IExecutionStrategy {
	readonly name = "parallel-worktree";

	/**
	 * Check if this strategy can handle the given tasks.
	 * Handles parallel execution with branch-per-task.
	 */
	canHandle(tasks: Task[], options: ExecutionOptions): boolean {
		return options.parallel && options.branchPerTask;
	}

	/**
	 * Estimate execution duration.
	 * Assumes parallel execution with configured workers.
	 */
	estimateDuration(tasks: Task[]): number {
		const MINUTES_PER_TASK = 5;
		const DEFAULT_WORKERS = 4;
		const parallelBatches = Math.ceil(tasks.length / DEFAULT_WORKERS);
		return parallelBatches * MINUTES_PER_TASK * 60 * 1000;
	}

	/**
	 * Execute tasks in parallel using worktrees.
	 */
	async execute(tasks: Task[], context: ExecutionContext): Promise<TaskExecutionResult[]> {
		const { options, hooks } = context;
		const { maxWorkers, baseBranch, skipMerge, dryRun } = options;

		// Create concurrency limiter
		const limit = pLimit(maxWorkers);

		loggers.task.info(
			{ taskCount: tasks.length, maxWorkers, strategy: this.name },
			"Starting parallel worktree execution",
		);

		// Notify execution start
		await hooks.onExecutionStart?.(context, tasks.length);

		// Check for dry run
		if (dryRun) {
			loggers.task.info("Dry run: skipping parallel execution");
			return tasks.map((task) => ({
				taskId: task.id,
				success: true,
				duration: 0,
			}));
		}

		// Group tasks by parallel group
		const groups = this.groupTasks(tasks);
		const results: TaskExecutionResult[] = [];
		const completedBranches: string[] = [];

		// Execute groups sequentially, tasks within groups in parallel
		for (const [groupNum, groupTasks] of groups) {
			loggers.task.info(
				{ group: groupNum, taskCount: groupTasks.length },
				"Executing parallel group",
			);

			// Notify group start
			await hooks.onGroupStart?.(groupNum, groupTasks.length);

			// Execute tasks in parallel within the group
			// Note: worktree cleanup is deferred until after merge to prevent BRANCH_LOCKED errors
			const groupResults = await Promise.all(
				groupTasks.map((task) => limit(() => this.executeTask(task, context, baseBranch))),
			);

			results.push(...groupResults);

			// Collect successful branches and worktrees for merge and cleanup
			const successfulResults = groupResults.filter((r) => r.success && r.branch);
			const successfulBranches = successfulResults.map((r) => r.branch!);
			const worktreesToCleanup = groupResults
				.filter((r) => r.worktree)
				.map((r) => r.worktree!);

			completedBranches.push(...successfulBranches);

			// Notify group complete
			await hooks.onGroupComplete?.(groupNum, groupResults);

			// Merge completed branches after each group (BEFORE worktree cleanup)
			if (!skipMerge && successfulBranches.length > 0) {
				await this.mergeBranches(successfulBranches, baseBranch, context);
			}

			// Cleanup worktrees AFTER merge phase completes to prevent BRANCH_LOCKED errors
			await this.cleanupWorktrees(worktreesToCleanup, context);

			// Check for fail fast
			const hasFailures = groupResults.some((r) => !r.success);
			if (hasFailures && options.failFast) {
				loggers.task.warn({ group: groupNum }, "Stopping execution due to failFast");
				break;
			}
		}

		loggers.task.info(
			{
				completed: results.filter((r) => r.success).length,
				failed: results.filter((r) => !r.success).length,
				total: results.length,
				branchesMerged: completedBranches.length,
			},
			"Parallel worktree execution complete",
		);

		return results;
	}

	/**
	 * Group tasks by their parallel_group metadata.
	 */
	private groupTasks(tasks: Task[]): Map<number, Task[]> {
		const groups = new Map<number, Task[]>();

		for (const task of tasks) {
			const group = task.metadata?.parallelGroup ?? 0;
			if (!groups.has(group)) {
				groups.set(group, []);
			}
			groups.get(group)?.push(task);
		}

		// Sort by group number
		return new Map([...groups.entries()].sort((a, b) => a[0] - b[0]));
	}

	/**
	 * Execute a single task in a worktree.
	 */
	private async executeTask(
		task: Task,
		context: ExecutionContext,
		baseBranch: string,
	): Promise<TaskExecutionResult> {
		const startTime = Date.now();
		const { hooks, options } = context;
		const branchName = `milhouse/${slugify(task.title)}-${Date.now()}`;
		let worktreePath: string | undefined;
		let actualBranchName: string | undefined;

		try {
			// Emit task start
			bus.emit("task:start", { taskId: task.id, title: task.title });
			await hooks.onTaskStart?.(task, context);

			// Get worktree base directory (not used directly, but kept for reference)
			const _worktreeBase = getWorktreeBase(context.workDir);

			// Create worktree using new API
			// Use task ID as runId for better traceability
			// The worktree will be created in .milhouse/work/worktrees/{runId}-{taskId}
			const worktreeResult = await createWorktree({
				task: task.title,
				agent: String(Date.now() % 1000), // Agent number based on timestamp
				baseBranch,
				runId: task.id,
				workDir: context.workDir,
			});

			if (!worktreeResult.ok) {
				throw new Error(`Failed to create worktree: ${worktreeResult.error.message}`);
			}

			worktreePath = worktreeResult.value.worktreePath;
			actualBranchName = worktreeResult.value.branchName;

			// Emit worktree create event
			bus.emit("git:worktree:create", { path: worktreePath, branch: actualBranchName });
			await hooks.onWorktreeCreate?.(worktreePath, actualBranchName);

			loggers.task.debug(
				{ taskId: task.id, worktree: worktreePath, branch: actualBranchName },
				"Created worktree for task",
			);

			// Build prompt
			const prompt = this.buildPrompt(task, context);

			// Execute task in worktree using modern executor API
			const executor = createDefaultExecutor();
			const plugin = getPlugin(context.engine);
			const result = await executor.execute(plugin, {
				prompt,
				workDir: worktreePath,
				taskId: task.id,
			});

			const duration = Date.now() - startTime;
			const taskResult: TaskExecutionResult = {
				taskId: task.id,
				success: result.success,
				result,
				branch: actualBranchName,
				worktree: worktreePath,
				duration,
			};

			// Emit task complete
			bus.emit("task:complete", {
				taskId: task.id,
				duration,
				success: result.success,
			});
			await hooks.onTaskComplete?.(task, taskResult);

			loggers.task.info(
				{ taskId: task.id, duration, success: result.success },
				"Task completed in worktree",
			);

			return taskResult;
		} catch (error) {
			const duration = Date.now() - startTime;
			const err = error as Error;

			// Emit task error
			bus.emit("task:error", { taskId: task.id, error: err });
			await hooks.onTaskError?.(task, err);

			loggers.task.error({ taskId: task.id, err, duration }, "Task failed in worktree");

			return {
				taskId: task.id,
				success: false,
				branch: actualBranchName ?? branchName,
				worktree: worktreePath,
				duration,
				error: err,
			};
		}
		// Note: worktree cleanup is handled by cleanupWorktrees() after merge phase
		// to prevent BRANCH_LOCKED errors when merging branches
	}

	/**
	 * Merge completed branches into target branch.
	 */
	private async mergeBranches(
		branches: string[],
		target: string,
		context: ExecutionContext,
	): Promise<void> {
		const { hooks } = context;

		loggers.task.info({ branchCount: branches.length, target }, "Merging completed branches");

		for (const branch of branches) {
			try {
				// Emit merge start
				bus.emit("git:merge:start", { source: branch, target });
				await hooks.onMergeStart?.(branch, target);

				const mergeResult = await mergeAgentBranch(branch, target, context.workDir);

				if (!mergeResult.ok) {
					loggers.task.error({ branch, target, error: mergeResult.error.message }, "Merge failed");
					continue;
				}

				if (mergeResult.value.success) {
					// Emit merge complete
					bus.emit("git:merge:complete", { source: branch, target });
					await hooks.onMergeComplete?.(branch, target);

					loggers.task.info({ branch, target }, "Branch merged successfully");

					// Delete merged branch
					await deleteLocalBranch(branch, context.workDir, true);
				} else if (mergeResult.value.hasConflicts && mergeResult.value.conflictedFiles) {
					// Emit merge conflict
					bus.emit("git:merge:conflict", {
						source: branch,
						target,
						files: mergeResult.value.conflictedFiles,
					});
					await hooks.onMergeConflict?.(branch, target, mergeResult.value.conflictedFiles);

					loggers.task.warn(
						{ branch, target, files: mergeResult.value.conflictedFiles },
						"Merge conflict detected",
					);

					// Abort the merge
					await abortMerge(context.workDir);
				} else {
					loggers.task.error({ branch, target }, "Merge failed with unknown error");
				}
			} catch (error) {
				loggers.task.error({ branch, target, err: error }, "Exception during merge");
			}
		}
	}

	/**
	 * Cleanup worktrees after merge phase completes.
	 * This is called AFTER mergeBranches to prevent BRANCH_LOCKED errors.
	 */
	private async cleanupWorktrees(
		worktreePaths: string[],
		context: ExecutionContext,
	): Promise<void> {
		const { hooks } = context;

		loggers.task.debug(
			{ worktreeCount: worktreePaths.length },
			"Cleaning up worktrees after merge phase",
		);

		for (const worktreePath of worktreePaths) {
			try {
				const cleanupResult = await cleanupWorktree({
					path: worktreePath,
					originalDir: context.workDir,
				});

				bus.emit("git:worktree:cleanup", { path: worktreePath });
				await hooks.onWorktreeCleanup?.(worktreePath);

				if (cleanupResult.ok && cleanupResult.value.leftInPlace) {
					loggers.task.warn(
						{ worktree: worktreePath },
						"Worktree left in place due to uncommitted changes",
					);
				}
			} catch (cleanupError) {
				loggers.task.warn(
					{ worktree: worktreePath, err: cleanupError },
					"Failed to cleanup worktree",
				);
			}
		}
	}

	/**
	 * Build execution prompt for a task.
	 */
	private buildPrompt(task: Task, context: ExecutionContext): string {
		const { options } = context;
		const parts: string[] = [];

		parts.push("Execute the following task in this worktree:");
		parts.push("");
		parts.push(`## Task: ${task.title}`);
		parts.push("");

		if (task.description) {
			parts.push("### Description");
			parts.push(task.description);
			parts.push("");
		}

		// Add metadata if available
		if (task.metadata) {
			if (task.metadata.dependencies && task.metadata.dependencies.length > 0) {
				parts.push("### Dependencies");
				parts.push(task.metadata.dependencies.join(", "));
				parts.push("");
			}
		}

		// Add execution instructions
		parts.push("### Instructions");
		parts.push("- Make minimal, focused changes");
		parts.push("- Commit your changes with a descriptive message");
		parts.push("- This task runs in an isolated worktree");

		if (!options.skipTests) {
			parts.push("- Run tests after making changes");
		}

		if (!options.skipLint) {
			parts.push("- Ensure code passes linting");
		}

		parts.push("- Do not add TODO or placeholder code");
		parts.push("");

		return parts.join("\n");
	}
}

/**
 * Create a new parallel worktree strategy instance.
 */
export function createParallelWorktreeStrategy(): ParallelWorktreeStrategy {
	return new ParallelWorktreeStrategy();
}
