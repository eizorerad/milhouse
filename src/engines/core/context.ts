/**
 * Milhouse Execution Context
 *
 * This module provides Milhouse-specific execution context that extends the base
 * execution context with pipeline-aware features like run tracking, agent roles,
 * and evidence collection.
 *
 * @example
 * ```typescript
 * import { createMilhouseContext } from './context';
 *
 * const context = createMilhouseContext(request, plugin);
 * console.log(context.runId); // Auto-generated or from request
 * console.log(context.agentRole); // 'executor', 'verifier', etc.
 * ```
 */

import type {
	AgentRole,
	EvidenceRequirements,
	ExecutionRequest,
	GateConfig,
	PipelinePhase,
} from "../../schemas/engine.schema";
import type { IEnginePlugin } from "./types";

/**
 * Generate a unique run ID using timestamp and random suffix.
 * Format: run-YYYYMMDD-HHMMSS-XXXX where XXXX is a random hex string.
 *
 * @returns A unique run identifier
 */
export function generateRunId(): string {
	const now = new Date();
	const timestamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const randomSuffix = Math.random().toString(16).slice(2, 6);
	return `run-${timestamp}-${randomSuffix}`;
}

/**
 * Milhouse-specific execution context.
 *
 * This interface extends the base execution context with Milhouse pipeline features:
 * - Run tracking via runId
 * - Agent role identification
 * - Pipeline phase tracking
 * - Evidence collection for probes and gates
 * - Gate configuration for quality validation
 */
export interface MilhouseExecutionContext {
	/**
	 * Unique identifier for this execution run.
	 * Used for tracking, logging, and correlating events across the pipeline.
	 */
	readonly runId: string;

	/**
	 * The execution request that initiated this context.
	 */
	readonly request: ExecutionRequest;

	/**
	 * The engine plugin being used for execution.
	 */
	readonly plugin: IEnginePlugin;

	/**
	 * Role of the agent executing this request.
	 * Undefined if not specified in the request.
	 */
	readonly agentRole: AgentRole | undefined;

	/**
	 * Current phase in the pipeline workflow.
	 * Undefined if not specified in the request.
	 */
	readonly pipelinePhase: PipelinePhase | undefined;

	/**
	 * Evidence collection requirements for this execution.
	 * Undefined if not specified in the request.
	 */
	readonly evidenceRequirements: EvidenceRequirements | undefined;

	/**
	 * Gate configuration for quality validation.
	 * Undefined if not specified in the request.
	 */
	readonly gateConfig: GateConfig | undefined;

	/**
	 * Map for collecting evidence during execution.
	 * Keys are evidence identifiers, values are the collected evidence data.
	 */
	readonly evidence: Map<string, unknown>;

	/**
	 * Timestamp when the context was created.
	 */
	readonly startTime: number;

	/**
	 * Execution attempt number (starts at 1, increments on retry).
	 */
	attempt: number;

	/**
	 * Additional metadata that can be attached during execution.
	 */
	readonly metadata: Record<string, unknown>;
}

/**
 * Options for creating a Milhouse execution context.
 */
export interface CreateContextOptions {
	/**
	 * Override the auto-generated run ID.
	 */
	runId?: string;

	/**
	 * Initial attempt number (default: 1).
	 */
	attempt?: number;

	/**
	 * Initial metadata to attach to the context.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Create a Milhouse execution context from a request and plugin.
 *
 * This factory function creates a fully initialized context with:
 * - Auto-generated runId if not provided
 * - Extracted Milhouse-specific fields from the request
 * - Initialized evidence collection map
 *
 * @param request - The execution request
 * @param plugin - The engine plugin to use
 * @param options - Optional configuration overrides
 * @returns A fully initialized MilhouseExecutionContext
 *
 * @example
 * ```typescript
 * const context = createMilhouseContext(request, plugin);
 *
 * // Access context fields
 * console.log(`Run ID: ${context.runId}`);
 * console.log(`Agent: ${context.agentRole}`);
 * console.log(`Phase: ${context.pipelinePhase}`);
 *
 * // Collect evidence
 * context.evidence.set('probe-output', { status: 'passed' });
 * ```
 */
export function createMilhouseContext(
	request: ExecutionRequest,
	plugin: IEnginePlugin,
	options: CreateContextOptions = {},
): MilhouseExecutionContext {
	// Generate or use provided runId
	const runId = options.runId ?? request.runId ?? generateRunId();

	// Extract Milhouse-specific fields from request
	const agentRole = request.agentRole;
	const pipelinePhase = request.pipelinePhase;
	const evidenceRequirements = request.evidenceRequirements;
	const gateConfig = request.gateConfig;

	// Initialize evidence collection map
	const evidence = new Map<string, unknown>();

	// Build initial metadata
	const metadata: Record<string, unknown> = {
		...options.metadata,
		engineName: plugin.name,
		taskId: request.taskId,
	};

	return {
		runId,
		request,
		plugin,
		agentRole,
		pipelinePhase,
		evidenceRequirements,
		gateConfig,
		evidence,
		startTime: Date.now(),
		attempt: options.attempt ?? 1,
		metadata,
	};
}

/**
 * Create a copy of a context with updated fields.
 * Useful for retry scenarios where attempt number needs to increment.
 *
 * @param context - The original context
 * @param updates - Fields to update
 * @returns A new context with updated fields
 */
export function updateContext(
	context: MilhouseExecutionContext,
	updates: Partial<Pick<MilhouseExecutionContext, "attempt" | "metadata">>,
): MilhouseExecutionContext {
	return {
		...context,
		attempt: updates.attempt ?? context.attempt,
		metadata: {
			...context.metadata,
			...updates.metadata,
		},
	};
}

/**
 * Extract context metadata for inclusion in execution results.
 * This creates a serializable object suitable for logging or storage.
 *
 * @param context - The execution context
 * @returns A plain object with context metadata
 */
export function extractContextMetadata(context: MilhouseExecutionContext): Record<string, unknown> {
	return {
		runId: context.runId,
		agentRole: context.agentRole,
		pipelinePhase: context.pipelinePhase,
		attempt: context.attempt,
		engineName: context.plugin.name,
		taskId: context.request.taskId,
		hasEvidenceRequirements: context.evidenceRequirements !== undefined,
		hasGateConfig: context.gateConfig !== undefined,
		evidenceCount: context.evidence.size,
		...context.metadata,
	};
}

/**
 * Check if evidence collection is enabled for this context.
 *
 * @param context - The execution context
 * @returns True if evidence should be collected
 */
export function shouldCollectEvidence(context: MilhouseExecutionContext): boolean {
	return context.evidenceRequirements?.collectProbeOutput === true;
}

/**
 * Get the evidence format for this context.
 *
 * @param context - The execution context
 * @returns The evidence format, defaults to 'json'
 */
export function getEvidenceFormat(
	context: MilhouseExecutionContext,
): "json" | "markdown" | "structured" {
	return context.evidenceRequirements?.evidenceFormat ?? "json";
}

/**
 * Add evidence to the context's evidence map.
 *
 * @param context - The execution context
 * @param key - Evidence identifier
 * @param value - Evidence data
 */
export function addEvidence(context: MilhouseExecutionContext, key: string, value: unknown): void {
	context.evidence.set(key, value);
}

/**
 * Get all collected evidence as a plain object.
 *
 * @param context - The execution context
 * @returns Object with all collected evidence
 */
export function getCollectedEvidence(context: MilhouseExecutionContext): Record<string, unknown> {
	const evidence: Record<string, unknown> = {};
	for (const [key, value] of context.evidence) {
		evidence[key] = value;
	}
	return evidence;
}
