/**
 * Milhouse Retry Runtime
 *
 * Provides retry logic and follow-up task creation for Milhouse execution.
 * Implements exponential backoff, jitter, and intelligent retry decisions.
 *
 * Features:
 * - Configurable retry with exponential backoff
 * - Jitter for distributed systems
 * - Follow-up task creation on failure
 * - Event emission for retry lifecycle
 * - Pipeline-aware retry handling
 *
 * @module execution/runtime/retry
 * @since 1.0.0
 */

import { bus } from "../../events/index.ts";
import { createTask, loadTasks, readTask, updateTaskWithLock } from "../../state/tasks.ts";
import type { Task } from "../../state/types.ts";
import { logDebug, logInfo, logWarn } from "../../ui/logger.ts";
import type {
	MilhouseRetryConfig,
	MilhouseRetryResult,
	MilhouseRuntimeContext,
	RetryAttempt,
} from "./types.ts";

// ============================================================================
// Sleep Utilities
// ============================================================================

/**
 * Sleep for a given number of milliseconds
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with abort signal support
 *
 * @param ms - Milliseconds to sleep
 * @param signal - Optional abort signal
 * @returns Promise that resolves after delay or rejects on abort
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		});
	});
}

// ============================================================================
// Delay Calculation
// ============================================================================

/**
 * Calculate delay with exponential backoff and jitter
 *
 * @param attempt - Current attempt number (1-based)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(attempt: number, config: MilhouseRetryConfig): number {
	let delay: number;

	if (config.exponentialBackoff) {
		// Exponential backoff: baseDelay * 2^(attempt-1)
		delay = config.baseDelayMs * 2 ** (attempt - 1);
	} else {
		// Linear delay
		delay = config.baseDelayMs * attempt;
	}

	// Apply jitter
	if (config.jitterFactor > 0) {
		const jitter = delay * config.jitterFactor * (Math.random() * 2 - 1);
		delay += jitter;
	}

	// Clamp to max delay
	return Math.min(Math.max(delay, 0), config.maxDelayMs);
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Check if an error is retryable based on configuration
 *
 * @param error - Error message to check
 * @param config - Retry configuration
 * @returns true if error should trigger retry
 */
export function isErrorRetryable(error: string, config: MilhouseRetryConfig): boolean {
	// Check non-retryable patterns first (they take precedence)
	for (const pattern of config.nonRetryablePatterns) {
		if (pattern.test(error)) {
			logDebug(`Error matches non-retryable pattern: ${pattern}`);
			return false;
		}
	}

	// Check retryable patterns
	for (const pattern of config.retryablePatterns) {
		if (pattern.test(error)) {
			logDebug(`Error matches retryable pattern: ${pattern}`);
			return true;
		}
	}

	// Default: not retryable
	return false;
}

/**
 * Check if an error is retryable (simplified version)
 *
 * @param error - Error message to check
 * @returns true if error should trigger retry
 */
export function isRetryableError(error: string): boolean {
	const retryablePatterns = [
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
	];

	return retryablePatterns.some((pattern) => pattern.test(error));
}

// ============================================================================
// Retry Execution
// ============================================================================

/**
 * Execute a function with Milhouse retry logic
 *
 * @param fn - Function to execute
 * @param config - Retry configuration
 * @param context - Optional runtime context for events
 * @returns Retry result with attempt history
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	config: MilhouseRetryConfig,
	context?: MilhouseRuntimeContext,
): Promise<MilhouseRetryResult<T>> {
	const attempts: RetryAttempt[] = [];
	const startTime = Date.now();
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
		const attemptStart = Date.now();

		try {
			// Check for abort
			if (context?.abortSignal?.aborted) {
				throw new Error("Execution aborted");
			}

			const value = await fn();

			return {
				success: true,
				value,
				attempts,
				totalDurationMs: Date.now() - startTime,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			const errorMsg = lastError.message;

			// Calculate delay for this attempt
			const delayMs = calculateRetryDelay(attempt, config);

			// Record attempt
			attempts.push({
				attempt,
				error: errorMsg,
				delayMs,
				timestamp: new Date(),
			});

			// Emit retry event
			context?.emitEvent("task:progress", {
				taskId: context.currentTaskId ?? "unknown",
				step: "retry",
				detail: `Attempt ${attempt}/${config.maxRetries} failed: ${errorMsg}`,
			});

			// Check if we should retry
			if (attempt < config.maxRetries) {
				if (!isErrorRetryable(errorMsg, config)) {
					logDebug(`Error is not retryable: ${errorMsg}`);
					break;
				}

				logWarn(`Milhouse: Attempt ${attempt}/${config.maxRetries} failed: ${errorMsg}`);
				logDebug(`Waiting ${delayMs}ms before retry...`);

				try {
					await sleepWithAbort(delayMs, context?.abortSignal);
				} catch {
					// Aborted during sleep
					break;
				}
			}
		}
	}

	return {
		success: false,
		error: lastError ?? new Error("All retry attempts failed"),
		attempts,
		totalDurationMs: Date.now() - startTime,
	};
}

// ============================================================================
// Follow-up Task Creation
// ============================================================================

/**
 * Configuration for follow-up task creation
 */
export interface FollowUpTaskConfig {
	/** Task ID that failed */
	taskId: string;
	/** Working directory */
	workDir?: string;
	/** Whether to create follow-up task */
	createFollowUp?: boolean;
	/** Custom title prefix */
	titlePrefix?: string;
}

/**
 * Create a follow-up task from a failed task
 *
 * Creates a new task that:
 * - References the original failed task
 * - Captures the error message for context
 * - Has a higher parallel group to ensure it runs after current batch
 * - Depends on no other tasks (ready for immediate execution when retried)
 *
 * @param originalTaskId - ID of the failed task
 * @param errorMessage - Error that caused the failure
 * @param workDir - Working directory
 * @param titlePrefix - Prefix for the follow-up task title
 * @returns Created follow-up task or null
 */
export function createFollowUpTask(
	originalTaskId: string,
	errorMessage: string,
	workDir = process.cwd(),
	titlePrefix = "Milhouse Retry",
): Task | null {
	const originalTask = readTask(originalTaskId, workDir);

	if (!originalTask) {
		logWarn(`Cannot create follow-up task: original task ${originalTaskId} not found`);
		return null;
	}

	const tasks = loadTasks(workDir);
	const maxParallelGroup = tasks.reduce((max, t) => Math.max(max, t.parallel_group), 0);

	// Truncate error message if too long
	const truncatedError =
		errorMessage.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage;

	const followUpTask = createTask(
		{
			issue_id: originalTask.issue_id,
			title: `${titlePrefix}: ${originalTask.title}`,
			description: `Milhouse follow-up task for failed task ${originalTaskId}.\n\nOriginal error:\n${truncatedError}`,
			files: originalTask.files,
			depends_on: [],
			checks: originalTask.checks,
			acceptance: originalTask.acceptance,
			risk: originalTask.risk,
			rollback: originalTask.rollback,
			parallel_group: maxParallelGroup + 1,
			status: "pending",
		},
		workDir,
	);

	logInfo(`Milhouse: Created follow-up task ${followUpTask.id} for failed task ${originalTaskId}`);

	// Emit event for follow-up task creation
	bus.emit("task:start", {
		taskId: followUpTask.id,
		title: followUpTask.title,
	});

	return followUpTask;
}

/**
 * Mark a task as failed and optionally create a follow-up task
 *
 * This function uses updateTaskWithLock for concurrent-safe updates
 * when called from parallel execution contexts.
 *
 * @param taskId - Task ID to mark as failed
 * @param errorMessage - Error message
 * @param createFollowUp - Whether to create follow-up task
 * @param workDir - Working directory
 * @returns Failed task and optional follow-up task
 */
export async function failTaskWithFollowUp(
	taskId: string,
	errorMessage: string,
	createFollowUp: boolean,
	workDir = process.cwd(),
): Promise<{ failedTask: Task | null; followUpTask: Task | null }> {
	const failedTask = await updateTaskWithLock(
		taskId,
		{
			status: "failed",
			error: errorMessage,
		},
		workDir,
	);

	let followUpTask: Task | null = null;

	if (createFollowUp && failedTask) {
		followUpTask = createFollowUpTask(taskId, errorMessage, workDir);
	}

	return { failedTask, followUpTask };
}

// ============================================================================
// Follow-up Task Queries
// ============================================================================

/**
 * Get all follow-up tasks for a given original task
 *
 * @param originalTaskId - Original task ID
 * @param workDir - Working directory
 * @returns Array of follow-up tasks
 */
export function getFollowUpTasksFor(originalTaskId: string, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);

	return tasks.filter((task) => {
		const descriptionRef = `failed task ${originalTaskId}`;
		return task.description?.toLowerCase().includes(descriptionRef.toLowerCase());
	});
}

/**
 * Check if a task has any pending follow-up tasks
 *
 * @param taskId - Task ID to check
 * @param workDir - Working directory
 * @returns true if pending follow-ups exist
 */
export function hasPendingFollowUps(taskId: string, workDir = process.cwd()): boolean {
	const followUps = getFollowUpTasksFor(taskId, workDir);
	return followUps.some((t) => t.status === "pending");
}

/**
 * Get the retry count for a task based on follow-up tasks
 *
 * @param taskId - Task ID to check
 * @param workDir - Working directory
 * @returns Number of retries (follow-up tasks)
 */
export function getTaskRetryCount(taskId: string, workDir = process.cwd()): number {
	const followUps = getFollowUpTasksFor(taskId, workDir);
	return followUps.length;
}

/**
 * Determine if a task should be retried based on error type and retry count
 *
 * @param taskId - Task ID
 * @param errorMessage - Error message
 * @param maxRetries - Maximum allowed retries
 * @param workDir - Working directory
 * @returns true if task should be retried
 */
export function shouldRetryTask(
	taskId: string,
	errorMessage: string,
	maxRetries: number,
	workDir = process.cwd(),
): boolean {
	const retryCount = getTaskRetryCount(taskId, workDir);

	if (retryCount >= maxRetries) {
		logDebug(`Task ${taskId} has reached max retries (${maxRetries})`);
		return false;
	}

	if (!isRetryableError(errorMessage)) {
		logDebug(`Error is not retryable: ${errorMessage}`);
		return false;
	}

	return true;
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Legacy retry options interface
 * @deprecated Use MilhouseRetryConfig instead
 */
interface LegacyRetryOptions {
	maxRetries: number;
	retryDelay: number;
	onRetry?: (attempt: number, error: string) => void;
}

/**
 * Execute a function with retry logic
 * @deprecated Use executeWithRetry() instead
 */
export async function withRetry<T>(fn: () => Promise<T>, options: LegacyRetryOptions): Promise<T> {
	const { maxRetries, retryDelay, onRetry } = options;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				const errorMsg = lastError.message;
				logWarn(`Attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);
				onRetry?.(attempt, errorMsg);

				logDebug(`Waiting ${retryDelay}ms before retry...`);
				await sleep(retryDelay);
			}
		}
	}

	throw lastError || new Error("All retry attempts failed");
}

/**
 * Extended retry options with follow-up task support
 * @deprecated Use executeWithRetry() with FollowUpTaskConfig instead
 */
export interface RetryWithFollowUpOptions extends LegacyRetryOptions {
	followUp?: FollowUpTaskConfig;
}

/**
 * Result of retry with follow-up information
 * @deprecated Use MilhouseRetryResult instead
 */
export interface RetryWithFollowUpResult<T> {
	success: boolean;
	value?: T;
	error?: Error;
	followUpTask?: Task;
	attempts: number;
}

/**
 * Execute a function with retry logic and follow-up task creation on failure
 * @deprecated Use executeWithRetry() with follow-up handling instead
 */
export async function withRetryAndFollowUp<T>(
	fn: () => Promise<T>,
	options: RetryWithFollowUpOptions,
): Promise<RetryWithFollowUpResult<T>> {
	const { maxRetries, retryDelay, onRetry, followUp } = options;
	let lastError: Error | null = null;
	let attempts = 0;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		attempts = attempt;
		try {
			const value = await fn();
			return {
				success: true,
				value,
				attempts,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				const errorMsg = lastError.message;
				logWarn(`Attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);
				onRetry?.(attempt, errorMsg);

				logDebug(`Waiting ${retryDelay}ms before retry...`);
				await sleep(retryDelay);
			}
		}
	}

	const errorMessage = lastError?.message || "All retry attempts failed";
	let followUpTask: Task | undefined;

	if (followUp?.createFollowUp && followUp.taskId) {
		const created = createFollowUpTask(
			followUp.taskId,
			errorMessage,
			followUp.workDir,
			followUp.titlePrefix,
		);
		if (created) {
			followUpTask = created;
		}
	}

	return {
		success: false,
		error: lastError || new Error("All retry attempts failed"),
		followUpTask,
		attempts,
	};
}
