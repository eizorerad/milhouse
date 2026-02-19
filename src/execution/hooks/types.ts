/**
 * Execution Hook Types
 *
 * Type definitions for lifecycle hooks in the execution system.
 * Hooks provide extension points for monitoring, logging, and
 * custom behavior during task execution.
 */

import type { Task } from "../../schemas/tasks.schema";
import type {
	BatchExecutionResult,
	ExecutionContext,
	TaskExecutionResult,
} from "../strategies/types";

// ============================================================================
// Core Hook Types
// ============================================================================

/**
 * Hook function type for task lifecycle events.
 */
export type TaskHook<T = void> = (task: Task, context: ExecutionContext) => Promise<T>;

/**
 * Hook function type for task completion events.
 */
export type TaskCompleteHook = (task: Task, result: TaskExecutionResult) => Promise<void>;

/**
 * Hook function type for task error events.
 */
export type TaskErrorHook = (task: Task, error: Error) => Promise<void>;

/**
 * Hook function type for merge events.
 */
export type MergeHook = (branch: string, target: string) => Promise<void>;

/**
 * Hook function type for merge conflict events.
 */
export type MergeConflictHook = (branch: string, target: string, files: string[]) => Promise<void>;

/**
 * Hook function type for worktree events.
 */
export type WorktreeHook = (path: string, branch?: string) => Promise<void>;

/**
 * Hook function type for group events.
 */
export type GroupHook = (group: number, data: number | TaskExecutionResult[]) => Promise<void>;

/**
 * Hook function type for execution lifecycle events.
 */
export type ExecutionHook = (
	context: ExecutionContext,
	data: number | BatchExecutionResult,
) => Promise<void>;

// ============================================================================
// Hook Configuration
// ============================================================================

/**
 * Configuration for hook behavior.
 */
export interface HookConfig {
	/** Whether to continue execution if hook throws */
	continueOnError: boolean;
	/** Timeout for hook execution in milliseconds */
	timeout: number;
	/** Whether to run hooks in parallel when possible */
	parallel: boolean;
	/** Enable debug logging for hooks */
	debug: boolean;
}

/**
 * Default hook configuration.
 */
export const DEFAULT_HOOK_CONFIG: HookConfig = {
	continueOnError: true,
	timeout: 30000, // 30 seconds
	parallel: false,
	debug: false,
};

// ============================================================================
// Hook Registry Types
// ============================================================================

/**
 * Hook registration entry.
 */
export interface HookRegistration<T extends (...args: any[]) => Promise<any>> {
	/** Unique identifier for this hook */
	id: string;
	/** Hook function */
	handler: T;
	/** Priority (higher = runs first) */
	priority: number;
	/** Whether hook is enabled */
	enabled: boolean;
	/** Optional description */
	description?: string;
}

/**
 * Hook event names.
 */
export type HookEventName =
	| "task:start"
	| "task:complete"
	| "task:error"
	| "merge:start"
	| "merge:complete"
	| "merge:conflict"
	| "worktree:create"
	| "worktree:cleanup"
	| "group:start"
	| "group:complete"
	| "execution:start"
	| "execution:complete";

// ============================================================================
// Hook Result Types
// ============================================================================

/**
 * Result of running a hook.
 */
export interface HookResult {
	/** Hook ID */
	hookId: string;
	/** Whether hook succeeded */
	success: boolean;
	/** Execution duration in milliseconds */
	duration: number;
	/** Error if hook failed */
	error?: Error;
}

/**
 * Aggregate result of running multiple hooks.
 */
export interface HookBatchResult {
	/** Individual hook results */
	results: HookResult[];
	/** Total execution duration */
	totalDuration: number;
	/** Number of successful hooks */
	succeeded: number;
	/** Number of failed hooks */
	failed: number;
	/** Whether all hooks succeeded */
	allSucceeded: boolean;
}

// ============================================================================
// Hook Builder Types
// ============================================================================

/**
 * Builder interface for creating hook sets.
 */
export interface IHookBuilder {
	/** Add task start hook */
	onTaskStart(handler: TaskHook): IHookBuilder;
	/** Add task complete hook */
	onTaskComplete(handler: TaskCompleteHook): IHookBuilder;
	/** Add task error hook */
	onTaskError(handler: TaskErrorHook): IHookBuilder;
	/** Add merge start hook */
	onMergeStart(handler: MergeHook): IHookBuilder;
	/** Add merge complete hook */
	onMergeComplete(handler: MergeHook): IHookBuilder;
	/** Add merge conflict hook */
	onMergeConflict(handler: MergeConflictHook): IHookBuilder;
	/** Add worktree create hook */
	onWorktreeCreate(handler: WorktreeHook): IHookBuilder;
	/** Add worktree cleanup hook */
	onWorktreeCleanup(handler: (path: string) => Promise<void>): IHookBuilder;
	/** Build the hook set */
	build(): import("../strategies/types").ExecutionHooks;
}
