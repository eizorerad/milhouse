/**
 * Milhouse Execution Runtime
 *
 * This module provides the core runtime infrastructure for Milhouse execution.
 * It includes browser automation, prompt building, retry logic, and conflict resolution.
 *
 * @module execution/runtime
 * @since 1.0.0
 */

// ============================================================================
// Types
// ============================================================================
export type {
	// Execution Context
	BrowserMode,
	MilhouseExecutionEnvironment,
	MilhouseRuntimeContext,
	// Execution Results
	ExecutionStatus,
	TokenUsage,
	ExecutionTiming,
	ModifiedFiles,
	MilhouseExecutionResult,
	// Browser Types
	BrowserConfig,
	// Prompt Types
	MilhousePromptOptions,
	MilhousePrompt,
	// Retry Types
	MilhouseRetryConfig,
	RetryAttempt,
	MilhouseRetryResult,
	// Conflict Resolution Types
	MergeConflict,
	ConflictResolutionResult,
	// Constants Type
	MilhouseExecutionConstants,
} from "./types.ts";

// ============================================================================
// Type Utilities
// ============================================================================
export {
	// Context creation
	createRuntimeContext,
	// Token usage
	createEmptyTokenUsage,
	aggregateTokenUsage,
	// Timing
	createTiming,
	// Modified files
	createEmptyModifiedFiles,
	// Results
	createSuccessResult,
	createFailureResult,
	// Constants
	DEFAULT_BROWSER_CONFIG,
	DEFAULT_RETRY_CONFIG,
	MILHOUSE_EXECUTION,
} from "./types.ts";

// ============================================================================
// Browser Automation
// ============================================================================
export {
	// Detection
	detectAgentBrowser,
	shouldEnableBrowser,
	legacyFlagToBrowserMode,
	// Configuration
	createBrowserConfig,
	createBrowserConfigFromContext,
	// Instructions
	generateBrowserInstructions,
	generateCompactBrowserInstructions,
	getBrowserInstructionsIfAvailable,
	// Utilities
	checkBrowserAvailability,
	// Backward compatibility
	isAgentBrowserInstalled,
	isBrowserAvailable,
	getBrowserInstructions,
} from "./browser.ts";

// ============================================================================
// Prompt Building
// ============================================================================
export {
	// Main prompt builder
	buildMilhousePrompt,
	buildPromptWithContext,
	// Parallel execution prompts
	buildParallelExecutionPrompt,
	// Backward compatibility
	buildPrompt,
	buildParallelPrompt,
} from "./prompt.ts";

export type { ParallelPromptOptions } from "./prompt.ts";

// ============================================================================
// Retry Logic
// ============================================================================
export {
	// Sleep utilities
	sleep,
	sleepWithAbort,
	// Delay calculation
	calculateRetryDelay,
	// Error classification
	isErrorRetryable,
	isRetryableError,
	// Retry execution
	executeWithRetry,
	// Follow-up tasks
	createFollowUpTask,
	failTaskWithFollowUp,
	getFollowUpTasksFor,
	hasPendingFollowUps,
	getTaskRetryCount,
	shouldRetryTask,
	// Backward compatibility
	withRetry,
	withRetryAndFollowUp,
} from "./retry.ts";

export type {
	FollowUpTaskConfig,
	RetryWithFollowUpOptions,
	RetryWithFollowUpResult,
} from "./retry.ts";

// ============================================================================
// Conflict Resolution
// ============================================================================
export {
	// Detection
	detectMergeConflicts,
	createMergeConflictInfo,
	// Prompt building
	buildConflictResolutionPrompt,
	buildSimpleConflictPrompt,
	// Resolution
	resolveConflictsWithEngine,
	resolveConflictsWithContext,
	// Backward compatibility
	resolveConflictsWithAI,
} from "./conflict-resolution.ts";
