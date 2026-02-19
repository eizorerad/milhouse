/**
 * Agent Execution Module
 *
 * Types and utilities for agent-based task execution.
 *
 * @module execution/agent
 * @since 5.0.0
 */

// Types
export {
	type AgentExecutionMode,
	type AgentExecutionConfig,
	type AgentTaskResult,
	type AgentBatchResult,
	type ParallelGroupConfig,
	DEFAULT_AGENT_EXECUTION_CONFIG,
	createAgentExecutionConfig,
	createEmptyAgentTaskResult,
	createEmptyAgentBatchResult,
	addTaskResultToBatch,
	mergeBatchResults,
	createParallelGroupsFromTasks,
	getTasksInParallelGroup,
	arePreviousGroupsComplete,
	getBlockingTasks,
} from "./types.ts";

// State management
export {
	type ExecutionState,
	type ExecutionValidation,
	createInitialExecutionState,
	startExecution,
	startTask,
	completeTask,
	failTask,
	skipTask,
	advanceToNextGroup,
	completeExecution,
	isExecutionComplete,
	hasExecutionFailures,
	getExecutionProgress,
	isTaskReady,
	getReadyTasksForExecution,
	getReadyTasksInGroup,
	getBlockedTasksForExecution,
	getUnsatisfiedDependencies,
	validateTasksForExecution,
} from "./state.ts";
