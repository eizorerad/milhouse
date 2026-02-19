import { loggers } from "../../observability";
import type { MiddlewareFn } from "../core/types";

/**
 * Custom error class for timeout errors.
 */
export class TimeoutError extends Error {
	readonly timeout: number;
	readonly taskId?: string;

	constructor(timeout: number, taskId?: string) {
		super(`Engine execution timed out after ${timeout}ms`);
		this.name = "TimeoutError";
		this.timeout = timeout;
		this.taskId = taskId;
	}
}

/**
 * Options for creating timeout middleware.
 */
export interface TimeoutOptions {
	/** Default timeout in ms (default: 4000000 ≈ 66 minutes) */
	defaultTimeout?: number;
	/** Callback when timeout occurs */
	onTimeout?: (timeout: number, taskId?: string) => void;
	/** Whether to use AbortController for cleanup (default: true) */
	useAbortController?: boolean;
}

/**
 * Create a timeout middleware that enforces execution time limits.
 * If execution exceeds the timeout, a TimeoutError is thrown.
 *
 * @param options - Timeout configuration options
 * @returns Middleware function that enforces timeouts
 *
 * @example
 * ```typescript
 * const executor = new EngineExecutor()
 *   .use(createTimeoutMiddleware({ defaultTimeout: 60000 })); // 1 minute
 * ```
 */
export function createTimeoutMiddleware(options: TimeoutOptions = {}): MiddlewareFn {
	const { defaultTimeout = 4000000, onTimeout, useAbortController = true } = options;

	return async (request, next) => {
		const timeout = request.timeout || defaultTimeout;
		const { taskId } = request;

		loggers.engine.debug(
			{ taskId, timeout },
			"Timeout middleware: starting execution with timeout",
		);

		// Create abort controller if supported
		const abortController = useAbortController ? new AbortController() : null;

		// Create timeout promise
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				// Abort any ongoing operations
				if (abortController) {
					abortController.abort();
				}

				// Log timeout
				loggers.engine.error({ taskId, timeout }, "Timeout middleware: execution timed out");

				// Call onTimeout callback
				if (onTimeout) {
					onTimeout(timeout, taskId);
				}

				reject(new TimeoutError(timeout, taskId));
			}, timeout);
		});

		try {
			// Race between execution and timeout
			const result = await Promise.race([next(), timeoutPromise]);

			// Clear timeout on success
			if (timeoutId) {
				clearTimeout(timeoutId);
			}

			loggers.engine.debug({ taskId }, "Timeout middleware: execution completed within timeout");

			return result;
		} catch (error) {
			// Clear timeout on error
			if (timeoutId) {
				clearTimeout(timeoutId);
			}

			// Re-throw the error (could be TimeoutError or other error)
			throw error;
		}
	};
}

/**
 * Create a deadline middleware that enforces an absolute deadline.
 * Unlike timeout which is relative to execution start, deadline is
 * an absolute timestamp.
 *
 * @param deadline - Absolute timestamp (Date or ms since epoch)
 * @returns Middleware function that enforces the deadline
 */
export function createDeadlineMiddleware(deadline: Date | number): MiddlewareFn {
	const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;

	return async (request, next) => {
		const now = Date.now();
		const remaining = deadlineMs - now;

		if (remaining <= 0) {
			throw new TimeoutError(0, request.taskId);
		}

		loggers.engine.debug(
			{ taskId: request.taskId, deadline: new Date(deadlineMs).toISOString(), remaining },
			"Deadline middleware: checking deadline",
		);

		// Create timeout for remaining time
		const timeoutMiddleware = createTimeoutMiddleware({
			defaultTimeout: remaining,
		});

		return timeoutMiddleware(request, next);
	};
}

/**
 * Create a progressive timeout middleware that increases timeout
 * on retries. Useful when combined with retry middleware.
 */
export interface ProgressiveTimeoutOptions {
	/** Initial timeout in ms */
	initialTimeout: number;
	/** Maximum timeout in ms */
	maxTimeout: number;
	/** Multiplier for each retry */
	multiplier?: number;
}

/**
 * Track timeout state for progressive timeout.
 */
class ProgressiveTimeoutState {
	private currentTimeout: number;
	private readonly maxTimeout: number;
	private readonly multiplier: number;

	constructor(options: ProgressiveTimeoutOptions) {
		this.currentTimeout = options.initialTimeout;
		this.maxTimeout = options.maxTimeout;
		this.multiplier = options.multiplier || 1.5;
	}

	getTimeout(): number {
		return this.currentTimeout;
	}

	increaseTimeout(): void {
		this.currentTimeout = Math.min(this.currentTimeout * this.multiplier, this.maxTimeout);
	}

	reset(): void {
		this.currentTimeout = this.maxTimeout / this.multiplier ** 3;
	}
}

/**
 * Create a progressive timeout middleware.
 * The timeout increases with each failed attempt.
 *
 * @param options - Progressive timeout options
 * @returns Middleware function with progressive timeout
 */
export function createProgressiveTimeoutMiddleware(
	options: ProgressiveTimeoutOptions,
): MiddlewareFn {
	const state = new ProgressiveTimeoutState(options);

	return async (request, next) => {
		const timeout = state.getTimeout();

		loggers.engine.debug(
			{ taskId: request.taskId, timeout },
			"Progressive timeout middleware: using current timeout",
		);

		const timeoutMiddleware = createTimeoutMiddleware({
			defaultTimeout: timeout,
		});

		try {
			const result = await timeoutMiddleware(request, next);
			// Reset on success
			state.reset();
			return result;
		} catch (error) {
			// Increase timeout for next attempt
			state.increaseTimeout();
			throw error;
		}
	};
}

/**
 * Check if an error is a TimeoutError.
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
	return error instanceof TimeoutError;
}

/**
 * Create a timeout with cleanup callback.
 * Useful for cleaning up resources when timeout occurs.
 */
export function createTimeoutWithCleanup(
	timeout: number,
	cleanup: () => void | Promise<void>,
): { promise: Promise<never>; cancel: () => void } {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const promise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(async () => {
			try {
				await cleanup();
			} catch (cleanupError) {
				loggers.engine.warn({ error: cleanupError }, "Timeout cleanup failed");
			}
			reject(new TimeoutError(timeout));
		}, timeout);
	});

	const cancel = () => {
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	return { promise, cancel };
}
