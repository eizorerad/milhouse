import Bottleneck from "bottleneck";
import { loggers } from "../../observability";
import type { MiddlewareFn } from "../core/types";

/**
 * Options for creating rate limit middleware.
 */
export interface RateLimitOptions {
	/** Maximum requests per minute (default: 60) */
	maxPerMinute?: number;
	/** Maximum requests per hour (default: 1000) */
	maxPerHour?: number;
	/** Minimum time between requests in ms (default: 100) */
	minTime?: number;
	/** Maximum concurrent requests (default: 1) */
	maxConcurrent?: number;
	/** High water mark for queue (default: null - unlimited) */
	highWater?: number | null;
	/** Strategy when high water is reached (default: 'leak') */
	strategy?: "leak" | "overflow" | "block";
}

/**
 * Create a rate limiting middleware using Bottleneck.
 * This provides sophisticated rate limiting with reservoir-based
 * token bucket algorithm.
 *
 * @param options - Rate limiting configuration options
 * @returns Middleware function that enforces rate limits
 *
 * @example
 * ```typescript
 * const executor = new EngineExecutor()
 *   .use(createRateLimitMiddleware({
 *     maxPerMinute: 30,
 *     minTime: 200,
 *   }));
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareFn {
	const {
		maxPerMinute = 60,
		minTime = 100,
		maxConcurrent = 1,
		highWater = null,
		strategy = "leak",
	} = options;

	const strategyMap: Record<string, Bottleneck.Strategy> = {
		leak: Bottleneck.strategy.LEAK,
		overflow: Bottleneck.strategy.OVERFLOW,
		block: Bottleneck.strategy.BLOCK,
	};

	const limiter = new Bottleneck({
		reservoir: maxPerMinute,
		reservoirRefreshAmount: maxPerMinute,
		reservoirRefreshInterval: 60 * 1000, // 1 minute
		minTime,
		maxConcurrent,
		highWater,
		strategy: strategyMap[strategy],
	});

	// Set up event listeners for monitoring
	limiter.on("failed", (error, jobInfo) => {
		const errorMessage = typeof error === "string" ? error : String(error);
		loggers.engine.warn(
			{ error: errorMessage, jobId: jobInfo.options.id },
			"Rate limit: job failed",
		);
	});

	limiter.on("retry", (error, jobInfo) => {
		const errorMessage = typeof error === "string" ? error : String(error);
		loggers.engine.debug(
			{ error: errorMessage, jobId: jobInfo.options.id },
			"Rate limit: retrying job",
		);
	});

	limiter.on("dropped", (dropped) => {
		loggers.engine.warn({ dropped }, "Rate limit: job dropped due to high water mark");
	});

	return async (request, next) => {
		const counts = limiter.counts();

		loggers.engine.debug(
			{
				taskId: request.taskId,
				reservoir: counts.RECEIVED,
				running: counts.RUNNING,
				queued: counts.QUEUED,
			},
			"Rate limit middleware: scheduling execution",
		);

		return limiter.schedule({ id: request.taskId || `task-${Date.now()}` }, async () => {
			loggers.engine.debug({ taskId: request.taskId }, "Rate limit middleware: execution started");

			try {
				return await next();
			} finally {
				loggers.engine.debug(
					{ taskId: request.taskId },
					"Rate limit middleware: execution completed",
				);
			}
		});
	};
}

/**
 * Per-engine rate limiters for fine-grained control.
 */
const engineLimiters = new Map<string, Bottleneck>();

/**
 * Get or create a per-engine rate limiter.
 * @param engineName - Name of the engine
 * @param options - Rate limiting options for this engine
 * @returns The Bottleneck instance for the specified engine
 */
export function getEngineRateLimiter(
	engineName: string,
	options: RateLimitOptions = {},
): Bottleneck {
	if (!engineLimiters.has(engineName)) {
		const { maxPerMinute = 30, minTime = 200, maxConcurrent = 1 } = options;

		const limiter = new Bottleneck({
			reservoir: maxPerMinute,
			reservoirRefreshAmount: maxPerMinute,
			reservoirRefreshInterval: 60 * 1000,
			minTime,
			maxConcurrent,
		});

		engineLimiters.set(engineName, limiter);

		loggers.engine.info(
			{ engineName, maxPerMinute, minTime },
			"Per-engine rate limiter initialized",
		);
	}

	return engineLimiters.get(engineName)!;
}

/**
 * Clear all per-engine rate limiters.
 * Useful for testing or reconfiguration.
 */
export async function clearEngineRateLimiters(): Promise<void> {
	// Stop all limiters gracefully
	const stopPromises: Promise<void>[] = [];
	for (const limiter of engineLimiters.values()) {
		stopPromises.push(limiter.stop({ dropWaitingJobs: true }).then(() => undefined));
	}
	await Promise.all(stopPromises);
	engineLimiters.clear();
}

/**
 * Rate limiter statistics.
 */
export interface RateLimitStats {
	received: number;
	queued: number;
	running: number;
	done: number;
}

/**
 * Get statistics for a specific engine's rate limiter.
 * @param engineName - Name of the engine
 * @returns Statistics object or null if no limiter exists
 */
export function getEngineRateLimitStats(engineName: string): RateLimitStats | null {
	const limiter = engineLimiters.get(engineName);
	if (!limiter) return null;

	const counts = limiter.counts();
	return {
		received: counts.RECEIVED,
		queued: counts.QUEUED,
		running: counts.RUNNING,
		done: counts.DONE ?? 0,
	};
}

/**
 * Create a rate limiter group for coordinating multiple engines.
 * This allows sharing rate limits across different engine types.
 */
export class RateLimiterGroup {
	private readonly group: Bottleneck.Group;
	private readonly limiters: Map<string, Bottleneck> = new Map();

	constructor(options: RateLimitOptions = {}) {
		const { maxPerMinute = 60, minTime = 100, maxConcurrent = 2 } = options;

		this.group = new Bottleneck.Group({
			reservoir: maxPerMinute,
			reservoirRefreshAmount: maxPerMinute,
			reservoirRefreshInterval: 60 * 1000,
			minTime,
			maxConcurrent,
		});
	}

	/**
	 * Get a limiter for a specific key (e.g., engine name).
	 * @param key - The key to get a limiter for
	 * @returns The Bottleneck instance for the key
	 */
	key(key: string): Bottleneck {
		const limiter = this.group.key(key);
		this.limiters.set(key, limiter);
		return limiter;
	}

	/**
	 * Get all keys in the group.
	 * @returns Array of keys
	 */
	keys(): string[] {
		return this.group.keys();
	}

	/**
	 * Delete limiters that have been idle.
	 * @param key - The key to delete
	 */
	deleteKey(key: string): void {
		this.group.deleteKey(key);
		this.limiters.delete(key);
	}

	/**
	 * Stop all limiters in the group.
	 */
	async stopAll(): Promise<void> {
		const stopPromises: Promise<void>[] = [];
		for (const limiter of this.limiters.values()) {
			stopPromises.push(limiter.stop({ dropWaitingJobs: true }).then(() => undefined));
		}
		await Promise.all(stopPromises);
		this.limiters.clear();
	}
}
