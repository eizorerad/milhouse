import { bus } from "../../events";
import { loggers } from "../../observability";
import type { MiddlewareFn } from "../core/types";

/**
 * Options for creating logging middleware.
 */
export interface LoggingOptions {
	/** Log level for start/complete messages (default: 'info') */
	level?: "debug" | "info" | "warn" | "error";
	/** Include request metadata in logs (default: true) */
	includeMetadata?: boolean;
	/** Include step counts in completion logs (default: true) */
	includeStepCounts?: boolean;
	/** Emit events to the event bus (default: true) */
	emitEvents?: boolean;
	/** Include Milhouse context fields in logs (default: true) */
	includeContext?: boolean;
}

/**
 * Create a logging middleware that logs execution lifecycle events.
 * This middleware logs when execution starts, completes, or fails,
 * and optionally emits events to the event bus.
 *
 * When Milhouse context is available, it includes:
 * - runId: Unique identifier for the execution run
 * - agentRole: Role of the agent (executor, verifier, etc.)
 * - pipelinePhase: Current phase in the pipeline (scan, exec, verify, etc.)
 *
 * @param options - Logging configuration options
 * @returns Middleware function that logs execution events
 *
 * @example
 * ```typescript
 * const executor = new EngineExecutor()
 *   .use(createLoggingMiddleware({ level: 'debug', includeContext: true }));
 * ```
 */
export function createLoggingMiddleware(options: LoggingOptions = {}): MiddlewareFn {
	const {
		level = "info",
		includeMetadata = true,
		includeStepCounts = true,
		emitEvents = true,
		includeContext = true,
	} = options;

	return async (request, next, context) => {
		const startTime = Date.now();
		const { taskId, workDir, metadata, runId, agentRole, pipelinePhase } = request;

		// Build log context with Milhouse-specific fields
		const logContext: Record<string, unknown> = {
			taskId: taskId || "unknown",
			workDir,
		};

		// Include Milhouse context fields when available
		if (includeContext) {
			// Prefer context parameter, fall back to request fields
			const effectiveRunId = context?.runId ?? runId;
			const effectiveAgentRole = context?.agentRole ?? agentRole;
			const effectivePipelinePhase = context?.pipelinePhase ?? pipelinePhase;

			if (effectiveRunId) {
				logContext.runId = effectiveRunId;
			}
			if (effectiveAgentRole) {
				logContext.agentRole = effectiveAgentRole;
			}
			if (effectivePipelinePhase) {
				logContext.pipelinePhase = effectivePipelinePhase;
			}
		}

		if (includeMetadata && metadata) {
			logContext.metadata = metadata;
		}

		// Log start
		loggers.engine[level](logContext, "Engine execution starting");

		// Emit start event with context fields
		if (emitEvents) {
			bus.emit("engine:start", {
				engine: "unknown", // Will be set by executor with plugin name
				taskId: taskId || "unknown",
				runId: context?.runId ?? runId,
				agentRole: context?.agentRole ?? agentRole,
				pipelinePhase: context?.pipelinePhase ?? pipelinePhase,
			});
		}

		try {
			const result = await next();
			const duration = Date.now() - startTime;

			// Build completion log context
			const completionContext: Record<string, unknown> = {
				...logContext,
				duration,
				success: result.success,
			};

			if (includeStepCounts) {
				completionContext.stepCount = result.steps.length;
				completionContext.stepTypes = countStepTypes(result.steps);
			}

			if (result.exitCode !== undefined) {
				completionContext.exitCode = result.exitCode;
			}

			// Log completion
			loggers.engine[level](completionContext, "Engine execution completed");

			// Emit completion event with context fields
			if (emitEvents) {
				bus.emit("engine:complete", {
					engine: "unknown",
					taskId: taskId || "unknown",
					result,
					runId: context?.runId ?? runId,
					agentRole: context?.agentRole ?? agentRole,
					pipelinePhase: context?.pipelinePhase ?? pipelinePhase,
				});
			}

			return result;
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Log error with context
			loggers.engine.error(
				{
					...logContext,
					duration,
					error: errorMessage,
					stack: error instanceof Error ? error.stack : undefined,
				},
				"Engine execution failed",
			);

			// Emit error event with context fields
			if (emitEvents) {
				bus.emit("engine:error", {
					engine: "unknown",
					taskId: taskId || "unknown",
					error: error instanceof Error ? error : new Error(errorMessage),
					runId: context?.runId ?? runId,
					agentRole: context?.agentRole ?? agentRole,
					pipelinePhase: context?.pipelinePhase ?? pipelinePhase,
				});
			}

			throw error;
		}
	};
}

/**
 * Count step types in execution result.
 */
function countStepTypes(steps: Array<{ type: string }>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const step of steps) {
		counts[step.type] = (counts[step.type] || 0) + 1;
	}
	return counts;
}

/**
 * Create a verbose logging middleware that logs each step.
 * Useful for debugging but may produce a lot of output.
 *
 * Includes Milhouse context fields (runId, agentRole, pipelinePhase) when available.
 *
 * @returns Middleware function that logs detailed step information
 */
export function createVerboseLoggingMiddleware(): MiddlewareFn {
	return async (request, next, context) => {
		const startTime = Date.now();
		const { taskId, runId, agentRole, pipelinePhase } = request;

		// Build base context with Milhouse fields
		const baseContext: Record<string, unknown> = {
			taskId,
		};

		// Include Milhouse context fields when available
		const effectiveRunId = context?.runId ?? runId;
		const effectiveAgentRole = context?.agentRole ?? agentRole;
		const effectivePipelinePhase = context?.pipelinePhase ?? pipelinePhase;

		if (effectiveRunId) baseContext.runId = effectiveRunId;
		if (effectiveAgentRole) baseContext.agentRole = effectiveAgentRole;
		if (effectivePipelinePhase) baseContext.pipelinePhase = effectivePipelinePhase;

		loggers.engine.debug(
			{
				...baseContext,
				prompt: `${request.prompt.substring(0, 100)}...`,
				workDir: request.workDir,
				timeout: request.timeout,
				maxRetries: request.maxRetries,
			},
			"Engine execution request details",
		);

		try {
			const result = await next();
			const duration = Date.now() - startTime;

			// Log each step with context
			for (let i = 0; i < result.steps.length; i++) {
				const step = result.steps[i];
				loggers.engine.debug(
					{
						...baseContext,
						stepIndex: i,
						stepType: step.type,
						contentLength: step.content.length,
						timestamp: step.timestamp,
					},
					`Step ${i + 1}/${result.steps.length}: ${step.type}`,
				);
			}

			loggers.engine.debug(
				{
					...baseContext,
					duration,
					success: result.success,
					outputLength: result.output.length,
					stepCount: result.steps.length,
				},
				"Engine execution result details",
			);

			return result;
		} catch (error) {
			const duration = Date.now() - startTime;

			loggers.engine.debug(
				{
					...baseContext,
					duration,
					error: error instanceof Error ? error.message : String(error),
				},
				"Engine execution error details",
			);

			throw error;
		}
	};
}

/**
 * Metrics tracked per runId and agentRole combination.
 */
interface RunMetrics {
	executions: number;
	successful: number;
	failed: number;
	totalDuration: number;
	totalSteps: number;
}

/**
 * Create a metrics logging middleware that tracks execution metrics.
 * Logs aggregated metrics periodically.
 *
 * Enhanced to track metrics per runId and agentRole for Milhouse pipeline analysis.
 */
export class MetricsLogger {
	private metrics = {
		totalExecutions: 0,
		successfulExecutions: 0,
		failedExecutions: 0,
		totalDuration: 0,
		totalSteps: 0,
	};

	/** Metrics tracked per runId */
	private runMetrics = new Map<string, RunMetrics>();

	/** Metrics tracked per agentRole */
	private roleMetrics = new Map<string, RunMetrics>();

	/**
	 * Create a middleware that collects metrics.
	 * Tracks both global metrics and per-runId/agentRole metrics.
	 */
	createMiddleware(): MiddlewareFn {
		return async (request, next, context) => {
			const startTime = Date.now();
			this.metrics.totalExecutions++;

			// Get context fields for per-run/role tracking
			const runId = context?.runId ?? request.runId;
			const agentRole = context?.agentRole ?? request.agentRole;

			// Initialize run metrics if needed
			if (runId && !this.runMetrics.has(runId)) {
				this.runMetrics.set(runId, {
					executions: 0,
					successful: 0,
					failed: 0,
					totalDuration: 0,
					totalSteps: 0,
				});
			}

			// Initialize role metrics if needed
			if (agentRole && !this.roleMetrics.has(agentRole)) {
				this.roleMetrics.set(agentRole, {
					executions: 0,
					successful: 0,
					failed: 0,
					totalDuration: 0,
					totalSteps: 0,
				});
			}

			// Increment execution counts
			if (runId) {
				const rm = this.runMetrics.get(runId);
				if (rm) rm.executions++;
			}
			if (agentRole) {
				const rm = this.roleMetrics.get(agentRole);
				if (rm) rm.executions++;
			}

			try {
				const result = await next();
				const duration = Date.now() - startTime;

				// Update global metrics
				this.metrics.successfulExecutions++;
				this.metrics.totalDuration += duration;
				this.metrics.totalSteps += result.steps.length;

				// Update per-run metrics
				if (runId) {
					const rm = this.runMetrics.get(runId);
					if (rm) {
						rm.successful++;
						rm.totalDuration += duration;
						rm.totalSteps += result.steps.length;
					}
				}

				// Update per-role metrics
				if (agentRole) {
					const rm = this.roleMetrics.get(agentRole);
					if (rm) {
						rm.successful++;
						rm.totalDuration += duration;
						rm.totalSteps += result.steps.length;
					}
				}

				return result;
			} catch (error) {
				// Update failure counts
				this.metrics.failedExecutions++;

				if (runId) {
					const rm = this.runMetrics.get(runId);
					if (rm) rm.failed++;
				}
				if (agentRole) {
					const rm = this.roleMetrics.get(agentRole);
					if (rm) rm.failed++;
				}

				throw error;
			}
		};
	}

	/**
	 * Get current global metrics.
	 */
	getMetrics(): typeof this.metrics & { averageDuration: number } {
		return {
			...this.metrics,
			averageDuration:
				this.metrics.successfulExecutions > 0
					? this.metrics.totalDuration / this.metrics.successfulExecutions
					: 0,
		};
	}

	/**
	 * Get metrics for a specific runId.
	 */
	getRunMetrics(runId: string): RunMetrics | undefined {
		return this.runMetrics.get(runId);
	}

	/**
	 * Get metrics for a specific agentRole.
	 */
	getRoleMetrics(agentRole: string): RunMetrics | undefined {
		return this.roleMetrics.get(agentRole);
	}

	/**
	 * Get all run metrics.
	 */
	getAllRunMetrics(): Map<string, RunMetrics> {
		return new Map(this.runMetrics);
	}

	/**
	 * Get all role metrics.
	 */
	getAllRoleMetrics(): Map<string, RunMetrics> {
		return new Map(this.roleMetrics);
	}

	/**
	 * Log current metrics.
	 */
	logMetrics(): void {
		loggers.engine.info(this.getMetrics(), "Engine execution metrics");
	}

	/**
	 * Log metrics for a specific run.
	 */
	logRunMetrics(runId: string): void {
		const metrics = this.runMetrics.get(runId);
		if (metrics) {
			loggers.engine.info({ runId, ...metrics }, "Run execution metrics");
		}
	}

	/**
	 * Reset all metrics.
	 */
	reset(): void {
		this.metrics = {
			totalExecutions: 0,
			successfulExecutions: 0,
			failedExecutions: 0,
			totalDuration: 0,
			totalSteps: 0,
		};
		this.runMetrics.clear();
		this.roleMetrics.clear();
	}
}
