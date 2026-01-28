import { z } from "zod";

// ============================================================================
// Step Types
// ============================================================================

// Step type enum for execution steps
export const StepTypeSchema = z.enum(["thinking", "tool_use", "result", "error"]);

// Execution step schema
export const ExecutionStepSchema = z.object({
	type: StepTypeSchema,
	content: z.string(),
	timestamp: z.string().datetime(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Milhouse-Specific Enums and Types
// ============================================================================

/**
 * Agent roles in the Milhouse pipeline.
 * Each role represents a specific responsibility in the execution workflow.
 *
 * - lead-investigator: Analyzes the problem and gathers initial context
 * - planner: Creates execution plans and task breakdowns
 * - executor: Implements changes and executes tasks
 * - verifier: Validates changes and runs tests
 * - consolidator: Merges results and resolves conflicts
 * - validator: Final validation and quality checks
 */
export const AgentRoleSchema = z.enum([
	"lead-investigator",
	"planner",
	"executor",
	"verifier",
	"consolidator",
	"validator",
]);

/**
 * Pipeline phases in the Milhouse execution workflow.
 * These phases represent the stages of task execution.
 *
 * - scan: Initial scanning and analysis
 * - validate: Validation of inputs and prerequisites
 * - plan: Planning and task breakdown
 * - exec: Execution of planned tasks
 * - verify: Verification of results
 * - consolidate: Consolidation and merging of outputs
 */
export const PipelinePhaseSchema = z.enum([
	"scan",
	"validate",
	"plan",
	"exec",
	"verify",
	"consolidate",
]);

/**
 * Evidence format for probe/gate output collection.
 * Determines how evidence is formatted and stored.
 */
export const EvidenceFormatSchema = z.enum(["json", "markdown", "structured"]);

/**
 * Evidence requirements configuration for probe/gate evidence collection.
 * Controls what evidence is collected during execution.
 */
export const EvidenceRequirementsSchema = z.object({
	/** Whether to collect probe output as evidence */
	collectProbeOutput: z.boolean().default(false),
	/** List of required probe IDs that must produce evidence */
	requiredProbes: z.array(z.string()).optional(),
	/** Format for evidence output */
	evidenceFormat: EvidenceFormatSchema.default("json"),
});

/**
 * Failure action for gate checks.
 * Determines what happens when a gate check fails.
 *
 * - abort: Stop execution immediately
 * - warn: Log a warning but continue
 * - skip: Skip the gate check silently
 */
export const GateFailureActionSchema = z.enum(["abort", "warn", "skip"]);

/**
 * Gate configuration for quality gates in the pipeline.
 * Gates are checkpoints that validate execution quality.
 */
export const GateConfigSchema = z.object({
	/** Unique identifier for the gate */
	gateId: z.string(),
	/** Required confidence level (0.0 to 1.0) to pass the gate */
	requiredConfidence: z.number().min(0).max(1).default(0.8),
	/** Action to take when the gate check fails */
	failureAction: GateFailureActionSchema.default("abort"),
});

// ============================================================================
// Engine Execution Request
// ============================================================================

// Engine execution request
export const ExecutionRequestSchema = z.object({
	prompt: z.string().min(1, "Prompt cannot be empty"),
	workDir: z.string().min(1, "Working directory is required"),
	taskId: z.string().optional(),
	timeout: z.number().positive().default(4000000), // ~66 minutes default
	maxRetries: z.number().nonnegative().default(3),
	streamOutput: z.boolean().default(true),
	metadata: z.record(z.string(), z.unknown()).optional(),
	/** Override the default model for the engine */
	modelOverride: z.string().optional(),

	// ========================================================================
	// Milhouse-Specific Fields
	// ========================================================================

	/**
	 * Unique identifier for the execution run.
	 * Used for tracking, logging, and evidence collection across the pipeline.
	 * If not provided, one will be auto-generated.
	 */
	runId: z.string().optional(),

	/**
	 * Role of the agent executing this request.
	 * Determines behavior and context for the execution.
	 */
	agentRole: AgentRoleSchema.optional(),

	/**
	 * Current phase in the pipeline workflow.
	 * Used for phase-specific behavior and logging.
	 */
	pipelinePhase: PipelinePhaseSchema.optional(),

	/**
	 * Evidence collection requirements for this execution.
	 * Controls what evidence is gathered for probes and gates.
	 */
	evidenceRequirements: EvidenceRequirementsSchema.optional(),

	/**
	 * Gate configuration for quality validation.
	 * Defines the gate to check after execution completes.
	 */
	gateConfig: GateConfigSchema.optional(),

	// ========================================================================
	// Claude CLI specific options
	// ========================================================================

	/** JSON Schema for structured output validation (Claude --json-schema flag) */
	jsonSchema: z.record(z.string(), z.unknown()).optional(),
	/** Additional text to append to the system prompt (Claude --append-system-prompt flag) */
	systemPromptAppend: z.string().optional(),
	/** Include partial streaming events in output (Claude --include-partial-messages flag) */
	includePartialMessages: z.boolean().optional(),
	/** Tools that execute without prompting for permission (Claude --allowedTools flag) */
	allowedTools: z.array(z.string()).optional(),
	/** Tools that are removed from the model's context (Claude --disallowedTools flag) */
	disallowedTools: z.array(z.string()).optional(),
	/** Restrict which built-in tools Claude can use (Claude --tools flag) */
	tools: z.array(z.string()).optional(),
	/** MCP server configuration file path or JSON string (Claude --mcp-config flag) */
	mcpConfig: z.string().optional(),
	/** Define custom subagents dynamically via JSON (Claude --agents flag) */
	agents: z
		.record(
			z.string(),
			z.object({
				description: z.string(),
				prompt: z.string(),
				tools: z.array(z.string()).optional(),
				model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
			}),
		)
		.optional(),
	/** Add additional working directories for Claude to access (Claude --add-dir flag) */
	additionalDirs: z.array(z.string()).optional(),
	/** Session ID for conversation continuity (Claude --session-id flag) */
	sessionId: z.string().uuid().optional(),
	/** Continue most recent conversation (Claude --continue flag) */
	continueSession: z.boolean().optional(),
	/** Resume a specific session by ID or name (Claude --resume flag) */
	resumeSession: z.string().optional(),

	// ========================================================================
	// Cross-engine options
	// ========================================================================

	/** Output format: text, json, stream-json (Cursor --output-format flag) */
	outputFormat: z.enum(["text", "json", "stream-json"]).optional(),
	/** Auto-approve commands without prompting (Cursor -f/--force flag) */
	autoApprove: z.boolean().optional(),
	/** Agent mode: agent, plan, ask (Cursor --mode flag) */
	mode: z.string().optional(),
	/** API key for authentication (Cursor -a/--api-key flag) */
	apiKey: z.string().optional(),
	/** Start in background mode (Cursor -b/--background flag) */
	background: z.boolean().optional(),
	/** Enable fullscreen mode (Cursor --fullscreen flag) */
	fullscreen: z.boolean().optional(),
});

// Token usage schema
export const TokenUsageSchema = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
});

// Engine execution result
export const ExecutionResultSchema = z.object({
	success: z.boolean(),
	output: z.string(),
	steps: z.array(ExecutionStepSchema),
	duration: z.number().nonnegative(),
	exitCode: z.number().optional(),
	error: z.string().optional(),
	tokens: TokenUsageSchema.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

// Rate limit configuration
export const RateLimitConfigSchema = z.object({
	maxPerMinute: z.number().positive().default(60),
	maxPerHour: z.number().positive().default(1000),
	minTime: z.number().nonnegative().default(100),
});

// Engine configuration
export const EngineConfigSchema = z.object({
	name: z.string().min(1, "Engine name is required"),
	command: z.string().min(1, "Command is required"),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).optional(),
	timeout: z.number().positive().default(4000000), // ~66 minutes default
	maxConcurrent: z.number().positive().default(1),
	rateLimit: RateLimitConfigSchema.optional(),
});

// Middleware options schema
export const MiddlewareOptionsSchema = z.object({
	logging: z.boolean().default(true),
	timeout: z.number().positive().optional(),
	retry: z
		.object({
			maxRetries: z.number().nonnegative().default(3),
			baseDelay: z.number().positive().default(1000),
			maxDelay: z.number().positive().default(30000),
		})
		.optional(),
	concurrency: z.number().positive().default(2),
	rateLimit: RateLimitConfigSchema.optional(),
});

// Stream chunk schema
export const StreamChunkSchema = z.object({
	type: z.enum(["stdout", "stderr", "exit"]),
	data: z.union([z.string(), z.number()]),
	timestamp: z.date(),
});

// ============================================================================
// Export Types
// ============================================================================

// Core types
export type StepType = z.infer<typeof StepTypeSchema>;
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type ExecutionRequestInput = z.input<typeof ExecutionRequestSchema>;
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type MiddlewareOptions = z.infer<typeof MiddlewareOptionsSchema>;
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

// Milhouse-specific types
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type PipelinePhase = z.infer<typeof PipelinePhaseSchema>;
export type EvidenceFormat = z.infer<typeof EvidenceFormatSchema>;
export type EvidenceRequirements = z.infer<typeof EvidenceRequirementsSchema>;
export type EvidenceRequirementsInput = z.input<typeof EvidenceRequirementsSchema>;
export type GateFailureAction = z.infer<typeof GateFailureActionSchema>;
export type GateConfig = z.infer<typeof GateConfigSchema>;
export type GateConfigInput = z.input<typeof GateConfigSchema>;
