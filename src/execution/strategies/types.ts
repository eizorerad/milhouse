/**
 * Execution Strategy Types
 *
 * Defines the strategy pattern interface for task execution.
 * Strategies encapsulate different execution approaches:
 * - Sequential: Tasks executed one at a time
 * - Parallel Worktree: Tasks executed in parallel using git worktrees
 * - Pipeline-Aware: Adaptive strategy based on task characteristics
 */

import type { ExecutionResult } from "../../schemas/engine.schema";
import type { Task } from "../../schemas/tasks.schema";

// ============================================================================
// Execution Context
// ============================================================================

/**
 * Execution context passed to strategies.
 * Contains all information needed for task execution.
 */
export interface ExecutionContext {
	/** Unique identifier for this execution run */
	runId: string;
	/** Working directory for execution */
	workDir: string;
	/** AI engine to use (e.g., 'claude', 'opencode') */
	engine: string;
	/** Execution options */
	options: ExecutionOptions;
	/** Lifecycle hooks for events */
	hooks: ExecutionHooks;
	/** Optional metadata for tracking */
	metadata?: Record<string, unknown>;
}

// ============================================================================
// Execution Options
// ============================================================================

/**
 * Options controlling execution behavior.
 */
export interface ExecutionOptions {
	/** Execute tasks in parallel */
	parallel: boolean;
	/** Create a branch per task */
	branchPerTask: boolean;
	/** Create pull requests for completed tasks */
	createPr: boolean;
	/** Maximum number of parallel workers */
	maxWorkers: number;
	/** Base branch for branching operations */
	baseBranch: string;
	/** Dry run mode (no actual execution) */
	dryRun: boolean;
	/** Skip tests during execution */
	skipTests?: boolean;
	/** Skip linting during execution */
	skipLint?: boolean;
	/** Stop on first failure */
	failFast?: boolean;
	/** Maximum retries per task */
	maxRetries?: number;
	/** Delay between retries in milliseconds */
	retryDelay?: number;
	/** Timeout per task in milliseconds */
	taskTimeout?: number;
	/** Model override for AI engine */
	modelOverride?: string;
	/** Skip automatic branch merging */
	skipMerge?: boolean;
	/** Browser enabled mode */
	browserEnabled?: "auto" | "true" | "false";
}

/**
 * Default execution options.
 */
export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
	parallel: false,
	branchPerTask: false,
	createPr: false,
	maxWorkers: 4,
	baseBranch: "main",
	dryRun: false,
	skipTests: false,
	skipLint: false,
	failFast: false,
	maxRetries: 2,
	retryDelay: 5000,
	taskTimeout: 4000000, // ~66 minutes
	skipMerge: false,
	browserEnabled: "auto",
};

// ============================================================================
// Task Execution Result
// ============================================================================

/**
 * Result of executing a single task.
 */
export interface TaskExecutionResult {
	/** Task identifier */
	taskId: string;
	/** Whether execution succeeded */
	success: boolean;
	/** Engine execution result */
	result?: ExecutionResult;
	/** Branch created for this task */
	branch?: string;
	/** Worktree path used */
	worktree?: string;
	/** Execution duration in milliseconds */
	duration: number;
	/** Error if execution failed */
	error?: Error;
	/** Input tokens consumed */
	inputTokens?: number;
	/** Output tokens generated */
	outputTokens?: number;
	/** Files modified during execution */
	filesModified?: string[];
}

/**
 * Aggregate result of executing multiple tasks.
 */
export interface BatchExecutionResult {
	/** Individual task results */
	results: TaskExecutionResult[];
	/** Number of tasks executed */
	tasksExecuted: number;
	/** Number of tasks completed successfully */
	tasksCompleted: number;
	/** Number of tasks that failed */
	tasksFailed: number;
	/** Total execution duration in milliseconds */
	totalDuration: number;
	/** Total input tokens consumed */
	totalInputTokens: number;
	/** Total output tokens generated */
	totalOutputTokens: number;
	/** Whether all tasks succeeded */
	allSucceeded: boolean;
}

// ============================================================================
// Execution Hooks
// ============================================================================

/**
 * Lifecycle hooks for execution events.
 * All hooks are optional and async.
 */
export interface ExecutionHooks {
	/** Called when a task starts execution */
	onTaskStart?: (task: Task, context: ExecutionContext) => Promise<void>;
	/** Called when a task completes (success or failure) */
	onTaskComplete?: (task: Task, result: TaskExecutionResult) => Promise<void>;
	/** Called when a task encounters an error */
	onTaskError?: (task: Task, error: Error) => Promise<void>;
	/** Called when a merge operation starts */
	onMergeStart?: (branch: string, target: string) => Promise<void>;
	/** Called when a merge operation completes */
	onMergeComplete?: (branch: string, target: string) => Promise<void>;
	/** Called when a merge conflict is detected */
	onMergeConflict?: (branch: string, target: string, files: string[]) => Promise<void>;
	/** Called when a worktree is created */
	onWorktreeCreate?: (path: string, branch: string) => Promise<void>;
	/** Called when a worktree is cleaned up */
	onWorktreeCleanup?: (path: string) => Promise<void>;
	/** Called when a parallel group starts */
	onGroupStart?: (group: number, taskCount: number) => Promise<void>;
	/** Called when a parallel group completes */
	onGroupComplete?: (group: number, results: TaskExecutionResult[]) => Promise<void>;
	/** Called when execution begins */
	onExecutionStart?: (context: ExecutionContext, taskCount: number) => Promise<void>;
	/** Called when execution completes */
	onExecutionComplete?: (context: ExecutionContext, results: BatchExecutionResult) => Promise<void>;
}

// ============================================================================
// Strategy Interface
// ============================================================================

/**
 * Execution strategy interface.
 * Strategies implement different approaches to task execution.
 */
export interface IExecutionStrategy {
	/** Strategy name for identification */
	readonly name: string;

	/**
	 * Execute tasks using this strategy.
	 * @param tasks - Tasks to execute
	 * @param context - Execution context
	 * @returns Array of task execution results
	 */
	execute(tasks: Task[], context: ExecutionContext): Promise<TaskExecutionResult[]>;

	/**
	 * Check if this strategy can handle the given tasks and options.
	 * @param tasks - Tasks to check
	 * @param options - Execution options
	 * @returns True if strategy can handle these tasks
	 */
	canHandle(tasks: Task[], options: ExecutionOptions): boolean;

	/**
	 * Estimate execution duration for the given tasks.
	 * @param tasks - Tasks to estimate
	 * @returns Estimated duration in milliseconds
	 */
	estimateDuration(tasks: Task[]): number;
}

// ============================================================================
// Strategy Factory
// ============================================================================

/**
 * Factory function type for creating strategies.
 */
export type StrategyFactory = () => IExecutionStrategy;

/**
 * Strategy registration entry.
 */
export interface StrategyRegistration {
	/** Strategy name */
	name: string;
	/** Factory function */
	factory: StrategyFactory;
	/** Priority for auto-selection (higher = preferred) */
	priority: number;
	/** Description of the strategy */
	description?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an empty task execution result.
 */
export function createEmptyTaskResult(taskId: string): TaskExecutionResult {
	return {
		taskId,
		success: false,
		duration: 0,
	};
}

/**
 * Create an empty batch execution result.
 */
export function createEmptyBatchResult(): BatchExecutionResult {
	return {
		results: [],
		tasksExecuted: 0,
		tasksCompleted: 0,
		tasksFailed: 0,
		totalDuration: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		allSucceeded: true,
	};
}

/**
 * Aggregate task results into a batch result.
 */
export function aggregateResults(results: TaskExecutionResult[]): BatchExecutionResult {
	const batch = createEmptyBatchResult();

	for (const result of results) {
		batch.results.push(result);
		batch.tasksExecuted++;
		batch.totalDuration += result.duration;
		batch.totalInputTokens += result.inputTokens ?? 0;
		batch.totalOutputTokens += result.outputTokens ?? 0;

		if (result.success) {
			batch.tasksCompleted++;
		} else {
			batch.tasksFailed++;
			batch.allSucceeded = false;
		}
	}

	return batch;
}

/**
 * Merge execution options with defaults.
 */
export function mergeOptions(options: Partial<ExecutionOptions>): ExecutionOptions {
	return {
		...DEFAULT_EXECUTION_OPTIONS,
		...options,
	};
}
