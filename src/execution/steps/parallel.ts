/**
 * Milhouse Parallel Step Execution
 *
 * Provides parallel task execution for the Milhouse pipeline.
 * Tasks are executed concurrently using git worktrees, with
 * automatic merging and conflict resolution.
 *
 * Features:
 * - Parallel execution with worktrees
 * - Parallel group ordering
 * - AI-assisted conflict resolution
 * - Milhouse-branded PR creation
 * - Event emission for lifecycle
 * - Issue-based execution mode
 *
 * @module execution/steps/parallel
 * @since 1.0.0
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import { MILHOUSE_DIR, PROGRESS_FILE } from "../../domain/config/directories.ts";
import { logTaskProgress } from "../../services/config/index.ts";
import type { AIEngine } from "../../engines/types.ts";
import { bus } from "../../events/index.ts";
import {
	getCurrentBranch,
	returnToBaseBranch,
	deleteLocalBranch,
} from "../../vcs/services/branch-service.ts";
import { abortMerge, mergeAgentBranch } from "../../vcs/services/merge-service.ts";
import {
	cleanupWorktree,
	createWorktree,
	getWorktreeBase,
} from "../../vcs/services/worktree-service.ts";
import type { Task as StateTask } from "../../state/types.ts";
import { YamlTaskSource } from "../../tasks/sources/yaml.ts";
import type { LegacyTask as Task } from "../../tasks/index.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../../ui/logger.ts";
import { notifyTaskComplete, notifyTaskFailed } from "../../ui/notify.ts";
import { createMergeConflictInfo, resolveConflictsWithEngine } from "../runtime/conflict-resolution.ts";
import { buildParallelExecutionPrompt, type ParallelPromptOptions } from "../runtime/prompt.ts";
import { legacyFlagToBrowserMode } from "../runtime/browser.ts";
import { executeWithRetry, isRetryableError } from "../runtime/retry.ts";
import { DEFAULT_RETRY_CONFIG, type MilhouseRetryConfig } from "../runtime/types.ts";
import type {
	MilhouseParallelGroup,
	MilhouseParallelStepOptions,
	MilhouseStepBatchResult,
	MilhouseStepOptions,
	WorktreeAgentResult,
} from "./types.ts";
import { createEmptyBatchResult } from "./types.ts";

// ============================================================================
// Worktree Agent Execution
// ============================================================================

/**
 * Run a single agent in a worktree
 */
async function runAgentInWorktree(
	engine: AIEngine,
	task: Task,
	agentNum: number,
	baseBranch: string,
	worktreeBase: string,
	originalDir: string,
	prdSource: string,
	prdFile: string,
	prdIsFolder: boolean,
	maxRetries: number,
	retryDelay: number,
	skipTests: boolean,
	skipLint: boolean,
	browserEnabled: "auto" | "true" | "false",
	modelOverride?: string,
	retryOnAnyFailure?: boolean,
): Promise<WorktreeAgentResult> {
	let worktreeDir = "";
	let branchName = "";

	try {
		// Create worktree - use task ID as runId for better traceability
		// The worktree will be created in .milhouse/work/worktrees/{runId}-{taskId}
		const runId = task.id;
		const worktreeResult = await createWorktree({
			task: task.title,
			agent: `agent-${agentNum}`,
			baseBranch,
			runId,
			workDir: originalDir,
		});

		if (!worktreeResult.ok) {
			throw new Error(worktreeResult.error.message);
		}

		worktreeDir = worktreeResult.value.worktreePath;
		branchName = worktreeResult.value.branchName;

		logDebug(`Milhouse Agent ${agentNum}: Created worktree at ${worktreeDir}`);

		// Emit worktree creation event
		bus.emit("git:worktree:create", {
			path: worktreeDir,
			branch: branchName,
		});

		// Copy PRD file or folder to worktree
		if (prdSource === "markdown" || prdSource === "yaml") {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				copyFileSync(srcPath, destPath);
			}
		} else if (prdSource === "markdown-folder" && prdIsFolder) {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				cpSync(srcPath, destPath, { recursive: true });
			}
		}

		// Ensure .milhouse/ exists in worktree
		const milhouseDir = join(worktreeDir, MILHOUSE_DIR);
		if (!existsSync(milhouseDir)) {
			mkdirSync(milhouseDir, { recursive: true });
		}

		// Build prompt using modern API
		const prompt = buildParallelExecutionPrompt({
			task: task.title,
			progressFile: PROGRESS_FILE,
			skipTests,
			skipLint,
			browserMode: legacyFlagToBrowserMode(browserEnabled),
		});

		// Emit engine start event
		bus.emit("engine:start", {
			engine: engine.name,
			taskId: task.id,
		});

		// Execute with retry using modern API
		const engineOptions = modelOverride ? { modelOverride } : undefined;
		const retryConfig: MilhouseRetryConfig = {
			...DEFAULT_RETRY_CONFIG,
			maxRetries,
			baseDelayMs: retryDelay,
			retryOnAnyFailure,
		};
		const retryResult = await executeWithRetry(
			async () => {
				const res = await engine.execute(prompt, worktreeDir, engineOptions);
				if (!res.success && res.error && isRetryableError(res.error)) {
					throw new Error(res.error);
				}
				return res;
			},
			retryConfig,
		);

		// Handle retry result
		if (!retryResult.success || !retryResult.value) {
			throw retryResult.error ?? new Error("Execution failed after retries");
		}

		const result = retryResult.value;

		// Emit engine complete event
		bus.emit("engine:complete", {
			engine: engine.name,
			taskId: task.id,
			result,
		});

		return { task, worktreeDir, branchName, result };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);

		// Emit engine error event
		bus.emit("engine:error", {
			engine: engine.name,
			taskId: task.id,
			error: error instanceof Error ? error : new Error(errorMsg),
		});

		return { task, worktreeDir, branchName, result: null, error: errorMsg };
	}
}

// ============================================================================
// Merge Phase
// ============================================================================

/**
 * Merge completed branches back to the base branch
 */
async function mergeCompletedBranches(
	branches: string[],
	targetBranch: string,
	engine: AIEngine,
	workDir: string,
	modelOverride?: string,
): Promise<void> {
	if (branches.length === 0) {
		return;
	}

	logInfo(`\nMilhouse Merge Phase: merging ${branches.length} branch(es) into ${targetBranch}`);

	const merged: string[] = [];
	const failed: string[] = [];

	for (const branch of branches) {
		logInfo(`Merging ${branch}...`);

		// Emit merge start event
		bus.emit("git:merge:start", {
			source: branch,
			target: targetBranch,
		});

		const mergeResult = await mergeAgentBranch(branch, targetBranch, workDir);

		if (!mergeResult.ok) {
			logError(`Failed to merge ${branch}: ${mergeResult.error.message}`);
			failed.push(branch);
			continue;
		}

		const merge = mergeResult.value;
		if (merge.success) {
			logSuccess(`Merged ${branch}`);
			merged.push(branch);

			// Emit merge complete event
			bus.emit("git:merge:complete", {
				source: branch,
				target: targetBranch,
			});
		} else if (merge.hasConflicts && merge.conflictedFiles) {
			// Try AI-assisted conflict resolution using modern API
			logWarn(`Merge conflict in ${branch}, attempting Milhouse AI resolution...`);

			// Emit conflict event
			bus.emit("git:merge:conflict", {
				source: branch,
				target: targetBranch,
				files: merge.conflictedFiles,
			});

			const conflicts = createMergeConflictInfo(merge.conflictedFiles, branch, targetBranch);
			const resolutionResult = await resolveConflictsWithEngine(engine, conflicts, workDir, modelOverride);

			if (resolutionResult.success) {
				logSuccess(`Resolved conflicts and merged ${branch}`);
				merged.push(branch);

				bus.emit("git:merge:complete", {
					source: branch,
					target: targetBranch,
				});
			} else {
				logError(`Failed to resolve conflicts for ${branch}`);
				await abortMerge(workDir);
				failed.push(branch);
			}
		} else {
			logError(`Failed to merge ${branch}: Unknown error`);
			failed.push(branch);
		}
	}

	// Delete successfully merged branches
	for (const branch of merged) {
		const deleteResult = await deleteLocalBranch(branch, workDir, true);
		if (deleteResult.ok && deleteResult.value.deleted) {
			logDebug(`Deleted merged branch: ${branch}`);
		}
	}

	// Summary
	if (merged.length > 0) {
		logSuccess(`Milhouse: Successfully merged ${merged.length} branch(es)`);
	}
	if (failed.length > 0) {
		logWarn(`Milhouse: Failed to merge ${failed.length} branch(es): ${failed.join(", ")}`);
		logInfo("These branches have been preserved for manual review.");
	}
}

// ============================================================================
// Parallel Execution Runner
// ============================================================================

/**
 * Run tasks in parallel using worktrees
 */
export async function runParallelSteps(
	options: MilhouseParallelStepOptions,
): Promise<MilhouseStepBatchResult> {
	const {
		engine,
		taskSource,
		workDir,
		skipTests,
		skipLint,
		dryRun,
		maxIterations,
		maxRetries,
		retryDelay,
		baseBranch,
		maxParallel,
		prdSource,
		prdFile,
		prdIsFolder = false,
		browserEnabled,
		modelOverride,
		skipMerge,
	} = options;

	let batch = createEmptyBatchResult();

	// Get worktree base directory
	const worktreeBase = getWorktreeBase(workDir);
	logDebug(`Milhouse worktree base: ${worktreeBase}`);

	// Save starting branch to restore after merge phase
	const startingBranchResult = await getCurrentBranch(workDir);
	const startingBranch = startingBranchResult.ok ? startingBranchResult.value : "";

	// Save original base branch for merge phase
	const originalBaseBranch = baseBranch || startingBranch;

	// Track completed branches for merge phase
	const completedBranches: string[] = [];

	// Global agent counter to ensure unique numbering across batches
	let globalAgentNum = 0;

	// Process tasks in batches
	let iteration = 0;

	logInfo("Milhouse: Starting parallel execution");

	while (true) {
		// Check iteration limit
		if (maxIterations > 0 && iteration >= maxIterations) {
			logInfo(`Reached max iterations (${maxIterations})`);
			break;
		}

		// Get tasks for this batch
		let tasks: Task[] = [];

		// For YAML sources, try to get tasks from the same parallel group
		if (taskSource instanceof YamlTaskSource) {
			const nextTask = await taskSource.getNextTask();
			if (!nextTask) break;

			// Get parallel group from task's parallelGroup property
			const group = nextTask.parallelGroup ?? 0;
			if (group > 0 && taskSource.getTasksInGroup) {
				tasks = await taskSource.getTasksInGroup(group);
			} else {
				tasks = [nextTask];
			}
		} else {
			// For other sources, get all remaining tasks
			tasks = await taskSource.getAllTasks();
		}

		if (tasks.length === 0) {
			logSuccess("Milhouse: All tasks completed!");
			break;
		}

		// Limit to maxParallel
		const batchTasks = tasks.slice(0, maxParallel);
		iteration++;

		logInfo(`Batch ${iteration}: ${batchTasks.length} tasks in parallel`);

		if (dryRun) {
			logInfo("(dry run) Skipping batch");
			continue;
		}

		// Create concurrency limiter for this batch
		const limit = pLimit(maxParallel);

		// Run agents in parallel with concurrency control
		const promises = batchTasks.map((task) => {
			globalAgentNum++;
			const agentNum = globalAgentNum;
			return limit(() =>
				runAgentInWorktree(
					engine,
					task,
					agentNum,
					baseBranch,
					worktreeBase,
					workDir,
					prdSource,
					prdFile,
					prdIsFolder,
					maxRetries,
					retryDelay,
					skipTests,
					skipLint,
					browserEnabled,
					modelOverride,
				),
			);
		});

		const results = await Promise.all(promises);

		// Process results
		for (const agentResult of results) {
			const { task, worktreeDir, branchName, result: aiResult, error } = agentResult;

			if (error) {
				logError(`Task "${task.title}" failed: ${error}`);
				logTaskProgress(task.title, "failed", workDir);
				batch = {
					...batch,
					tasksFailed: batch.tasksFailed + 1,
					allSucceeded: false,
				};
				notifyTaskFailed(task.title, error);

				// Emit task error event
				bus.emit("task:error", {
					taskId: task.id,
					error: new Error(error),
				});
			} else if (aiResult?.success) {
				logSuccess(`Task "${task.title}" completed`);
				batch = {
					...batch,
					tasksCompleted: batch.tasksCompleted + 1,
					totalInputTokens: batch.totalInputTokens + aiResult.inputTokens,
					totalOutputTokens: batch.totalOutputTokens + aiResult.outputTokens,
				};

				await taskSource.markComplete(task.id);
				logTaskProgress(task.title, "completed", workDir);
				notifyTaskComplete(task.title);

				// Track successful branch for merge phase
				if (branchName) {
					completedBranches.push(branchName);
				}

				// Emit task complete event
				bus.emit("task:complete", {
					taskId: task.id,
					duration: 0, // Duration not tracked per-task in parallel
					success: true,
				});
			} else {
				const errMsg = aiResult?.error || "Unknown error";
				logError(`Task "${task.title}" failed: ${errMsg}`);
				logTaskProgress(task.title, "failed", workDir);
				batch = {
					...batch,
					tasksFailed: batch.tasksFailed + 1,
					allSucceeded: false,
				};
				notifyTaskFailed(task.title, errMsg);

				// Emit task error event
				bus.emit("task:error", {
					taskId: task.id,
					error: new Error(errMsg),
				});
			}

			// Cleanup worktree
			if (worktreeDir) {
				const cleanupResult = await cleanupWorktree({
					path: worktreeDir,
					originalDir: workDir,
				});
				if (cleanupResult.ok && cleanupResult.value.leftInPlace) {
					logInfo(`Worktree left in place (uncommitted changes): ${worktreeDir}`);
				}

				// Emit worktree cleanup event
				bus.emit("git:worktree:cleanup", { path: worktreeDir });
			}
		}
	}

	// Merge phase: merge completed branches back to base branch
	if (!skipMerge && !dryRun && completedBranches.length > 0) {
		await mergeCompletedBranches(
			completedBranches,
			originalBaseBranch,
			engine,
			workDir,
			modelOverride,
		);

		// Restore starting branch if we're not already on it
		const currentBranchResult = await getCurrentBranch(workDir);
		const currentBranch = currentBranchResult.ok ? currentBranchResult.value : "";
		if (currentBranch !== startingBranch) {
			logDebug(`Restoring starting branch: ${startingBranch}`);
			await returnToBaseBranch(startingBranch, workDir);
		}
	}

	return batch;
}

// ============================================================================
// Parallel Group Utilities
// ============================================================================

/**
 * Extract unique parallel groups from tasks, sorted by group number
 */
export function extractParallelGroups(tasks: StateTask[]): MilhouseParallelGroup[] {
	const groupMap = new Map<number, StateTask[]>();

	for (const task of tasks) {
		const group = task.parallel_group;
		if (!groupMap.has(group)) {
			groupMap.set(group, []);
		}
		groupMap.get(group)?.push(task);
	}

	const groups = [...groupMap.keys()].sort((a, b) => a - b);

	return groups.map((group) => ({
		group,
		tasks: groupMap.get(group) || [],
		maxConcurrent: 4, // Default
	}));
}

/**
 * Filter tasks that are ready for execution based on dependencies
 */
export function getReadyTasksFromGroup(
	group: MilhouseParallelGroup,
	completedTaskIds: Set<string>,
): StateTask[] {
	return group.tasks.filter((task) => {
		// Task must be pending
		if (task.status !== "pending") {
			return false;
		}

		// All dependencies must be completed
		return task.depends_on.every((depId) => completedTaskIds.has(depId));
	});
}

/**
 * Check if a parallel group is complete (all tasks done, failed, or skipped)
 */
export function isGroupComplete(group: MilhouseParallelGroup): boolean {
	return group.tasks.every(
		(task) => task.status === "done" || task.status === "failed" || task.status === "skipped",
	);
}

/**
 * Convert state Task to task source Task for worktree execution
 */
export function stateTaskToWorktreeTask(stateTask: StateTask): Task {
	return {
		id: stateTask.id,
		title: stateTask.title,
		body: stateTask.description,
		parallelGroup: stateTask.parallel_group,
		completed: stateTask.status === "done",
	};
}

// ============================================================================
// Parallel Group Types
// ============================================================================

/**
 * Parallel group with tasks
 */
export interface ParallelGroup {
	/** Group number */
	group: number;
	/** Tasks in this group */
	tasks: StateTask[];
}

/**
 * Result of parallel group execution
 */
export interface ParallelGroupResult {
	/** Group number */
	group: number;
	/** Tasks that completed successfully */
	completedTasks: string[];
	/** Tasks that failed */
	failedTasks: string[];
	/** Total input tokens used */
	inputTokens: number;
	/** Total output tokens used */
	outputTokens: number;
	/** Whether all tasks in the group succeeded */
	success: boolean;
}

/**
 * Options for parallel group execution
 */
export interface ParallelGroupExecutionOptions {
	/** AI engine to use */
	engine: AIEngine;
	/** Working directory */
	workDir: string;
	/** Base branch for worktrees */
	baseBranch: string;
	/** Maximum concurrent tasks per group */
	maxConcurrent: number;
	/** Maximum retries per task */
	maxRetries: number;
	/** Retry delay in milliseconds */
	retryDelay: number;
	/** Skip tests during execution */
	skipTests: boolean;
	/** Skip linting during execution */
	skipLint: boolean;
	/** Browser enabled mode */
	browserEnabled: "auto" | "true" | "false";
	/** PRD source type */
	prdSource: string;
	/** PRD file path */
	prdFile: string;
	/** Whether PRD is a folder */
	prdIsFolder?: boolean;
	/** Model override for AI engine */
	modelOverride?: string;
	/** Whether to skip merge phase */
	skipMerge?: boolean;
	/** Callback when a task completes (can be sync or async for concurrent-safe updates) */
	onTaskComplete?: (taskId: string, success: boolean) => void | Promise<void>;
	/** Callback when a group completes */
	onGroupComplete?: (group: number, result: ParallelGroupResult) => void | Promise<void>;
	/** Whether to stop on first failure */
	failFast?: boolean;
	/**
	 * Retry any failure, not just retryable errors (safety net mode).
	 * When true, all failures are retried up to maxRetries.
	 * When false (default), only retryable errors trigger retries.
	 * @default false
	 */
	retryOnAnyFailure?: boolean;
}

// ============================================================================
// Parallel Group Functions
// ============================================================================

/**
 * Check if all previous groups are complete
 */
export function arePreviousGroupsComplete(
	groups: ParallelGroup[],
	currentGroupIndex: number,
): boolean {
	for (let i = 0; i < currentGroupIndex; i++) {
		const group = groups[i];
		const complete = group.tasks.every(
			(task) => task.status === "done" || task.status === "failed" || task.status === "skipped",
		);
		if (!complete) {
			return false;
		}
	}
	return true;
}

/**
 * Get the next parallel group to execute
 */
export function getNextGroupToExecute(groups: ParallelGroup[]): ParallelGroup | null {
	for (const group of groups) {
		const complete = group.tasks.every(
			(task) => task.status === "done" || task.status === "failed" || task.status === "skipped",
		);
		if (!complete) {
			return group;
		}
	}
	return null;
}

/**
 * Calculate group execution summary
 */
export function createGroupResult(group: ParallelGroup): ParallelGroupResult {
	const completedTasks: string[] = [];
	const failedTasks: string[] = [];

	for (const task of group.tasks) {
		if (task.status === "done") {
			completedTasks.push(task.id);
		} else if (task.status === "failed") {
			failedTasks.push(task.id);
		}
	}

	return {
		group: group.group,
		completedTasks,
		failedTasks,
		inputTokens: 0,
		outputTokens: 0,
		success: failedTasks.length === 0 && completedTasks.length === group.tasks.length,
	};
}

/**
 * Run a single parallel group
 */
export async function runParallelGroup(
	group: ParallelGroup,
	options: ParallelGroupExecutionOptions,
): Promise<ParallelGroupResult> {
	const { engine, workDir, baseBranch, maxConcurrent, maxRetries, retryDelay, modelOverride } =
		options;

	const worktreeBase = getWorktreeBase(workDir);
	const limit = pLimit(maxConcurrent);
	const completedTasks: string[] = [];
	const failedTasks: string[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	const branches: string[] = [];

	// Filter to only pending or merge_error tasks
	// merge_error tasks need to be re-executed because their merge failed
	const pendingTasks = group.tasks.filter(
		(t) => t.status === "pending" || t.status === "merge_error",
	);

	if (pendingTasks.length === 0) {
		return createGroupResult(group);
	}

	// Create spinner for this group
	const { DynamicAgentSpinner } = await import("../../ui/spinners.ts");
	const spinner = new DynamicAgentSpinner(
		maxConcurrent,
		pendingTasks.length,
		`Group ${group.group} execution`,
	);

	// Execute tasks in parallel
	const promises = pendingTasks.map((task) => {
		return limit(async () => {
			let worktreeDir = "";
			let branchName = "";
			let slotNum = 0;

			try {
				// Acquire a slot
				slotNum = spinner.acquireSlot(task.id.slice(0, 12));

				// Create worktree - use task ID as runId for better traceability
				// The worktree will be created in .milhouse/work/worktrees/{runId}-{taskId}
				const runId = task.id;
				const worktreeResult = await createWorktree({
					task: task.title,
					agent: `agent-${slotNum}`,
					baseBranch,
					runId,
					workDir,
				});

				if (!worktreeResult.ok) {
					throw new Error(worktreeResult.error.message);
				}

				worktreeDir = worktreeResult.value.worktreePath;
				branchName = worktreeResult.value.branchName;

				spinner.updateSlot(slotNum, "worktree");

				// Ensure .milhouse/ exists
				const milhouseDir = join(worktreeDir, MILHOUSE_DIR);
				if (!existsSync(milhouseDir)) {
					mkdirSync(milhouseDir, { recursive: true });
				}

				// Build prompt using modern API
				const prompt = buildParallelExecutionPrompt({
					task: task.title,
					progressFile: PROGRESS_FILE,
					skipTests: options.skipTests,
					skipLint: options.skipLint,
					browserMode: legacyFlagToBrowserMode(options.browserEnabled),
				});

				spinner.updateSlot(slotNum, "executing");

				// Execute with retry using modern API
				const engineOptions = modelOverride ? { modelOverride } : undefined;
				const retryConfig: MilhouseRetryConfig = {
					...DEFAULT_RETRY_CONFIG,
					maxRetries,
					baseDelayMs: retryDelay,
					retryOnAnyFailure: options.retryOnAnyFailure,
				};
				const retryResult = await executeWithRetry(
					async () => {
						const res = await engine.execute(prompt, worktreeDir, engineOptions);
						if (!res.success && res.error && isRetryableError(res.error)) {
							throw new Error(res.error);
						}
						return res;
					},
					retryConfig,
				);

				// Handle retry result
				if (!retryResult.success || !retryResult.value) {
					throw retryResult.error ?? new Error("Execution failed after retries");
				}

				const result = retryResult.value;

				if (result.success) {
					completedTasks.push(task.id);
					inputTokens += result.inputTokens;
					outputTokens += result.outputTokens;
					branches.push(branchName);
					spinner.releaseSlot(slotNum, true);
					await options.onTaskComplete?.(task.id, true);
				} else {
					failedTasks.push(task.id);
					spinner.releaseSlot(slotNum, false);
					await options.onTaskComplete?.(task.id, false);
				}
			} catch (_error) {
				failedTasks.push(task.id);
				if (slotNum > 0) {
					spinner.releaseSlot(slotNum, false);
				}
				await options.onTaskComplete?.(task.id, false);
			} finally {
				// Cleanup worktree
				if (worktreeDir) {
					await cleanupWorktree({
						path: worktreeDir,
						originalDir: workDir,
					});
				}
			}
		});
	});

	await Promise.all(promises);

	spinner.success();

	// Merge branches if not skipped
	if (!options.skipMerge && branches.length > 0) {
		await mergeCompletedBranches(branches, baseBranch, engine, workDir, modelOverride);
	}

	return {
		group: group.group,
		completedTasks,
		failedTasks,
		inputTokens,
		outputTokens,
		success: failedTasks.length === 0,
	};
}

/**
 * Extract parallel groups from tasks (local implementation)
 */
function extractLocalParallelGroups(tasks: StateTask[]): ParallelGroup[] {
	const groupMap = new Map<number, StateTask[]>();

	for (const task of tasks) {
		const group = task.parallel_group;
		if (!groupMap.has(group)) {
			groupMap.set(group, []);
		}
		groupMap.get(group)?.push(task);
	}

	const groupNums = [...groupMap.keys()].sort((a, b) => a - b);

	return groupNums.map((group) => ({
		group,
		tasks: groupMap.get(group) || [],
	}));
}

/**
 * Run tasks with parallel group ordering
 * Groups execute sequentially, tasks within groups execute in parallel
 */
export async function runParallelWithGroupOrdering(
	tasks: StateTask[],
	options: ParallelGroupExecutionOptions,
): Promise<MilhouseStepBatchResult> {
	// Extract parallel groups from tasks
	const groups = extractLocalParallelGroups(tasks);

	let totalCompleted = 0;
	let totalFailed = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	logInfo(`Found ${groups.length} parallel group(s)`);

	// Execute groups sequentially
	for (const group of groups) {
		// Check if previous groups are complete
		if (!arePreviousGroupsComplete(groups, groups.indexOf(group))) {
			logWarn(`Skipping group ${group.group} - previous groups not complete`);
			continue;
		}

		logInfo(`Executing parallel group ${group.group} (${group.tasks.length} tasks)`);

		const groupResult = await runParallelGroup(group, options);

		totalCompleted += groupResult.completedTasks.length;
		totalFailed += groupResult.failedTasks.length;
		totalInputTokens += groupResult.inputTokens;
		totalOutputTokens += groupResult.outputTokens;

		options.onGroupComplete?.(group.group, groupResult);

		// Stop if failFast and there were failures
		if (options.failFast && groupResult.failedTasks.length > 0) {
			logWarn(`Stopping execution due to failures in group ${group.group}`);
			break;
		}
	}

	return {
		results: [],
		tasksCompleted: totalCompleted,
		tasksFailed: totalFailed,
		totalInputTokens,
		totalOutputTokens,
		totalDurationMs: 0,
		allSucceeded: totalFailed === 0,
	};
}

// ============================================================================
// Backward Compatibility
// ============================================================================

/**
 * Run tasks in parallel using worktrees (legacy interface)
 *
 * @deprecated Use runParallelSteps() instead
 */
export async function runParallel(
	options: MilhouseStepOptions & {
		maxParallel: number;
		prdSource: string;
		prdFile: string;
		prdIsFolder?: boolean;
	},
): Promise<MilhouseStepBatchResult> {
	return await runParallelSteps(options as MilhouseParallelStepOptions);
}
