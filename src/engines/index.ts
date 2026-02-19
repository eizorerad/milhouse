/**
 * Milhouse Engine Module
 *
 * This module provides a plugin-based architecture for executing AI coding assistants.
 * It includes middleware support for logging, timeout, retry, concurrency, and rate limiting.
 *
 * Enhanced with Milhouse-specific features:
 * - Pipeline-aware execution context (runId, agentRole, pipelinePhase)
 * - Evidence collection for probes and gates
 * - Gate configuration for quality validation
 *
 * @example
 * ```typescript
 * import { createDefaultExecutor, getPlugin } from './engines';
 *
 * const executor = createDefaultExecutor();
 * const plugin = getPlugin('claude');
 *
 * // Basic execution
 * const result = await executor.execute(plugin, {
 *   prompt: 'Fix the bug in main.ts',
 *   workDir: '/path/to/project',
 * });
 *
 * // Pipeline-aware execution with context
 * const pipelineResult = await executor.execute(plugin, {
 *   prompt: 'Fix the bug in main.ts',
 *   workDir: '/path/to/project',
 *   runId: 'run-20260125-abc123',
 *   agentRole: 'executor',
 *   pipelinePhase: 'exec',
 *   evidenceRequirements: {
 *     collectProbeOutput: true,
 *     evidenceFormat: 'json',
 *   },
 * });
 * ```
 */

// ============================================================================
// Core Types
// ============================================================================

export type {
	IEnginePlugin,
	IEngineExecutor,
	MiddlewareFn,
	MiddlewareContext,
	StreamHandler,
	SpawnOptions,
	AvailabilityResult,
	ExecutionContext,
	StepCallback,
	// Milhouse-specific types re-exported from core/types
	AgentRole,
	PipelinePhase,
	EvidenceRequirements,
	GateConfig,
} from "./core/types";

export type {
	ExecutionRequest,
	ExecutionRequestInput,
	ExecutionResult,
	ExecutionStep,
	EngineConfig,
	StreamChunk,
	StepType,
	RateLimitConfig,
	MiddlewareOptions,
	// Milhouse-specific types from schema
	EvidenceFormat,
	EvidenceRequirementsInput,
	GateFailureAction,
	GateConfigInput,
} from "../schemas/engine.schema";

// ============================================================================
// Milhouse Execution Context
// ============================================================================

export {
	createMilhouseContext,
	generateRunId,
	updateContext,
	extractContextMetadata,
	shouldCollectEvidence,
	getEvidenceFormat,
	addEvidence,
	getCollectedEvidence,
} from "./core/context";

export type {
	MilhouseExecutionContext,
	CreateContextOptions,
} from "./core/context";

// ============================================================================
// Core Executor
// ============================================================================

export {
	EngineExecutor,
	createDefaultExecutor,
	createMinimalExecutor,
	createConfiguredExecutor,
	executeOnce,
	executeWithFallback,
} from "./core/executor";

export type { ExecutorConfig } from "./core/executor";

// ============================================================================
// Streaming
// ============================================================================

export {
	StreamCollector,
	StreamMultiplexer,
	StreamPipeline,
	RealtimeStreamProcessor,
	createFilterTransformer,
	createMapTransformer,
	createLoggingStreamHandler,
	createEventEmittingStreamHandler,
	streamToAsyncIterator,
	collectStream,
} from "./core/streaming";

export type { StreamTransformer } from "./core/streaming";

// ============================================================================
// Parsers
// ============================================================================

export {
	parseStreamJson,
	extractToolCalls,
	extractThinking,
	extractFinalResult,
	isStreamJsonFormat,
	StreamJsonParser,
} from "./core/parsers/stream-json";

export {
	parseTextOutput,
	parseTextWithPatterns,
	parseAnsiOutput,
	parseMarkdownOutput,
	parseAutoDetect,
} from "./core/parsers/text";

// ============================================================================
// Middleware
// ============================================================================

export {
	composeMiddleware,
	MiddlewareChain,
	createPassthroughMiddleware,
	createConditionalMiddleware,
} from "./middleware/chain";

export {
	createConcurrencyMiddleware,
	getGlobalConcurrencyLimiter,
	resetGlobalConcurrencyLimiter,
	createGlobalConcurrencyMiddleware,
	getEngineConcurrencyLimiter,
	clearEngineConcurrencyLimiters,
	getConcurrencyStats,
} from "./middleware/concurrency";

export type { ConcurrencyStats } from "./middleware/concurrency";

export {
	createRateLimitMiddleware,
	getEngineRateLimiter,
	clearEngineRateLimiters,
	getEngineRateLimitStats,
	RateLimiterGroup,
} from "./middleware/rate-limit";

export type { RateLimitOptions, RateLimitStats } from "./middleware/rate-limit";

export {
	createLoggingMiddleware,
	createVerboseLoggingMiddleware,
	MetricsLogger,
} from "./middleware/logging";

export type { LoggingOptions } from "./middleware/logging";

export {
	createRetryMiddleware,
	createCustomRetryMiddleware,
	CircuitBreaker,
} from "./middleware/retry";

export type { RetryOptions } from "./middleware/retry";

export {
	createTimeoutMiddleware,
	createDeadlineMiddleware,
	createProgressiveTimeoutMiddleware,
	isTimeoutError,
	createTimeoutWithCleanup,
	TimeoutError,
} from "./middleware/timeout";

export type { TimeoutOptions, ProgressiveTimeoutOptions } from "./middleware/timeout";

// ============================================================================
// Plugins
// ============================================================================

export {
	getPlugin,
	listPlugins,
	registerPlugin,
	unregisterPlugin,
	hasPlugin,
	getAvailablePlugins,
	getFirstAvailablePlugin,
	getRegistry,
} from "./plugins/types";

export type { PluginFactory } from "./plugins/types";

// Plugin classes
export {
	ClaudePlugin,
	createClaudePlugin,
	createJsonSchema,
	createSubagents,
	CLAUDE_TOOLS,
} from "./plugins/claude";
export type { ClaudePluginOptions, ClaudeSubagent } from "./plugins/claude";

export { OpencodePlugin, createOpencodePlugin } from "./plugins/opencode";
export type { OpencodePluginOptions } from "./plugins/opencode";

export { CursorPlugin, createCursorPlugin } from "./plugins/cursor";
export type { CursorPluginOptions } from "./plugins/cursor";

export { CodexPlugin, createCodexPlugin, CODEX_SANDBOX } from "./plugins/codex";
export type { CodexPluginOptions, CodexSandboxPolicy } from "./plugins/codex";

export { QwenPlugin, createQwenPlugin } from "./plugins/qwen";
export type { QwenPluginOptions } from "./plugins/qwen";

export { DroidPlugin, createDroidPlugin } from "./plugins/droid";
export type { DroidPluginOptions } from "./plugins/droid";

// ============================================================================
// Legacy API Compatibility
// ============================================================================

/**
 * Create an engine instance by name.
 * This function returns an AIEngine adapter that wraps the plugin system,
 * providing backward compatibility with the legacy AIEngine interface.
 *
 * @param engineName - Name of the engine to create
 * @returns AIEngine adapter instance
 */
export async function createEngine(engineName: string): Promise<AIEngine> {
	const { createEngineAdapter } = await import("./adapter");
	return createEngineAdapter(engineName);
}

// Import types for legacy compatibility
import type { ExecutionResult } from "../schemas/engine.schema";

// Import AIEngine type for createEngine return type
import type { AIEngine } from "./types";

// Export adapter utilities
export {
	PluginAdapter,
	createEngineAdapter,
	createAdapterFromPlugin,
	translateStepToDetailedStep,
	translateResultToAIResult,
} from "./adapter";

// ============================================================================
// UI Step Rendering
// ============================================================================

/**
 * Re-export UI-facing types and utilities from base.ts for stability.
 *
 * The UI layer (ui/spinners.ts) depends on DetailedStep and formatStepForDisplay.
 * These are re-exported here so consumers can import from a single location.
 *
 * Decision: DetailedStep remains the UI contract. The adapter's translateStepToDetailedStep()
 * converts ExecutionStep (plugin system) to DetailedStep (UI) when needed.
 */
export type { DetailedStep } from "./base";
export { formatStepForDisplay } from "./base";
