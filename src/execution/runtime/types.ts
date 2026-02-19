/**
 * Milhouse Execution Runtime Types
 *
 * This module defines Milhouse-specific types for the execution runtime.
 * These types are designed for the Milhouse pipeline and differ from
 * generic execution types by including:
 * - Pipeline context integration
 * - Event emission hooks
 * - Milhouse-specific metadata
 * - Enhanced result tracking
 *
 * @module execution/runtime/types
 * @since 1.0.0
 */

import type { AIEngineName } from "../../engines/types.ts";
import type { MilhouseEvents } from "../../events/types.ts";

// ============================================================================
// Execution Context Types
// ============================================================================

/**
 * Browser automation mode for Milhouse execution
 */
export type BrowserMode = "auto" | "enabled" | "disabled";

/**
 * Milhouse execution environment configuration
 */
export interface MilhouseExecutionEnvironment {
	/** Working directory for execution */
	readonly workDir: string;
	/** AI engine being used */
	readonly engine: AIEngineName;
	/** Unique run identifier */
	readonly runId: string;
	/** Pipeline phase (if running in pipeline) */
	readonly pipelinePhase?: string;
	/** Whether this is a dry run */
	readonly dryRun: boolean;
	/** Verbose logging enabled */
	readonly verbose: boolean;
}

/**
 * Runtime context passed to all execution functions
 *
 * This context provides access to:
 * - Environment configuration
 * - Event emission
 * - Pipeline state
 * - Execution metadata
 */
export interface MilhouseRuntimeContext {
	/** Execution environment */
	readonly environment: MilhouseExecutionEnvironment;
	/** Event emitter for lifecycle events */
	readonly emitEvent: <E extends keyof MilhouseEvents>(
		event: E,
		payload: MilhouseEvents[E],
	) => void;
	/** Current task ID (if executing a task) */
	readonly currentTaskId?: string;
	/** Execution start timestamp */
	readonly startedAt: Date;
	/** Abort signal for cancellation */
	readonly abortSignal?: AbortSignal;
}

/**
 * Create a new runtime context
 */
export function createRuntimeContext(
	environment: MilhouseExecutionEnvironment,
	emitEvent: MilhouseRuntimeContext["emitEvent"],
	options?: {
		currentTaskId?: string;
		abortSignal?: AbortSignal;
	},
): MilhouseRuntimeContext {
	return {
		environment,
		emitEvent,
		currentTaskId: options?.currentTaskId,
		startedAt: new Date(),
		abortSignal: options?.abortSignal,
	};
}

// ============================================================================
// Execution Result Types
// ============================================================================

/**
 * Detailed execution status
 */
export type ExecutionStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timeout"
	| "skipped";

/**
 * Token usage tracking for AI operations
 */
export interface TokenUsage {
	/** Input tokens consumed */
	readonly inputTokens: number;
	/** Output tokens generated */
	readonly outputTokens: number;
	/** Total tokens (input + output) */
	readonly totalTokens: number;
	/** Estimated cost in USD (if available) */
	readonly estimatedCostUsd?: number;
}

/**
 * Create empty token usage
 */
export function createEmptyTokenUsage(): TokenUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
}

/**
 * Aggregate multiple token usages
 */
export function aggregateTokenUsage(usages: TokenUsage[]): TokenUsage {
	const inputTokens = usages.reduce((sum, u) => sum + u.inputTokens, 0);
	const outputTokens = usages.reduce((sum, u) => sum + u.outputTokens, 0);
	const estimatedCostUsd = usages.some((u) => u.estimatedCostUsd !== undefined)
		? usages.reduce((sum, u) => sum + (u.estimatedCostUsd ?? 0), 0)
		: undefined;

	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		estimatedCostUsd,
	};
}

/**
 * Execution timing information
 */
export interface ExecutionTiming {
	/** When execution started */
	readonly startedAt: Date;
	/** When execution completed (if finished) */
	readonly completedAt?: Date;
	/** Duration in milliseconds */
	readonly durationMs: number;
}

/**
 * Create timing from start time
 */
export function createTiming(startedAt: Date, completedAt?: Date): ExecutionTiming {
	const endTime = completedAt ?? new Date();
	return {
		startedAt,
		completedAt,
		durationMs: endTime.getTime() - startedAt.getTime(),
	};
}

/**
 * Files modified during execution
 */
export interface ModifiedFiles {
	/** Files that were created */
	readonly created: string[];
	/** Files that were modified */
	readonly modified: string[];
	/** Files that were deleted */
	readonly deleted: string[];
	/** Total count of affected files */
	readonly totalCount: number;
}

/**
 * Create empty modified files
 */
export function createEmptyModifiedFiles(): ModifiedFiles {
	return {
		created: [],
		modified: [],
		deleted: [],
		totalCount: 0,
	};
}

/**
 * Milhouse execution result with detailed tracking
 */
export interface MilhouseExecutionResult {
	/** Execution status */
	readonly status: ExecutionStatus;
	/** Whether execution was successful */
	readonly success: boolean;
	/** Token usage */
	readonly tokenUsage: TokenUsage;
	/** Timing information */
	readonly timing: ExecutionTiming;
	/** Files modified */
	readonly filesModified: ModifiedFiles;
	/** Summary of what was done */
	readonly summary: string;
	/** Error message if failed */
	readonly error?: string;
	/** Error stack trace if available */
	readonly errorStack?: string;
	/** Additional metadata */
	readonly metadata: Record<string, unknown>;
}

/**
 * Create a successful execution result
 */
export function createSuccessResult(
	options: Omit<MilhouseExecutionResult, "status" | "success">,
): MilhouseExecutionResult {
	return {
		...options,
		status: "completed",
		success: true,
	};
}

/**
 * Create a failed execution result
 */
export function createFailureResult(
	error: Error | string,
	timing: ExecutionTiming,
	tokenUsage: TokenUsage = createEmptyTokenUsage(),
): MilhouseExecutionResult {
	const errorMessage = error instanceof Error ? error.message : error;
	const errorStack = error instanceof Error ? error.stack : undefined;

	return {
		status: "failed",
		success: false,
		tokenUsage,
		timing,
		filesModified: createEmptyModifiedFiles(),
		summary: `Execution failed: ${errorMessage}`,
		error: errorMessage,
		errorStack,
		metadata: {},
	};
}

// ============================================================================
// Browser Automation Types
// ============================================================================

/**
 * Browser automation configuration
 */
export interface BrowserConfig {
	/** Browser mode */
	readonly mode: BrowserMode;
	/** Whether browser is available */
	readonly isAvailable: boolean;
	/** Browser CLI command (e.g., 'agent-browser') */
	readonly cliCommand: string;
	/** Browser instructions for prompt injection */
	readonly instructions?: string;
}

/**
 * Default browser configuration
 */
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
	mode: "auto",
	isAvailable: false,
	cliCommand: "agent-browser",
};

// ============================================================================
// Prompt Building Types
// ============================================================================

/**
 * Prompt building options for Milhouse
 */
export interface MilhousePromptOptions {
	/** Task description */
	readonly task: string;
	/** Working directory */
	readonly workDir: string;
	/** Auto-commit changes */
	readonly autoCommit: boolean;
	/** Browser configuration */
	readonly browser: BrowserConfig;
	/** Skip tests */
	readonly skipTests: boolean;
	/** Skip linting */
	readonly skipLint: boolean;
	/** Additional context to include */
	readonly additionalContext?: string;
	/** Custom instructions */
	readonly customInstructions?: string[];
}

/**
 * Built prompt with metadata
 */
export interface MilhousePrompt {
	/** The full prompt text */
	readonly text: string;
	/** Sections included in the prompt */
	readonly sections: string[];
	/** Estimated token count */
	readonly estimatedTokens: number;
	/** Whether browser instructions were included */
	readonly includesBrowser: boolean;
}

// ============================================================================
// Retry Configuration Types
// ============================================================================

/**
 * Retry configuration for Milhouse execution
 */
export interface MilhouseRetryConfig {
	/** Maximum number of retry attempts (additional attempts after initial) */
	readonly maxRetries: number;
	/** Base delay between retries in milliseconds */
	readonly baseDelayMs: number;
	/** Maximum delay between retries in milliseconds */
	readonly maxDelayMs: number;
	/** Whether to use exponential backoff */
	readonly exponentialBackoff: boolean;
	/** Jitter factor (0-1) to add randomness to delays */
	readonly jitterFactor: number;
	/** Error patterns that should trigger retry */
	readonly retryablePatterns: RegExp[];
	/** Error patterns that should NOT trigger retry */
	readonly nonRetryablePatterns: RegExp[];
	/**
	 * Retry any failure, not just retryable errors (safety net mode).
	 * When true, all failures are retried up to maxRetries.
	 * When false (default), only retryable errors trigger retries.
	 * @default false
	 */
	readonly retryOnAnyFailure?: boolean;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: MilhouseRetryConfig = {
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	exponentialBackoff: true,
	jitterFactor: 0.1,
	retryablePatterns: [
		/rate limit/i,
		/too many requests/i,
		/429/,
		/timeout/i,
		/network/i,
		/connection/i,
		/ECONNRESET/,
		/ETIMEDOUT/,
		/ENOTFOUND/,
		/overloaded/i,
		/service unavailable/i,
		/503/,
	],
	nonRetryablePatterns: [
		/invalid api key/i,
		/authentication/i,
		/unauthorized/i,
		/401/,
		/forbidden/i,
		/403/,
		/not found/i,
		/404/,
	],
	retryOnAnyFailure: false,
};

/**
 * Retry attempt information
 */
export interface RetryAttempt {
	/** Attempt number (1-based) */
	readonly attempt: number;
	/** Error that triggered retry */
	readonly error: string;
	/** Delay before this attempt in milliseconds */
	readonly delayMs: number;
	/** Timestamp of this attempt */
	readonly timestamp: Date;
}

/**
 * Retry result with attempt history
 */
export interface MilhouseRetryResult<T> {
	/** Whether the operation succeeded */
	readonly success: boolean;
	/** Result value if successful */
	readonly value?: T;
	/** Final error if failed */
	readonly error?: Error;
	/** All retry attempts made */
	readonly attempts: RetryAttempt[];
	/** Total time spent including retries */
	readonly totalDurationMs: number;
}

// ============================================================================
// Conflict Resolution Types
// ============================================================================

/**
 * Merge conflict information
 */
export interface MergeConflict {
	/** File path with conflict */
	readonly filePath: string;
	/** Branch being merged */
	readonly sourceBranch: string;
	/** Target branch */
	readonly targetBranch: string;
	/** Conflict markers found */
	readonly hasMarkers: boolean;
}

/**
 * Conflict resolution result
 */
export interface ConflictResolutionResult {
	/** Whether all conflicts were resolved */
	readonly success: boolean;
	/** Files that were resolved */
	readonly resolvedFiles: string[];
	/** Files that could not be resolved */
	readonly unresolvedFiles: string[];
	/** Token usage for AI resolution */
	readonly tokenUsage: TokenUsage;
	/** Error message if failed */
	readonly error?: string;
}

// ============================================================================
// Milhouse-Specific Constants
// ============================================================================

/**
 * Milhouse execution constants
 */
export const MILHOUSE_EXECUTION = {
	/** Default task timeout in milliseconds (10 minutes) */
	DEFAULT_TASK_TIMEOUT_MS: 600_000,
	/** Default retry delay in milliseconds */
	DEFAULT_RETRY_DELAY_MS: 5_000,
	/** Maximum parallel workers */
	MAX_PARALLEL_WORKERS: 8,
	/** Minimum parallel workers */
	MIN_PARALLEL_WORKERS: 1,
	/** Default parallel workers */
	DEFAULT_PARALLEL_WORKERS: 4,
	/** PR body prefix for Milhouse-created PRs */
	PR_BODY_PREFIX: "Automated PR created by Milhouse",
	/** Branch prefix for Milhouse branches */
	BRANCH_PREFIX: "milhouse/",
	/** Worktree directory name */
	WORKTREE_DIR: ".milhouse-worktrees",
} as const;

/**
 * Type for Milhouse execution constants
 */
export type MilhouseExecutionConstants = typeof MILHOUSE_EXECUTION;
