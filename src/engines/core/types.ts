import type {
	AgentRole,
	EngineConfig,
	EvidenceRequirements,
	ExecutionRequest,
	ExecutionRequestInput,
	ExecutionResult,
	ExecutionStep,
	GateConfig,
	PipelinePhase,
	StreamChunk,
} from "../../schemas/engine.schema";

// Re-export schema types for convenience
export type {
	ExecutionRequest,
	ExecutionRequestInput,
	ExecutionResult,
	ExecutionStep,
	EngineConfig,
	StreamChunk,
	// Milhouse-specific types
	AgentRole,
	PipelinePhase,
	EvidenceRequirements,
	GateConfig,
};

/**
 * Callback type for receiving execution steps during streaming.
 * Called for each step as it is parsed from the engine output.
 */
export type StepCallback = (step: ExecutionStep) => void;

/**
 * Milhouse execution context for middleware.
 * This is a lightweight context object passed through the middleware chain.
 */
export interface MiddlewareContext {
	/** Unique run identifier for tracking */
	runId?: string;
	/** Agent role executing the request */
	agentRole?: AgentRole;
	/** Current pipeline phase */
	pipelinePhase?: PipelinePhase;
	/** Evidence requirements for collection */
	evidenceRequirements?: EvidenceRequirements;
	/** Gate configuration for validation */
	gateConfig?: GateConfig;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Middleware function type for the engine execution pipeline.
 * Follows the Koa-style middleware pattern with next() function.
 *
 * The optional context parameter provides Milhouse-specific execution context
 * for middleware that needs access to run tracking, agent roles, or evidence collection.
 *
 * @param request - The execution request
 * @param next - Function to call the next middleware in the chain
 * @param context - Optional Milhouse execution context
 * @returns Promise resolving to the execution result
 *
 * @example
 * ```typescript
 * const loggingMiddleware: MiddlewareFn = async (request, next, context) => {
 *   console.log(`[${context?.runId}] Starting execution`);
 *   const result = await next();
 *   console.log(`[${context?.runId}] Completed`);
 *   return result;
 * };
 * ```
 */
export type MiddlewareFn = (
	request: ExecutionRequest,
	next: () => Promise<ExecutionResult>,
	context?: MiddlewareContext,
) => Promise<ExecutionResult>;

/**
 * Engine plugin interface - defines the contract for engine implementations.
 * Each engine (claude, opencode, cursor, etc.) implements this interface.
 */
export interface IEnginePlugin {
	/** Unique name identifier for the engine */
	readonly name: string;

	/** Engine configuration including command, args, timeouts */
	readonly config: EngineConfig;

	/**
	 * Check if the engine CLI is available on the system.
	 * @returns Promise resolving to true if engine is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Build command line arguments for the engine execution.
	 * @param request - The execution request containing prompt and options
	 * @returns Array of command line arguments
	 */
	buildArgs(request: ExecutionRequest): string[];

	/**
	 * Parse the raw output from the engine into a structured result.
	 * @param output - Raw stdout/stderr output from the engine
	 * @returns Parsed execution result
	 */
	parseOutput(output: string): ExecutionResult;

	/**
	 * Get environment variables to set for the engine process.
	 * @returns Record of environment variable key-value pairs
	 */
	getEnv(): Record<string, string>;

	/**
	 * Indicates whether this plugin uses stdin for prompt input.
	 * If true, the executor will write the prompt to stdin.
	 * If false, the prompt should be passed via command line arguments.
	 *
	 * @returns true if the plugin expects prompt via stdin, false otherwise
	 * @default true (for backward compatibility)
	 */
	usesStdinForPrompt?(): boolean;
}

/**
 * Engine executor interface - manages middleware chain and execution.
 */
export interface IEngineExecutor {
	/**
	 * Execute a request using the specified plugin.
	 * @param plugin - The engine plugin to use
	 * @param request - The execution request (partial input, defaults applied)
	 * @returns Promise resolving to the execution result
	 */
	execute(plugin: IEnginePlugin, request: ExecutionRequestInput): Promise<ExecutionResult>;

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
	executeStreaming(
		plugin: IEnginePlugin,
		request: ExecutionRequestInput,
		onStep?: StepCallback,
	): Promise<ExecutionResult>;

	/**
	 * Add middleware to the execution chain.
	 * @param middleware - The middleware function to add
	 * @returns The executor instance for chaining
	 */
	use(middleware: MiddlewareFn): IEngineExecutor;

	/**
	 * Get the current middleware chain.
	 * @returns Array of middleware functions
	 */
	getMiddleware(): MiddlewareFn[];
}

/**
 * Stream handler callback type for processing output chunks.
 */
export type StreamHandler = (chunk: StreamChunk) => void;

/**
 * Process spawn options for engine execution.
 */
export interface SpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: "pipe" | "inherit" | "ignore";
	stdout: "pipe" | "inherit" | "ignore";
	stderr: "pipe" | "inherit" | "ignore";
}

/**
 * Engine availability check result.
 */
export interface AvailabilityResult {
	available: boolean;
	version?: string;
	error?: string;
}

/**
 * Execution context passed through middleware chain.
 */
export interface ExecutionContext {
	request: ExecutionRequest;
	plugin: IEnginePlugin;
	startTime: number;
	attempt: number;
	metadata: Record<string, unknown>;
}
