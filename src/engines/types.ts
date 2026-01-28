import type { AgentRole, PipelinePhase } from "../schemas/engine.schema";

/**
 * Result from AI engine execution
 */
export interface AIResult {
	success: boolean;
	response: string;
	inputTokens: number;
	outputTokens: number;
	/** Actual cost in dollars (if provided by engine) or duration in ms */
	cost?: string;
	error?: string;
	/** Unique run identifier (Milhouse-specific) */
	runId?: string;
	/** Agent role that executed this request (Milhouse-specific) */
	agentRole?: AgentRole;
	/** Pipeline phase during execution (Milhouse-specific) */
	pipelinePhase?: PipelinePhase;
	/** Collected evidence from execution (Milhouse-specific) */
	evidence?: Record<string, unknown>;
}

/**
 * Options passed to engine execute methods.
 *
 * Enhanced with Milhouse-specific fields for pipeline-aware execution:
 * - runId: Track execution across the pipeline
 * - agentRole: Identify the agent performing the execution
 * - pipelinePhase: Track which phase of the pipeline is executing
 */
export interface EngineOptions {
	/** Override the default model */
	modelOverride?: string;

	// ========================================================================
	// Milhouse-Specific Options
	// ========================================================================

	/**
	 * Unique identifier for the execution run.
	 * Used for tracking, logging, and evidence collection across the pipeline.
	 */
	runId?: string;

	/**
	 * Role of the agent executing this request.
	 * Determines behavior and context for the execution.
	 */
	agentRole?: AgentRole;

	/**
	 * Current phase in the pipeline workflow.
	 * Used for phase-specific behavior and logging.
	 */
	pipelinePhase?: PipelinePhase;
}

/**
 * Progress callback type for streaming execution
 * Accepts either a string (legacy) or DetailedStep (new detailed format)
 */
export type ProgressCallback = (step: string | import("./base.ts").DetailedStep) => void;

/**
 * AI Engine interface - one per AI tool
 */
export interface AIEngine {
	/** Display name of the engine */
	name: string;
	/** CLI command to invoke */
	cliCommand: string;
	/** Check if the engine CLI is available */
	isAvailable(): Promise<boolean>;
	/** Execute a prompt and return the result */
	execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult>;
	/** Execute with streaming progress updates (optional) */
	executeStreaming?(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult>;
}

/**
 * Supported AI engine names
 */
export type AIEngineName =
	| "aider"
	| "claude"
	| "gemini"
	| "opencode"
	| "cursor"
	| "codex"
	| "qwen"
	| "droid";
