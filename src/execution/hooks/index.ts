/**
 * Execution Hooks Module
 *
 * Provides lifecycle hooks for monitoring and extending
 * task execution behavior.
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
	TaskHook,
	TaskCompleteHook,
	TaskErrorHook,
	MergeHook,
	MergeConflictHook,
	WorktreeHook,
	GroupHook,
	ExecutionHook,
	HookConfig,
	HookRegistration,
	HookEventName,
	HookResult,
	HookBatchResult,
	IHookBuilder,
} from "./types";

export { DEFAULT_HOOK_CONFIG } from "./types";

// ============================================================================
// Lifecycle Hook Exports
// ============================================================================

export {
	// Default hooks
	createDefaultHooks,
	createEventEmittingHooks,
	createEmptyHooks,
	// Composition
	composeHooks,
	withErrorHandling,
	withTimeout,
	// Builder
	HookBuilder,
	createHookBuilder,
	// Presets
	createProductionHooks,
	createDevelopmentHooks,
	createTestHooks,
} from "./lifecycle";
