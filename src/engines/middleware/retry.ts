import { loggers } from "../../observability";
import type { MiddlewareFn } from "../core/types";

/**
 * Options for creating retry middleware.
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Base delay between retries in ms (default: 1000) */
	baseDelay?: number;
	/** Maximum delay between retries in ms (default: 30000) */
	maxDelay?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Add jitter to delay to prevent thundering herd (default: true) */
	jitter?: boolean;
	/** Custom function to determine if error is retryable */
	isRetryable?: (error: Error) => boolean;
	/** Callback when retry occurs */
	onRetry?: (error: Error, attempt: number, delay: number) => void;
}

/**
 * Default list of non-retryable error patterns.
 */
const NON_RETRYABLE_PATTERNS = [
	"validation",
	"unauthorized",
	"forbidden",
	"not found",
	"invalid",
	"permission denied",
	"authentication",
	"api key",
];

/**
 * Check if an error is retryable based on default patterns.
 */
function defaultIsRetryable(error: Error): boolean {
	const message = error.message.toLowerCase();
	return !NON_RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Calculate delay with exponential backoff and optional jitter.
 */
function calculateDelay(
	attempt: number,
	baseDelay: number,
	maxDelay: number,
	backoffMultiplier: number,
	jitter: boolean,
): number {
	// Exponential backoff: baseDelay * multiplier^attempt
	let delay = baseDelay * backoffMultiplier ** (attempt - 1);

	// Cap at maxDelay
	delay = Math.min(delay, maxDelay);

	// Add jitter (±25% of delay)
	if (jitter) {
		const jitterRange = delay * 0.25;
		delay = delay + (Math.random() * 2 - 1) * jitterRange;
	}

	return Math.round(delay);
}

/**
 * Create a retry middleware with exponential backoff.
 * This middleware will retry failed executions up to maxRetries times,
 * with increasing delays between attempts.
 *
 * @param options - Retry configuration options
 * @returns Middleware function that handles retries
 *
 * @example
 * ```typescript
 * const executor = new EngineExecutor()
 *   .use(createRetryMiddleware({
 *     maxRetries: 3,
 *     baseDelay: 1000,
 *     maxDelay: 30000,
 *   }));
 * ```
 */
export function createRetryMiddleware(options: RetryOptions = {}): MiddlewareFn {
	const {
		maxRetries = 3,
		baseDelay = 1000,
		maxDelay = 30000,
		backoffMultiplier = 2,
		jitter = true,
		isRetryable = defaultIsRetryable,
		onRetry,
	} = options;

	return async (request, next) => {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				// If this is a retry, wait before attempting
				if (attempt > 0) {
					const delay = calculateDelay(attempt, baseDelay, maxDelay, backoffMultiplier, jitter);

					loggers.engine.info(
						{
							taskId: request.taskId,
							attempt,
							maxRetries,
							delay,
							previousError: lastError?.message,
						},
						"Retrying engine execution after delay",
					);

					// Call onRetry callback if provided
					if (onRetry && lastError) {
						onRetry(lastError, attempt, delay);
					}

					await sleep(delay);
				}

				// Attempt execution
				return await next();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if we should retry
				if (!isRetryable(lastError)) {
					loggers.engine.warn(
						{
							taskId: request.taskId,
							attempt,
							error: lastError.message,
						},
						"Error is not retryable, failing immediately",
					);
					throw lastError;
				}

				// Check if we have retries left
				if (attempt >= maxRetries) {
					loggers.engine.error(
						{
							taskId: request.taskId,
							attempt,
							maxRetries,
							error: lastError.message,
						},
						"Max retries exceeded, failing",
					);
					throw lastError;
				}

				loggers.engine.warn(
					{
						taskId: request.taskId,
						attempt,
						maxRetries,
						error: lastError.message,
					},
					"Engine execution attempt failed, will retry",
				);
			}
		}

		// This should never be reached, but TypeScript needs it
		throw lastError || new Error("Retry middleware failed unexpectedly");
	};
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a retry middleware with custom retry logic.
 * Allows full control over retry behavior.
 *
 * @param shouldRetry - Function that determines if and when to retry
 * @returns Middleware function with custom retry logic
 */
export function createCustomRetryMiddleware(
	shouldRetry: (error: Error, attempt: number, request: unknown) => Promise<boolean | number>,
): MiddlewareFn {
	return async (request, next) => {
		let attempt = 0;
		let lastError: Error | null = null;

		while (true) {
			try {
				return await next();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				attempt++;

				const retryResult = await shouldRetry(lastError, attempt, request);

				if (retryResult === false) {
					throw lastError;
				}

				// If retryResult is a number, use it as delay
				const delay = typeof retryResult === "number" ? retryResult : 1000;

				loggers.engine.debug(
					{ attempt, delay, error: lastError.message },
					"Custom retry: waiting before next attempt",
				);

				await sleep(delay);
			}
		}
	};
}

/**
 * Create a circuit breaker middleware that stops retrying after
 * too many failures in a time window.
 */
export class CircuitBreaker {
	private failures: number[] = [];
	private state: "closed" | "open" | "half-open" = "closed";
	private lastStateChange: number = Date.now();

	constructor(
		private readonly options: {
			/** Number of failures to trigger open state */
			failureThreshold: number;
			/** Time window for counting failures (ms) */
			failureWindow: number;
			/** Time to wait before trying again (ms) */
			resetTimeout: number;
		},
	) {}

	/**
	 * Create a middleware that implements circuit breaker pattern.
	 */
	createMiddleware(): MiddlewareFn {
		return async (request, next) => {
			// Check if circuit is open
			if (this.state === "open") {
				const timeSinceOpen = Date.now() - this.lastStateChange;
				if (timeSinceOpen < this.options.resetTimeout) {
					throw new Error("Circuit breaker is open - too many recent failures");
				}
				// Transition to half-open
				this.state = "half-open";
				this.lastStateChange = Date.now();
				loggers.engine.info("Circuit breaker transitioning to half-open");
			}

			try {
				const result = await next();

				// Success - reset if in half-open state
				if (this.state === "half-open") {
					this.state = "closed";
					this.failures = [];
					this.lastStateChange = Date.now();
					loggers.engine.info("Circuit breaker closed after successful execution");
				}

				return result;
			} catch (error) {
				// Record failure
				const now = Date.now();
				this.failures.push(now);

				// Remove old failures outside the window
				const windowStart = now - this.options.failureWindow;
				this.failures = this.failures.filter((t) => t > windowStart);

				// Check if we should open the circuit
				if (this.failures.length >= this.options.failureThreshold) {
					this.state = "open";
					this.lastStateChange = now;
					loggers.engine.warn(
						{ failures: this.failures.length, threshold: this.options.failureThreshold },
						"Circuit breaker opened due to too many failures",
					);
				}

				throw error;
			}
		};
	}

	/**
	 * Get current circuit breaker state.
	 */
	getState(): { state: string; failures: number; lastStateChange: Date } {
		return {
			state: this.state,
			failures: this.failures.length,
			lastStateChange: new Date(this.lastStateChange),
		};
	}

	/**
	 * Manually reset the circuit breaker.
	 */
	reset(): void {
		this.state = "closed";
		this.failures = [];
		this.lastStateChange = Date.now();
	}
}
