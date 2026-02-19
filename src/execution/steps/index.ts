/**
 * Milhouse Step Execution
 *
 * This module provides step-based execution for the Milhouse pipeline.
 * Steps are the atomic units of work, executed either sequentially or in parallel.
 *
 * @module execution/steps
 * @since 1.0.0
 */

// ============================================================================
// Types
// ============================================================================
export type {
	// Status types
	StepStatus,
	StepPhase,
	// Options types
	MilhouseStepOptions,
	MilhouseParallelStepOptions,
	// Result types
	MilhouseStepResult,
	MilhouseStepBatchResult,
	// Parallel group types
	MilhouseParallelGroup,
	MilhouseParallelGroupResult,
	// Worktree types
	WorktreeAgentResult,
	// PR types
	MilhousePRMetadata,
	// Hook types
	MilhouseStepHooks,
} from "./types.ts";


// ============================================================================
// Type Utilities
// ============================================================================
export {
	// Default options
	DEFAULT_STEP_OPTIONS,
	// Step result utilities
	createEmptyStepResult,
	createEmptyBatchResult,
	addStepResultToBatch,
	// PR utilities
	createMilhousePRBody,
	createMilhousePRMetadata,
	// Hook utilities
	createDefaultStepHooks,
} from "./types.ts";

// ============================================================================
// Sequential Execution
// ============================================================================
export {
	// Main runner
	runSequentialSteps,
	// Backward compatibility
	runSequential,
} from "./sequential.ts";

// ============================================================================
// Parallel Execution
// ============================================================================
export {
	// Main runner
	runParallelSteps,
	// Parallel group utilities
	extractParallelGroups,
	getReadyTasksFromGroup,
	isGroupComplete,
	stateTaskToWorktreeTask,
	// Parallel group types and functions (excluding arePreviousGroupsComplete which is in agent module)
	type ParallelGroup,
	type ParallelGroupResult,
	type ParallelGroupExecutionOptions,
	getNextGroupToExecute,
	createGroupResult,
	runParallelGroup,
	runParallelWithGroupOrdering,
	// Backward compatibility
	runParallel,
} from "./parallel.ts";
