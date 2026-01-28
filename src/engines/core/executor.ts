import { loggers } from "../../observability";
import type {
	ExecutionRequest,
	ExecutionRequestInput,
	ExecutionResult,
} from "../../schemas/engine.schema";
import { ExecutionRequestSchema, ExecutionResultSchema } from "../../schemas/engine.schema";
import { MiddlewareChain } from "../middleware/chain";
import { createConcurrencyMiddleware } from "../middleware/concurrency";
import { createLoggingMiddleware } from "../middleware/logging";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { createRetryMiddleware } from "../middleware/retry";
import { createTimeoutMiddleware } from "../middleware/timeout";
import { createMilhouseContext, extractContextMetadata } from "./context";
import { RealtimeStreamProcessor } from "./streaming";
import type { IEngineExecutor, IEnginePlugin, MiddlewareFn, StepCallback } from "./types";

/**
 * Core engine executor that manages middleware chain and plugin execution.
 * This is the main entry point for executing engine commands.
 */
export class EngineExecutor implements IEngineExecutor {
	private readonly chain: MiddlewareChain;

	constructor() {
		this.chain = new MiddlewareChain();
	}

	/**
	 * Add middleware to the execution chain.
	 * Middleware is executed in the order added.
	 */
	use(middleware: MiddlewareFn): this {
		this.chain.use(middleware);
		return this;
	}

	/**
	 * Get a copy of the current middleware chain.
	 */
	getMiddleware(): MiddlewareFn[] {
		return this.chain.toArray();
	}

	/**
	 * Execute a request using the specified plugin.
	 * The request is validated, passed through middleware, and executed.
	 */
	async execute(plugin: IEnginePlugin, request: ExecutionRequestInput): Promise<ExecutionResult> {
		return this.executeStreaming(plugin, request);
	}

	/**
	 * Execute a request with streaming step callbacks.
	 * This method allows consumers to receive execution steps in real-time
	 * as they are parsed from the engine output.
	 *
	 * @param plugin - The engine plugin to use
	 * @param request - The execution request (partial input, defaults applied)
	 * @param onStep - Optional callback invoked for each execution step
	 * @returns Promise resolving to the execution result
	 */
	async executeStreaming(
		plugin: IEnginePlugin,
		request: ExecutionRequestInput,
		onStep?: StepCallback,
	): Promise<ExecutionResult> {
		// Validate request using Zod schema
		const validatedRequest = ExecutionRequestSchema.parse(request);

		// Check plugin availability
		const available = await plugin.isAvailable();
		if (!available) {
			throw new Error(`Engine '${plugin.name}' is not available on this system`);
		}

		loggers.engine.debug(
			{ engine: plugin.name, taskId: validatedRequest.taskId },
			"Starting engine execution",
		);

		// Build the final execution handler
		const executeHandler = async (): Promise<ExecutionResult> => {
			return this.runCommand(plugin, validatedRequest, onStep);
		};

		// Apply middleware chain
		const composedMiddleware = this.chain.compose();
		const result = await composedMiddleware(validatedRequest, executeHandler);

		// Validate result using Zod schema
		return ExecutionResultSchema.parse(result);
	}

	/**
	 * Run the actual command using the plugin.
	 *
	 * This method creates a MilhouseExecutionContext for tracking and includes
	 * context metadata in the result for observability and evidence collection.
	 *
	 * @param plugin - The engine plugin to use
	 * @param request - The validated execution request
	 * @param onStep - Optional callback invoked for each execution step
	 * @returns Execution result with context metadata
	 *
	 * @example
	 * ```typescript
	 * // Context is automatically created with runId, agentRole, etc.
	 * const result = await executor.execute(plugin, {
	 *   prompt: 'Fix the bug',
	 *   workDir: '/project',
	 *   runId: 'run-123',
	 *   agentRole: 'executor',
	 *   pipelinePhase: 'exec',
	 * });
	 *
	 * // Result includes context metadata
	 * console.log(result.metadata?.runId); // 'run-123'
	 * ```
	 */
	private async runCommand(
		plugin: IEnginePlugin,
		request: ExecutionRequest,
		onStep?: StepCallback,
	): Promise<ExecutionResult> {
		// Create Milhouse execution context for tracking
		const context = createMilhouseContext(request, plugin);

		const args = plugin.buildArgs(request);
		const env = { ...process.env, ...plugin.getEnv() };

		loggers.engine.debug(
			{
				command: plugin.config.command,
				args,
				workDir: request.workDir,
				runId: context.runId,
				agentRole: context.agentRole,
				pipelinePhase: context.pipelinePhase,
			},
			"Spawning engine process",
		);

		// Spawn the process
		const proc = Bun.spawn([plugin.config.command, ...args], {
			cwd: request.workDir,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Set up stream processor for real-time output with optional step callback
		const streamProcessor = new RealtimeStreamProcessor({
			taskId: request.taskId || "unknown",
			engineName: plugin.name,
			onStep,
		});

		// Write prompt to stdin only if the plugin expects it
		// Some plugins (like Claude) pass the prompt via command line args instead
		const usesStdin = plugin.usesStdinForPrompt?.() ?? true;
		if (usesStdin && request.prompt) {
			proc.stdin.write(request.prompt);
			proc.stdin.end();
		} else {
			// Close stdin immediately if not used
			proc.stdin.end();
		}

		// Read stdout in a separate async task
		const readStdout = async (): Promise<void> => {
			const stdoutReader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await stdoutReader.read();
					if (done) break;

					const chunk = decoder.decode(value, { stream: true });
					streamProcessor.processChunk({
						type: "stdout",
						data: chunk,
						timestamp: new Date(),
					});
				}
			} finally {
				stdoutReader.releaseLock();
			}
		};

		// Read stderr in a separate async task
		const readStderr = async (): Promise<string> => {
			return new Response(proc.stderr).text();
		};

		// Wait for process exit - this resolves when process terminates
		const waitForExit = async (): Promise<number> => {
			return proc.exited;
		};

		// Run stdout reading, stderr reading, and exit waiting in parallel
		// When the process exits, we need to ensure streams are properly closed
		// Using Promise.allSettled to handle cases where streams might error
		const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
			readStdout(),
			readStderr(),
			waitForExit(),
		]);

		// Get exit code (should always succeed if process was spawned)
		const exitCode = exitResult.status === "fulfilled" ? exitResult.value : 1;

		// Process stderr if available
		if (stderrResult.status === "fulfilled" && stderrResult.value) {
			streamProcessor.processChunk({
				type: "stderr",
				data: stderrResult.value,
				timestamp: new Date(),
			});
		}

		// Log if stdout reading failed (shouldn't happen normally)
		if (stdoutResult.status === "rejected") {
			loggers.engine.warn(
				{ error: stdoutResult.reason },
				"Failed to read stdout from engine process",
			);
		}

		streamProcessor.processChunk({
			type: "exit",
			data: exitCode,
			timestamp: new Date(),
		});

		// Finalize and get results
		const { output, steps } = streamProcessor.finalize();
		const duration = Date.now() - context.startTime;

		// Parse output using plugin's parser
		const parsedResult = plugin.parseOutput(output);

		// Extract context metadata for inclusion in result
		const contextMetadata = extractContextMetadata(context);

		// Merge parsed result with execution metadata and context
		return {
			...parsedResult,
			duration,
			exitCode,
			// Use parsed steps if available, otherwise use stream-collected steps
			steps: parsedResult.steps.length > 0 ? parsedResult.steps : steps,
			// Include Milhouse context metadata for pipeline tracking
			metadata: {
				...parsedResult.metadata,
				...contextMetadata,
			},
		};
	}
}

/**
 * Create a default executor with standard middleware stack.
 * This provides a ready-to-use executor with logging, timeout, retry, and concurrency.
 */
export function createDefaultExecutor(): EngineExecutor {
	return new EngineExecutor()
		.use(createLoggingMiddleware())
		.use(createTimeoutMiddleware())
		.use(createRetryMiddleware({ maxRetries: 3 }))
		.use(createConcurrencyMiddleware(2));
}

/**
 * Create a minimal executor with only logging.
 * Useful for testing or when you want full control over middleware.
 */
export function createMinimalExecutor(): EngineExecutor {
	return new EngineExecutor().use(createLoggingMiddleware());
}

/**
 * Create an executor with custom middleware configuration.
 */
export interface ExecutorConfig {
	logging?: boolean;
	timeout?: number;
	retry?: {
		maxRetries?: number;
		baseDelay?: number;
	};
	concurrency?: number;
	rateLimit?: {
		maxPerMinute?: number;
	};
}

/**
 * Create an executor with the specified configuration.
 */
export function createConfiguredExecutor(config: ExecutorConfig): EngineExecutor {
	const executor = new EngineExecutor();

	if (config.logging !== false) {
		executor.use(createLoggingMiddleware());
	}

	if (config.timeout) {
		executor.use(createTimeoutMiddleware({ defaultTimeout: config.timeout }));
	}

	if (config.retry) {
		executor.use(createRetryMiddleware(config.retry));
	}

	if (config.rateLimit) {
		executor.use(createRateLimitMiddleware(config.rateLimit));
	}

	if (config.concurrency) {
		executor.use(createConcurrencyMiddleware(config.concurrency));
	}

	return executor;
}

/**
 * Execute a single command with a plugin without creating an executor.
 * Convenience function for one-off executions.
 */
export async function executeOnce(
	plugin: IEnginePlugin,
	request: ExecutionRequest,
): Promise<ExecutionResult> {
	const executor = createMinimalExecutor();
	return executor.execute(plugin, request);
}

/**
 * Execute with automatic plugin selection based on availability.
 */
export async function executeWithFallback(
	plugins: IEnginePlugin[],
	request: ExecutionRequest,
): Promise<ExecutionResult> {
	const executor = createDefaultExecutor();

	for (const plugin of plugins) {
		try {
			const available = await plugin.isAvailable();
			if (available) {
				loggers.engine.info({ engine: plugin.name }, "Using available engine");
				return await executor.execute(plugin, request);
			}
		} catch (error) {
			loggers.engine.warn({ engine: plugin.name, error }, "Engine check failed, trying next");
		}
	}

	throw new Error(`No available engine found. Tried: ${plugins.map((p) => p.name).join(", ")}`);
}
