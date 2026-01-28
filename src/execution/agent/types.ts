/**
 * Agent Execution Types
 *
 * Types and utilities for agent-based task execution.
 *
 * @module execution/agent/types
 * @since 5.0.0
 */

import type { AIEngineName } from "../../engines/types.ts";
import type { Task } from "../../state/types.ts";

// ============================================================================
// Agent Execution Configuration
// ============================================================================

/**
 * Execution mode for agent-based execution
 */
export type AgentExecutionMode = "in-place" | "branch" | "worktree" | "pr";

/**
 * Agent execution configuration
 */
export interface AgentExecutionConfig {
	/** AI engine to use */
	engine: AIEngineName;
	/** Working directory */
	workDir: string;
	/** Execution mode */
	mode: AgentExecutionMode;
	/** Maximum parallel agents */
	maxParallel: number;
	/** Whether to fail fast on first error */
	failFast: boolean;
	/** Create branches per task */
	branchPerTask: boolean;
	/** Base branch for branching */
	baseBranch?: string;
	/** Create PRs for completed tasks */
	createPr: boolean;
	/** Create draft PRs */
	draftPr: boolean;
	/** Skip tests during execution */
	skipTests: boolean;
	/** Skip linting during execution */
	skipLint: boolean;
	/** Maximum retries for failed tasks */
	maxRetries: number;
	/** Delay between retries in milliseconds */
	retryDelay: number;
	/** Timeout per task in milliseconds */
	taskTimeout: number;
	/** Model override for AI engine */
	modelOverride?: string;
	/** Verbose logging */
	verbose: boolean;
}

/**
 * Default agent execution configuration
 */
export const DEFAULT_AGENT_EXECUTION_CONFIG: AgentExecutionConfig = {
	engine: "claude",
	workDir: process.cwd(),
	mode: "branch",
	maxParallel: 4,
	failFast: false,
	branchPerTask: true,
	createPr: false,
	draftPr: true,
	skipTests: false,
	skipLint: false,
	maxRetries: 2,
	retryDelay: 5000, // 5 seconds in ms
	taskTimeout: 4000000, // ~66 minutes
	verbose: false,
};

/**
 * Create agent execution config with overrides
 */
export function createAgentExecutionConfig(
	overrides: Partial<AgentExecutionConfig> = {},
): AgentExecutionConfig {
	return {
		...DEFAULT_AGENT_EXECUTION_CONFIG,
		...overrides,
	};
}

// ============================================================================
// Agent Task Results
// ============================================================================

/**
 * Single task execution result from agent
 */
export interface AgentTaskResult {
	/** Task ID */
	taskId: string;
	/** Whether execution was successful */
	success: boolean;
	/** Files modified during execution */
	filesModified: string[];
	/** Summary of changes made */
	summary: string;
	/** Error message if failed */
	error?: string;
	/** Branch created for task */
	branch?: string;
	/** PR URL if created */
	prUrl?: string;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Input tokens used */
	inputTokens: number;
	/** Output tokens generated */
	outputTokens: number;
}

/**
 * Create empty agent task result
 */
export function createEmptyAgentTaskResult(taskId: string): AgentTaskResult {
	return {
		taskId,
		success: false,
		filesModified: [],
		summary: "",
		durationMs: 0,
		inputTokens: 0,
		outputTokens: 0,
	};
}

/**
 * Batch execution result from agent
 */
export interface AgentBatchResult {
	/** Individual task results */
	results: AgentTaskResult[];
	/** Number of tasks executed */
	tasksExecuted: number;
	/** Number of tasks completed successfully */
	tasksCompleted: number;
	/** Number of tasks failed */
	tasksFailed: number;
	/** Total execution duration in milliseconds */
	totalDurationMs: number;
	/** Total input tokens used */
	totalInputTokens: number;
	/** Total output tokens generated */
	totalOutputTokens: number;
	/** Whether all tasks succeeded */
	allSucceeded: boolean;
}

/**
 * Create empty batch result
 */
export function createEmptyAgentBatchResult(): AgentBatchResult {
	return {
		results: [],
		tasksExecuted: 0,
		tasksCompleted: 0,
		tasksFailed: 0,
		totalDurationMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		allSucceeded: true,
	};
}

/**
 * Add task result to batch result (immutable)
 */
export function addTaskResultToBatch(
	batch: AgentBatchResult,
	taskResult: AgentTaskResult,
): AgentBatchResult {
	const results = [...batch.results, taskResult];
	const tasksCompleted = batch.tasksCompleted + (taskResult.success ? 1 : 0);
	const tasksFailed = batch.tasksFailed + (taskResult.success ? 0 : 1);

	return {
		results,
		tasksExecuted: batch.tasksExecuted + 1,
		tasksCompleted,
		tasksFailed,
		totalDurationMs: batch.totalDurationMs + taskResult.durationMs,
		totalInputTokens: batch.totalInputTokens + taskResult.inputTokens,
		totalOutputTokens: batch.totalOutputTokens + taskResult.outputTokens,
		allSucceeded: batch.allSucceeded && taskResult.success,
	};
}

/**
 * Merge multiple batch results (immutable)
 */
export function mergeBatchResults(batches: AgentBatchResult[]): AgentBatchResult {
	if (batches.length === 0) {
		return createEmptyAgentBatchResult();
	}

	return batches.reduce((acc, batch) => ({
		results: [...acc.results, ...batch.results],
		tasksExecuted: acc.tasksExecuted + batch.tasksExecuted,
		tasksCompleted: acc.tasksCompleted + batch.tasksCompleted,
		tasksFailed: acc.tasksFailed + batch.tasksFailed,
		totalDurationMs: acc.totalDurationMs + batch.totalDurationMs,
		totalInputTokens: acc.totalInputTokens + batch.totalInputTokens,
		totalOutputTokens: acc.totalOutputTokens + batch.totalOutputTokens,
		allSucceeded: acc.allSucceeded && batch.allSucceeded,
	}));
}

// ============================================================================
// Parallel Group Configuration
// ============================================================================

/**
 * Parallel group configuration
 */
export interface ParallelGroupConfig {
	/** Group number */
	group: number;
	/** Task IDs in this group */
	taskIds: string[];
	/** Maximum concurrent executions for this group */
	maxConcurrent: number;
	/** Whether this group depends on previous groups completing */
	waitForPreviousGroups: boolean;
}

/**
 * Create parallel group config from task list
 */
export function createParallelGroupsFromTasks(
	tasks: Task[],
	defaultMaxConcurrent = 4,
): ParallelGroupConfig[] {
	const groupMap = new Map<number, string[]>();

	for (const task of tasks) {
		const group = task.parallel_group;
		if (!groupMap.has(group)) {
			groupMap.set(group, []);
		}
		groupMap.get(group)?.push(task.id);
	}

	const groups = [...groupMap.keys()].sort((a, b) => a - b);

	return groups.map((group, index) => ({
		group,
		taskIds: groupMap.get(group) || [],
		maxConcurrent: defaultMaxConcurrent,
		waitForPreviousGroups: index > 0,
	}));
}

/**
 * Get tasks in a specific parallel group
 */
export function getTasksInParallelGroup(tasks: Task[], group: number): Task[] {
	return tasks.filter((t) => t.parallel_group === group);
}

/**
 * Check if all tasks in previous groups are complete
 */
export function arePreviousGroupsComplete(tasks: Task[], currentGroup: number): boolean {
	const previousGroupTasks = tasks.filter((t) => t.parallel_group < currentGroup);
	return previousGroupTasks.every((t) => t.status === "done" || t.status === "skipped");
}

/**
 * Get blocking tasks for a parallel group
 */
export function getBlockingTasks(tasks: Task[], currentGroup: number): Task[] {
	return tasks.filter(
		(t) => t.parallel_group < currentGroup && t.status !== "done" && t.status !== "skipped",
	);
}
