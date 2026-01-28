import { createEngine, getPlugin } from "../engines/index.ts";
import type { AIEngineName, AIResult, EngineOptions } from "../engines/types.ts";
import {
	AGENT_CATEGORIES,
	type AfterExecuteHook,
	type AgentCapabilities,
	type AgentConfig,
	type AgentHooks,
	type AgentMetrics,
	type AgentRequest,
	type AgentResponse,
	type AgentRole,
	type BeforeExecuteHook,
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_PARALLEL_CONFIG,
	type OnErrorHook,
	type ParallelExecutionConfig,
	type ParallelExecutionResult,
	type PromptSection,
	buildPromptFromSections,
	createEmptyMetrics,
	createMetricsFromResult,
	getAgentCapabilities,
} from "./types.ts";

/**
 * Error thrown when agent execution fails
 */
export class AgentExecutionError extends Error {
	constructor(
		message: string,
		public readonly role: AgentRole,
		public readonly cause?: Error,
	) {
		super(message);
		this.name = "AgentExecutionError";
	}
}

/**
 * Error thrown when agent is not available
 */
export class AgentNotAvailableError extends Error {
	constructor(
		message: string,
		public readonly role: AgentRole,
		public readonly engine: AIEngineName,
	) {
		super(message);
		this.name = "AgentNotAvailableError";
	}
}

/**
 * Error thrown when agent times out
 */
export class AgentTimeoutError extends Error {
	constructor(
		message: string,
		public readonly role: AgentRole,
		public readonly timeoutMs: number,
	) {
		super(message);
		this.name = "AgentTimeoutError";
	}
}

/**
 * Base agent interface - defines the contract for all agents
 */
export interface IAgent<TInput = unknown, TOutput = unknown> {
	/** Agent role */
	readonly role: AgentRole;
	/** Agent configuration */
	readonly config: AgentConfig;
	/** Agent capabilities */
	readonly capabilities: AgentCapabilities;
	/** Execute the agent */
	execute(request: AgentRequest<TInput>): Promise<AgentResponse<TOutput>>;
	/** Check if the agent is available */
	isAvailable(engine?: AIEngineName): Promise<boolean>;
	/** Build the prompt for this agent */
	buildPrompt(input: TInput, workDir: string): string;
	/** Parse the output from the AI response */
	parseOutput(response: string): TOutput;
}

/**
 * Base agent class with common functionality
 *
 * Provides:
 * - Retry logic with configurable delays
 * - Timeout handling
 * - Metrics tracking
 * - Lifecycle hooks
 * - Prompt building from sections
 */
export abstract class BaseAgent<TInput = unknown, TOutput = unknown>
	implements IAgent<TInput, TOutput>
{
	readonly role: AgentRole;
	readonly config: AgentConfig;
	readonly capabilities: AgentCapabilities;

	protected hooks: AgentHooks = {};

	constructor(role: AgentRole, configOverrides?: Partial<AgentConfig>) {
		this.role = role;
		const defaultConfig = DEFAULT_AGENT_CONFIGS[role];
		this.config = {
			...defaultConfig,
			...configOverrides,
			capabilities: configOverrides?.capabilities ?? defaultConfig.capabilities,
		};
		this.capabilities = this.config.capabilities;
	}

	/**
	 * Check if the agent is available (engine is installed)
	 */
	async isAvailable(engine?: AIEngineName): Promise<boolean> {
		const engineName = engine ?? this.config.defaultEngine;
		try {
			const plugin = getPlugin(engineName);
			return await plugin.isAvailable();
		} catch {
			return false;
		}
	}

	/**
	 * Build the prompt for this agent
	 * Subclasses should override this to provide role-specific prompts
	 */
	abstract buildPrompt(input: TInput, workDir: string): string;

	/**
	 * Parse the output from the AI response
	 * Subclasses should override this to provide role-specific parsing
	 */
	abstract parseOutput(response: string): TOutput;

	/**
	 * Build prompt sections for the agent
	 * Subclasses can override this to customize prompt structure
	 */
	protected buildPromptSections(input: TInput, workDir: string): PromptSection[] {
		return [];
	}

	/**
	 * Build prompt from sections
	 * Uses buildPromptSections if available, otherwise uses buildPrompt directly
	 */
	protected buildFinalPrompt(input: TInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return buildPromptFromSections(sections);
		}
		return this.buildPrompt(input, workDir);
	}

	/**
	 * Execute the agent with a request
	 */
	async execute(request: AgentRequest<TInput>): Promise<AgentResponse<TOutput>> {
		const startTime = Date.now();
		const engine = request.engine ?? this.config.defaultEngine;
		let currentRequest = request;
		let attempts = 0;
		let lastError: Error | null = null;

		// Run before hooks
		currentRequest = await this.runBeforeHooks(currentRequest);

		// Check availability
		const available = await this.isAvailable(engine);
		if (!available) {
			const error = new AgentNotAvailableError(
				`Engine ${engine} is not available for agent ${this.role}`,
				this.role,
				engine,
			);
			await this.runErrorHooks(currentRequest, error);
			return this.createErrorResponse(error, engine, startTime);
		}

		// Execute with retries
		// maxRetries = 0 means 1 attempt (no retries)
		// maxRetries = 2 means 3 attempts (1 initial + 2 retries)
		const maxAttempts = this.config.maxRetries + 1;

		while (attempts < maxAttempts) {
			try {
				const response = await this.executeWithTimeout(currentRequest, engine, startTime);

				// Run after hooks
				const finalResponse = await this.runAfterHooks(currentRequest, response);
				return finalResponse;
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				lastError = err;
				attempts++;

				// Don't retry timeout errors
				if (err instanceof AgentTimeoutError) {
					await this.runErrorHooks(currentRequest, err);
					return this.createErrorResponse(err, engine, startTime, attempts - 1);
				}

				// If we've exhausted all attempts, return error
				if (attempts >= maxAttempts) {
					await this.runErrorHooks(currentRequest, err);
					return this.createErrorResponse(err, engine, startTime, attempts - 1);
				}

				// Wait before retry
				await this.delay(this.config.retryDelayMs);
			}
		}

		// Should not reach here, but handle just in case
		const error = lastError ?? new AgentExecutionError("Unexpected execution state", this.role);
		return this.createErrorResponse(error, engine, startTime, attempts - 1);
	}

	/**
	 * Execute with timeout
	 */
	private async executeWithTimeout(
		request: AgentRequest<TInput>,
		engine: AIEngineName,
		startTime: number,
	): Promise<AgentResponse<TOutput>> {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(
					new AgentTimeoutError(`Agent ${this.role} timed out`, this.role, this.config.timeoutMs),
				);
			}, this.config.timeoutMs);
		});

		const executePromise = this.executeInternal(request, engine, startTime);

		return Promise.race([executePromise, timeoutPromise]);
	}

	/**
	 * Internal execution logic
	 */
	private async executeInternal(
		request: AgentRequest<TInput>,
		engineName: AIEngineName,
		startTime: number,
	): Promise<AgentResponse<TOutput>> {
		const aiEngine = await createEngine(engineName);
		const prompt = this.buildFinalPrompt(request.input, request.workDir);

		const engineOptions: EngineOptions = {
			modelOverride: request.engineOptions?.modelOverride,
		};

		const result = await aiEngine.execute(prompt, request.workDir, engineOptions);
		const durationMs = Date.now() - startTime;

		return this.processAIResult(result, engineName, durationMs);
	}

	/**
	 * Process AI result into agent response
	 */
	private processAIResult(
		result: AIResult,
		engine: AIEngineName,
		durationMs: number,
	): AgentResponse<TOutput> {
		if (!result.success) {
			return {
				success: false,
				error: result.error ?? "AI execution failed",
				metrics: createMetricsFromResult(result, durationMs, engine),
				rawResponse: result.response,
			};
		}

		try {
			const output = this.parseOutput(result.response);
			return {
				success: true,
				output,
				metrics: createMetricsFromResult(result, durationMs, engine),
				rawResponse: result.response,
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return {
				success: false,
				error: `Failed to parse output: ${err.message}`,
				metrics: createMetricsFromResult(result, durationMs, engine),
				rawResponse: result.response,
			};
		}
	}

	/**
	 * Create an error response
	 */
	private createErrorResponse(
		error: Error,
		engine: AIEngineName,
		startTime: number,
		retries = 0,
	): AgentResponse<TOutput> {
		const durationMs = Date.now() - startTime;
		const metrics = createEmptyMetrics(engine);
		metrics.durationMs = durationMs;
		metrics.retries = retries;

		return {
			success: false,
			error: error.message,
			metrics,
		};
	}

	/**
	 * Register a before execute hook
	 */
	onBeforeExecute(hook: BeforeExecuteHook): void {
		if (!this.hooks.beforeExecute) {
			this.hooks.beforeExecute = [];
		}
		this.hooks.beforeExecute.push(hook);
	}

	/**
	 * Register an after execute hook
	 */
	onAfterExecute(hook: AfterExecuteHook): void {
		if (!this.hooks.afterExecute) {
			this.hooks.afterExecute = [];
		}
		this.hooks.afterExecute.push(hook);
	}

	/**
	 * Register an error hook
	 */
	onError(hook: OnErrorHook): void {
		if (!this.hooks.onError) {
			this.hooks.onError = [];
		}
		this.hooks.onError.push(hook);
	}

	/**
	 * Clear all hooks
	 */
	clearHooks(): void {
		this.hooks = {};
	}

	/**
	 * Run before hooks
	 */
	private async runBeforeHooks(request: AgentRequest<TInput>): Promise<AgentRequest<TInput>> {
		let currentRequest = request;
		if (this.hooks.beforeExecute) {
			for (const hook of this.hooks.beforeExecute) {
				currentRequest = (await hook(currentRequest)) as AgentRequest<TInput>;
			}
		}
		return currentRequest;
	}

	/**
	 * Run after hooks
	 */
	private async runAfterHooks(
		request: AgentRequest<TInput>,
		response: AgentResponse<TOutput>,
	): Promise<AgentResponse<TOutput>> {
		let currentResponse = response;
		if (this.hooks.afterExecute) {
			for (const hook of this.hooks.afterExecute) {
				currentResponse = (await hook(request, currentResponse)) as AgentResponse<TOutput>;
			}
		}
		return currentResponse;
	}

	/**
	 * Run error hooks
	 */
	private async runErrorHooks(request: AgentRequest<TInput>, error: Error): Promise<void> {
		if (this.hooks.onError) {
			for (const hook of this.hooks.onError) {
				await hook(request, error);
			}
		}
	}

	/**
	 * Delay utility for retries
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Execute multiple agents in parallel
 */
export async function executeAgentsInParallel<TInput, TOutput>(
	agents: IAgent<TInput, TOutput>[],
	requests: AgentRequest<TInput>[],
	config: ParallelExecutionConfig = DEFAULT_PARALLEL_CONFIG,
): Promise<ParallelExecutionResult<TOutput>> {
	if (agents.length !== requests.length) {
		throw new Error("Number of agents must match number of requests");
	}

	const results: Array<{
		request: AgentRequest<TInput>;
		response: AgentResponse<TOutput>;
	}> = [];

	const startTime = Date.now();

	switch (config.strategy) {
		case "all":
			// Execute all in parallel
			await executeAllParallel(agents, requests, results, config);
			break;
		case "wave":
			// Execute in waves (all at once, wait for all to complete)
			await executeAllParallel(agents, requests, results, config);
			break;
		case "limited":
			// Execute with concurrency limit
			await executeLimitedParallel(agents, requests, results, config);
			break;
	}

	return buildParallelResult(
		results,
		config.strategy === "limited" ? (config.maxConcurrent ?? 4) : agents.length,
	);
}

/**
 * Execute all agents in parallel
 */
async function executeAllParallel<TInput, TOutput>(
	agents: IAgent<TInput, TOutput>[],
	requests: AgentRequest<TInput>[],
	results: Array<{ request: AgentRequest<TInput>; response: AgentResponse<TOutput> }>,
	config: ParallelExecutionConfig,
): Promise<void> {
	const promises = agents.map(async (agent, index) => {
		const request = requests[index];
		try {
			const response = await agent.execute(request);
			return { request, response };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return {
				request,
				response: {
					success: false,
					error: err.message,
					metrics: createEmptyMetrics(request.engine ?? agent.config.defaultEngine),
				} as AgentResponse<TOutput>,
			};
		}
	});

	if (config.failFast) {
		// Use Promise.all which rejects on first error
		const executionResults = await Promise.all(promises);
		results.push(...executionResults);
	} else {
		// Use Promise.allSettled to collect all results
		const settledResults = await Promise.allSettled(promises);
		for (const result of settledResults) {
			if (result.status === "fulfilled") {
				results.push(result.value);
			}
		}
	}
}

/**
 * Execute agents with concurrency limit
 */
async function executeLimitedParallel<TInput, TOutput>(
	agents: IAgent<TInput, TOutput>[],
	requests: AgentRequest<TInput>[],
	results: Array<{ request: AgentRequest<TInput>; response: AgentResponse<TOutput> }>,
	config: ParallelExecutionConfig,
): Promise<void> {
	const maxConcurrent = config.maxConcurrent ?? DEFAULT_PARALLEL_CONFIG.maxConcurrent ?? 4;
	const queue = agents.map((agent, index) => ({ agent, request: requests[index], index }));

	const executeOne = async (item: {
		agent: IAgent<TInput, TOutput>;
		request: AgentRequest<TInput>;
		index: number;
	}) => {
		try {
			const response = await item.agent.execute(item.request);
			return { request: item.request, response, index: item.index };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return {
				request: item.request,
				response: {
					success: false,
					error: err.message,
					metrics: createEmptyMetrics(item.request.engine ?? item.agent.config.defaultEngine),
				} as AgentResponse<TOutput>,
				index: item.index,
			};
		}
	};

	// Process in batches
	const tempResults: Array<{
		request: AgentRequest<TInput>;
		response: AgentResponse<TOutput>;
		index: number;
	}> = [];
	for (let i = 0; i < queue.length; i += maxConcurrent) {
		const batch = queue.slice(i, i + maxConcurrent);

		if (config.failFast) {
			const batchResults = await Promise.all(batch.map(executeOne));
			tempResults.push(...batchResults);

			// Check for failures
			const hasFailure = batchResults.some((r) => !r.response.success);
			if (hasFailure) {
				break;
			}
		} else {
			const settledResults = await Promise.allSettled(batch.map(executeOne));
			for (const result of settledResults) {
				if (result.status === "fulfilled") {
					tempResults.push(result.value);
				}
			}
		}
	}

	// Sort by original index and add to results
	tempResults.sort((a, b) => a.index - b.index);
	results.push(...tempResults.map(({ request, response }) => ({ request, response })));
}

/**
 * Build parallel execution result
 */
function buildParallelResult<TInput, TOutput>(
	results: Array<{ request: AgentRequest<TInput>; response: AgentResponse<TOutput> }>,
	_maxConcurrent: number,
): ParallelExecutionResult<TOutput> {
	let successCount = 0;
	let failureCount = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalDurationMs = 0;
	let totalRetries = 0;
	let engine: AIEngineName = "claude";

	for (const { response } of results) {
		if (response.success) {
			successCount++;
		} else {
			failureCount++;
		}
		totalInputTokens += response.metrics.inputTokens;
		totalOutputTokens += response.metrics.outputTokens;
		totalDurationMs = Math.max(totalDurationMs, response.metrics.durationMs);
		totalRetries += response.metrics.retries;
		engine = response.metrics.engine;
	}

	return {
		results: results as Array<{ request: AgentRequest; response: AgentResponse<TOutput> }>,
		allSucceeded: failureCount === 0,
		successCount,
		failureCount,
		totalMetrics: {
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			totalTokens: totalInputTokens + totalOutputTokens,
			durationMs: totalDurationMs,
			retries: totalRetries,
			engine,
		},
	};
}

/**
 * Check if an agent supports parallel execution
 */
export function supportsParallel(role: AgentRole): boolean {
	return getAgentCapabilities(role).supportsParallel;
}

/**
 * Check if an agent is read-only
 */
export function isReadOnly(role: AgentRole): boolean {
	return getAgentCapabilities(role).isReadOnly;
}

/**
 * Get the category for an agent role
 */
export function getAgentCategory(role: AgentRole): string {
	return AGENT_CATEGORIES[role];
}

/**
 * Create an agent request helper
 */
export function createAgentRequest<TInput>(
	role: AgentRole,
	workDir: string,
	input: TInput,
	options?: {
		engine?: AIEngineName;
		engineOptions?: EngineOptions;
		metadata?: AgentRequest<TInput>["metadata"];
	},
): AgentRequest<TInput> {
	return {
		role,
		workDir,
		input,
		engine: options?.engine,
		engineOptions: options?.engineOptions,
		metadata: options?.metadata,
	};
}

/**
 * Merge agent metrics from multiple responses
 */
export function mergeAgentMetrics(metrics: AgentMetrics[]): AgentMetrics {
	if (metrics.length === 0) {
		return createEmptyMetrics();
	}

	return {
		inputTokens: metrics.reduce((sum, m) => sum + m.inputTokens, 0),
		outputTokens: metrics.reduce((sum, m) => sum + m.outputTokens, 0),
		totalTokens: metrics.reduce((sum, m) => sum + m.totalTokens, 0),
		durationMs: Math.max(...metrics.map((m) => m.durationMs)),
		costDollars: metrics.some((m) => m.costDollars !== undefined)
			? metrics.reduce((sum, m) => sum + (m.costDollars ?? 0), 0)
			: undefined,
		retries: metrics.reduce((sum, m) => sum + m.retries, 0),
		engine: metrics[metrics.length - 1].engine,
	};
}
