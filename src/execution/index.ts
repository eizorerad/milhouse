/**
 * Milhouse Execution Module
 *
 * This module provides the complete execution infrastructure for Milhouse:
 *
 * ## Module Structure
 *
 * - **agent/**: Agent execution types and state management
 * - **runtime/**: Core execution utilities (browser, prompt, retry, conflict-resolution)
 * - **steps/**: Step-based execution (sequential, parallel)
 * - **strategies/**: Strategy pattern for flexible execution
 * - **hooks/**: Lifecycle hooks for monitoring and extension
 *
 * ## Execution Modes
 *
 * - **Sequential**: Tasks executed one at a time
 * - **Parallel**: Tasks executed in parallel using worktrees
 * - **Agent-based**: Uses Executor (EX) agent for intelligent task execution
 * - **Strategy-based**: Pluggable execution strategies
 *
 * @module execution
 * @since 1.0.0
 */

// ============================================================================
// Agent Module (Types and State Management)
// ============================================================================
export * from "./agent/index.ts";

// Backward compatibility aliases
export { createEmptyAgentBatchResult as createEmptyBatchResult } from "./agent/types.ts";

// ============================================================================
// Runtime Module
// ============================================================================
export * from "./runtime/index.ts";

// ============================================================================
// Steps Module
// ============================================================================
export * from "./steps/index.ts";

// ============================================================================
// Strategy-based Execution
// ============================================================================
// Export strategies with explicit names to avoid conflicts
export {
	// Types
	type ExecutionContext as StrategyExecutionContext,
	type ExecutionOptions as StrategyExecutionOptions,
	type TaskExecutionResult as StrategyTaskResult,
	type BatchExecutionResult as StrategyBatchResult,
	type ExecutionHooks as StrategyExecutionHooks,
	type IExecutionStrategy,
	type StrategyFactory,
	type StrategyRegistration,
	// Constants
	DEFAULT_EXECUTION_OPTIONS as DEFAULT_STRATEGY_OPTIONS,
	// Functions
	createEmptyTaskResult as createEmptyStrategyTaskResult,
	createEmptyBatchResult as createEmptyStrategyBatchResult,
	aggregateResults,
	mergeOptions as mergeStrategyOptions,
	// Strategies
	SequentialStrategy,
	createSequentialStrategy,
	ParallelWorktreeStrategy,
	createParallelWorktreeStrategy,
	PipelineAwareStrategy,
	createPipelineAwareStrategy,
	// Registry
	getStrategy,
	selectBestStrategy,
	registerStrategy,
	unregisterStrategy,
	listStrategies,
	getStrategyRegistrations,
	hasStrategy,
	getStrategyRegistration,
	getStrategiesByPriority,
} from "./strategies/index.ts";

// ============================================================================
// Hooks Module
// ============================================================================
export * from "./hooks/index.ts";

// ============================================================================
// Agent Re-exports
// ============================================================================
// Re-export agent types and utilities needed for execution
export {
	type AgentConfig,
	type AgentMetrics,
	type AgentRequest,
	type AgentResponse,
	type EXInput,
	type EXOutput,
	createEmptyMetrics,
	createMetricsFromResult,
} from "../agents/types.ts";

export {
	ExecutorAgent,
	createExecutorAgent,
	buildExecutorPrompt as buildAgentExecutorPrompt,
	isExecutionSuccessful,
	hasModifiedFiles,
	getModifiedFileCount,
	wasFileModified,
	getModifiedFilesMatching,
	getModifiedFilesByExtension,
	hasExecutionError,
	getExecutionError,
	convertToTaskUpdate,
	createExecutionRecordData,
	validateTaskForExecution,
	areAcceptanceCriteriaSatisfiable,
	getCriteriaWithCheckCommands,
	getCriteriaWithoutCheckCommands,
	formatExecutionAsMarkdown,
	parseExecutionFromResponse,
} from "../agents/executor.ts";

export {
	BaseAgent,
	AgentExecutionError,
	AgentTimeoutError,
	executeAgentsInParallel,
} from "../agents/base.ts";

export {
	createAgent,
	createEX,
	AGENT_REGISTRY,
	getAgentRegistryEntry,
	type PipelineAgentRole,
} from "../agents/index.ts";

// ============================================================================
// Unified Strategy-based Execution Function
// ============================================================================

import type { Task as SchemaTask } from "../schemas/tasks.schema.ts";
import { composeHooks, createDefaultHooks, createEventEmittingHooks } from "./hooks/lifecycle.ts";
import { DEFAULT_EXECUTION_OPTIONS, selectBestStrategy } from "./strategies/index.ts";
import type {
	ExecutionContext,
	ExecutionOptions,
	TaskExecutionResult,
} from "./strategies/types.ts";

/**
 * Options for the unified execution function.
 */
export interface ExecuteTasksOptions {
	/** Working directory */
	workDir: string;
	/** AI engine to use */
	engine: string;
	/** Unique run identifier */
	runId: string;
	/** Execute in parallel */
	parallel?: boolean;
	/** Create branch per task */
	branchPerTask?: boolean;
	/** Create pull requests */
	createPr?: boolean;
	/** Maximum parallel workers */
	maxWorkers?: number;
	/** Base branch for operations */
	baseBranch?: string;
	/** Dry run mode */
	dryRun?: boolean;
	/** Skip tests */
	skipTests?: boolean;
	/** Skip linting */
	skipLint?: boolean;
	/** Stop on first failure */
	failFast?: boolean;
	/** Maximum retries */
	maxRetries?: number;
	/** Retry delay in ms */
	retryDelay?: number;
	/** Task timeout in ms */
	taskTimeout?: number;
	/** Model override */
	modelOverride?: string;
	/** Skip merge phase */
	skipMerge?: boolean;
}

/**
 * Execute tasks using the strategy pattern.
 * Automatically selects the best strategy based on options.
 *
 * @param tasks - Tasks to execute (using schema Task type)
 * @param options - Execution options
 * @returns Array of task execution results
 *
 * @example
 * ```typescript
 * const results = await executeTasksWithStrategy(tasks, {
 *   workDir: '/path/to/project',
 *   engine: 'claude',
 *   runId: 'run-123',
 *   parallel: true,
 *   branchPerTask: true,
 * });
 * ```
 */
export async function executeTasksWithStrategy(
	tasks: SchemaTask[],
	options: ExecuteTasksOptions,
): Promise<TaskExecutionResult[]> {
	// Build full execution options
	const fullOptions: ExecutionOptions = {
		parallel: options.parallel ?? DEFAULT_EXECUTION_OPTIONS.parallel,
		branchPerTask: options.branchPerTask ?? DEFAULT_EXECUTION_OPTIONS.branchPerTask,
		createPr: options.createPr ?? DEFAULT_EXECUTION_OPTIONS.createPr,
		maxWorkers: options.maxWorkers ?? DEFAULT_EXECUTION_OPTIONS.maxWorkers,
		baseBranch: options.baseBranch ?? DEFAULT_EXECUTION_OPTIONS.baseBranch,
		dryRun: options.dryRun ?? DEFAULT_EXECUTION_OPTIONS.dryRun,
		skipTests: options.skipTests ?? DEFAULT_EXECUTION_OPTIONS.skipTests,
		skipLint: options.skipLint ?? DEFAULT_EXECUTION_OPTIONS.skipLint,
		failFast: options.failFast ?? DEFAULT_EXECUTION_OPTIONS.failFast,
		maxRetries: options.maxRetries ?? DEFAULT_EXECUTION_OPTIONS.maxRetries,
		retryDelay: options.retryDelay ?? DEFAULT_EXECUTION_OPTIONS.retryDelay,
		taskTimeout: options.taskTimeout ?? DEFAULT_EXECUTION_OPTIONS.taskTimeout,
		modelOverride: options.modelOverride,
		skipMerge: options.skipMerge ?? DEFAULT_EXECUTION_OPTIONS.skipMerge,
	};

	// Build execution context
	const context: ExecutionContext = {
		runId: options.runId,
		workDir: options.workDir,
		engine: options.engine,
		options: fullOptions,
		hooks: composeHooks(createDefaultHooks(), createEventEmittingHooks()),
	};

	// Select and execute with best strategy
	const strategy = selectBestStrategy(fullOptions);
	return strategy.execute(tasks, context);
}
