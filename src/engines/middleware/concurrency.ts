import pLimit, { type LimitFunction } from "p-limit";
import { loggers } from "../../observability";
import type { MiddlewareFn } from "../core/types";

/**
 * Create a concurrency limiting middleware using p-limit.
 * This ensures only a specified number of engine executions
 * can run simultaneously.
 *
 * @param maxConcurrent - Maximum number of concurrent executions (default: 1)
 * @returns Middleware function that enforces concurrency limits
 *
 * @example
 * ```typescript
 * const executor = new EngineExecutor()
 *   .use(createConcurrencyMiddleware(2)); // Allow 2 concurrent executions
 * ```
 */
export function createConcurrencyMiddleware(maxConcurrent = 1): MiddlewareFn {
	if (maxConcurrent < 1) {
		throw new Error("maxConcurrent must be at least 1");
	}

	const limit = pLimit(maxConcurrent);

	return async (request, next) => {
		const pendingCount = limit.pendingCount;
		const activeCount = limit.activeCount;

		loggers.engine.debug(
			{
				maxConcurrent,
				pendingCount,
				activeCount,
				taskId: request.taskId,
			},
			"Concurrency middleware: checking slot availability",
		);

		return limit(async () => {
			loggers.engine.debug(
				{ taskId: request.taskId },
				"Concurrency middleware: acquired execution slot",
			);

			try {
				return await next();
			} finally {
				loggers.engine.debug(
					{ taskId: request.taskId },
					"Concurrency middleware: released execution slot",
				);
			}
		});
	};
}

/**
 * Global concurrency limiter singleton for cross-engine coordination.
 * Use this when you need to limit total concurrent executions across
 * all engine types.
 */
let globalLimiter: LimitFunction | null = null;

/**
 * Get or create the global concurrency limiter.
 * @param maxConcurrent - Maximum concurrent executions globally (default: 4)
 * @returns The global p-limit instance
 */
export function getGlobalConcurrencyLimiter(maxConcurrent = 4): LimitFunction {
	if (!globalLimiter) {
		globalLimiter = pLimit(maxConcurrent);
		loggers.engine.info({ maxConcurrent }, "Global concurrency limiter initialized");
	}
	return globalLimiter;
}

/**
 * Reset the global concurrency limiter.
 * Useful for testing or reconfiguration.
 */
export function resetGlobalConcurrencyLimiter(): void {
	globalLimiter = null;
}

/**
 * Create a middleware that uses the global concurrency limiter.
 * @returns Middleware function using global concurrency control
 */
export function createGlobalConcurrencyMiddleware(): MiddlewareFn {
	return async (request, next) => {
		const limiter = getGlobalConcurrencyLimiter();

		loggers.engine.debug(
			{
				pendingCount: limiter.pendingCount,
				activeCount: limiter.activeCount,
				taskId: request.taskId,
			},
			"Global concurrency middleware: checking slot",
		);

		return limiter(async () => {
			loggers.engine.debug(
				{ taskId: request.taskId },
				"Global concurrency middleware: acquired global slot",
			);

			try {
				return await next();
			} finally {
				loggers.engine.debug(
					{ taskId: request.taskId },
					"Global concurrency middleware: released global slot",
				);
			}
		});
	};
}

/**
 * Per-engine concurrency limiters for fine-grained control.
 */
const engineLimiters = new Map<string, LimitFunction>();

/**
 * Get or create a per-engine concurrency limiter.
 * @param engineName - Name of the engine
 * @param maxConcurrent - Maximum concurrent executions for this engine (default: 2)
 * @returns The p-limit instance for the specified engine
 */
export function getEngineConcurrencyLimiter(engineName: string, maxConcurrent = 2): LimitFunction {
	if (!engineLimiters.has(engineName)) {
		engineLimiters.set(engineName, pLimit(maxConcurrent));
		loggers.engine.info(
			{ engineName, maxConcurrent },
			"Per-engine concurrency limiter initialized",
		);
	}
	return engineLimiters.get(engineName)!;
}

/**
 * Clear all per-engine concurrency limiters.
 * Useful for testing or reconfiguration.
 */
export function clearEngineConcurrencyLimiters(): void {
	engineLimiters.clear();
}

/**
 * Get statistics about current concurrency usage.
 */
export interface ConcurrencyStats {
	global: {
		pending: number;
		active: number;
	};
	perEngine: Record<string, { pending: number; active: number }>;
}

/**
 * Get current concurrency statistics across all limiters.
 * @returns Statistics object with global and per-engine counts
 */
export function getConcurrencyStats(): ConcurrencyStats {
	const global = globalLimiter
		? { pending: globalLimiter.pendingCount, active: globalLimiter.activeCount }
		: { pending: 0, active: 0 };

	const perEngine: Record<string, { pending: number; active: number }> = {};
	for (const [name, limiter] of engineLimiters) {
		perEngine[name] = {
			pending: limiter.pendingCount,
			active: limiter.activeCount,
		};
	}

	return { global, perEngine };
}
