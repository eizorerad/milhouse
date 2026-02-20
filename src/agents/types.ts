import { z } from "zod";
import type { AIEngineName, AIResult, EngineOptions } from "../engines/types.ts";
import { AGENT_ROLES, type Evidence, type Issue, type Task } from "../state/types.ts";

/**
 * Agent role types - core pipeline agents and inspector agents
 */
export const AgentRoleSchema = z.enum([
	// Core pipeline agents
	"LI", // Lead Investigator
	"IV", // Issue Validator
	"PL", // Planner
	"PR", // Plan Reviewer
	"CDM", // Consistency & Dependency Manager
	"EX", // Executor
	"TV", // Truth Verifier Gate
	// Context/support agents
	"RL", // Repo Librarian
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Agent role descriptions - re-exported from state/types.ts (single source of truth)
 */
export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = AGENT_ROLES;

/**
 * Agent categories - groups of related agents
 */
export type AgentCategory = "pipeline" | "support";

/**
 * Map roles to categories
 */
export const AGENT_CATEGORIES: Record<AgentRole, AgentCategory> = {
	LI: "pipeline",
	IV: "pipeline",
	PL: "pipeline",
	PR: "pipeline",
	CDM: "pipeline",
	EX: "pipeline",
	TV: "pipeline",
	RL: "support",
};

/**
 * Agent execution configuration
 */
export interface AgentConfig {
	role: AgentRole;
	name: string;
	description: string;
	defaultEngine: AIEngineName;
	timeoutMs: number;
	maxRetries: number;
	retryDelayMs: number;
}

/** Create an agent config with shared defaults */
function cfg(
	role: AgentRole,
	name: string,
	overrides?: { maxRetries?: number; retryDelayMs?: number },
): AgentConfig {
	return {
		role,
		name,
		description: AGENT_ROLE_DESCRIPTIONS[role],
		defaultEngine: "claude",
		timeoutMs: 4_000_000,
		maxRetries: overrides?.maxRetries ?? 2,
		retryDelayMs: overrides?.retryDelayMs ?? 3000,
	};
}

/**
 * Default agent configurations
 */
export const DEFAULT_AGENT_CONFIGS: Record<AgentRole, AgentConfig> = {
	LI: cfg("LI", "Lead Investigator", { retryDelayMs: 5000 }),
	IV: cfg("IV", "Issue Validator"),
	PL: cfg("PL", "Planner", { retryDelayMs: 5000 }),
	PR: cfg("PR", "Plan Reviewer", { maxRetries: 1 }),
	CDM: cfg("CDM", "Consolidator", { retryDelayMs: 5000 }),
	EX: cfg("EX", "Executor", { maxRetries: 3, retryDelayMs: 10000 }),
	TV: cfg("TV", "Truth Verifier", { maxRetries: 1 }),
	RL: cfg("RL", "Repo Librarian", { retryDelayMs: 2000 }),
};

/**
 * Get agent configuration by role
 */
export function getAgentConfig(role: AgentRole): AgentConfig {
	return DEFAULT_AGENT_CONFIGS[role];
}

/**
 * Prompt section type - building blocks for agent prompts
 */
export type PromptSectionType =
	| "role"
	| "context"
	| "config"
	| "task"
	| "input"
	| "output"
	| "guidelines"
	| "examples";

/**
 * Prompt section - a single section of an agent prompt
 */
export interface PromptSection {
	/** Section type */
	type: PromptSectionType;
	/** Section header (optional, for markdown formatting) */
	header?: string;
	/** Section content */
	content: string;
	/** Order priority (lower = earlier in prompt) */
	priority: number;
}

/**
 * Prompt template - defines how to build a prompt for an agent
 */
export interface PromptTemplate {
	/** Agent role this template is for */
	role: AgentRole;
	/** Ordered sections that make up the prompt */
	sections: PromptSection[];
}

/**
 * Default section priorities
 */
export const SECTION_PRIORITIES: Record<PromptSectionType, number> = {
	role: 0,
	context: 10,
	config: 20,
	task: 30,
	input: 40,
	output: 50,
	guidelines: 60,
	examples: 70,
};

/**
 * Build a complete prompt from sections
 */
export function buildPromptFromSections(sections: PromptSection[]): string {
	// Sort sections by priority
	const sorted = [...sections].sort((a, b) => a.priority - b.priority);

	// Build prompt with headers
	const parts: string[] = [];
	for (const section of sorted) {
		if (section.header) {
			parts.push(`## ${section.header}\n\n${section.content}`);
		} else {
			parts.push(section.content);
		}
	}

	return parts.join("\n\n");
}

/**
 * Create a role section for an agent prompt
 */
export function createRoleSection(role: AgentRole, additionalContext?: string): PromptSection {
	const description = AGENT_ROLE_DESCRIPTIONS[role];
	const { name } = DEFAULT_AGENT_CONFIGS[role];

	return {
		type: "role",
		header: `Role: ${name} (${role})`,
		content: additionalContext ? `${description}\n\n${additionalContext}` : description,
		priority: SECTION_PRIORITIES.role,
	};
}

/**
 * Agent request - input to an agent execution
 */
export interface AgentRequest<TInput = unknown> {
	/** Agent role to execute */
	role: AgentRole;
	/** Working directory */
	workDir: string;
	/** Input data specific to the agent */
	input: TInput;
	/** Engine options override */
	engineOptions?: EngineOptions;
	/** AI engine to use (overrides default) */
	engine?: AIEngineName;
	/** Request metadata */
	metadata?: AgentRequestMetadata;
}

/**
 * Request metadata for tracking
 */
export interface AgentRequestMetadata {
	/** Parent request ID (for tracing) */
	parentRequestId?: string;
	/** Correlation ID (for grouping related requests) */
	correlationId?: string;
	/** Tags for categorization */
	tags?: string[];
	/** Source command that initiated the request */
	sourceCommand?: string;
}

/**
 * Agent response - output from an agent execution
 */
export interface AgentResponse<TOutput = unknown> {
	/** Whether the execution was successful */
	success: boolean;
	/** Output data specific to the agent */
	output?: TOutput;
	/** Error message if unsuccessful */
	error?: string;
	/** Execution metrics */
	metrics: AgentMetrics;
	/** Raw AI response */
	rawResponse?: string;
}

/**
 * Agent execution metrics
 */
export interface AgentMetrics {
	/** Input tokens used */
	inputTokens: number;
	/** Output tokens generated */
	outputTokens: number;
	/** Total tokens (input + output) */
	totalTokens: number;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Cost in dollars (if available) */
	costDollars?: number;
	/** Number of retries performed */
	retries: number;
	/** Engine used */
	engine: AIEngineName;
}

/**
 * Create empty metrics object
 */
export function createEmptyMetrics(engine: AIEngineName = "claude"): AgentMetrics {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		durationMs: 0,
		retries: 0,
		engine,
	};
}

/**
 * Create metrics from AI result
 */
export function createMetricsFromResult(
	result: AIResult,
	durationMs: number,
	engine: AIEngineName,
	retries = 0,
): AgentMetrics {
	return {
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		totalTokens: result.inputTokens + result.outputTokens,
		durationMs,
		costDollars: result.cost ? Number.parseFloat(result.cost) : undefined,
		retries,
		engine,
	};
}

/**
 * Agent-specific input types
 */

/** Input for Lead Investigator (LI) */
export interface LIInput {
	/** Scope of scan (optional) */
	scope?: string[];
	/** Additional context */
	context?: string;
}

/** Input for Issue Validator (IV) */
export interface IVInput {
	/** Issue to validate */
	issue: Issue;
	/** Additional evidence collected */
	evidence?: Evidence[];
}

/** Input for Planner (PL) */
export interface PLInput {
	/** Issue to plan for */
	issue: Issue;
	/** Related issues for context */
	relatedIssues?: Issue[];
}

/** Input for Plan Reviewer (PR) */
export interface PRInput {
	/** Issue being planned */
	issue: Issue;
	/** Generated tasks to review */
	tasks: Task[];
	/** WBS markdown content */
	wbsContent: string;
}

/** Input for Consolidator (CDM) */
export interface CDMInput {
	/** All tasks to consolidate */
	tasks: Task[];
	/** All issues for context */
	issues: Issue[];
}

/** Input for Executor (EX) */
export interface EXInput {
	/** Task to execute */
	task: Task;
	/** Related issue (optional) */
	issue?: Issue;
}

/** Input for Truth Verifier (TV) */
export interface TVInput {
	/** Completed tasks to verify */
	completedTasks: Task[];
	/** Failed tasks */
	failedTasks: Task[];
	/** Pre-check gate issues */
	preCheckIssues: Array<{
		gate: string;
		message: string;
		severity: "error" | "warning";
	}>;
}

/**
 * Agent-specific output types
 */

/** Output from Lead Investigator (LI) */
export interface LIOutput {
	/** Identified work items */
	issues: Array<{
		/** Work item type */
		type?: "bug" | "feature" | "refactor" | "improvement" | "task";
		/** Universal title (preferred) */
		title?: string;
		/** Universal rationale (preferred) */
		rationale?: string;
		/** @deprecated Use title. Observable symptom (for bugs) */
		symptom: string;
		/** @deprecated Use rationale. Root cause hypothesis (for bugs) */
		hypothesis: string;
		severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
		frequency?: string;
		blast_radius?: string;
		/** Scope of impact (universal) */
		scope_impact?: string;
		strategy?: string;
	}>;
}

/** Output from Issue Validator (IV) */
export interface IVOutput {
	/** Validation result */
	status: "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED";
	/** Evidence supporting the validation */
	evidence: Evidence[];
	/** Corrected description if misdiagnosed */
	correctedDescription?: string;
	/** Additional notes */
	notes?: string;
}

/** Output from Planner (PL) */
export interface PLOutput {
	/** Issue ID being planned */
	issueId: string;
	/** Summary of the plan */
	summary: string;
	/** Generated tasks */
	tasks: Array<{
		title: string;
		description?: string;
		files: string[];
		depends_on: string[];
		checks: string[];
		acceptance: Array<{
			description: string;
			check_command?: string;
		}>;
		risk?: string;
		rollback?: string;
	}>;
}

/** Output from Plan Reviewer (PR) */
export interface PROutput {
	/** Whether the plan is approved */
	approved: boolean;
	/** Issues found in the plan */
	issues: Array<{
		taskTitle: string;
		concern: string;
		severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
		suggestion: string;
	}>;
	/** Overall feedback */
	feedback?: string;
}

/** Output from Consolidator (CDM) */
export interface CDMOutput {
	/** Duplicate task IDs to remove */
	duplicates: Array<{
		keepId: string;
		removeIds: string[];
		reason: string;
	}>;
	/** Cross-issue dependencies to add */
	crossDependencies: Array<{
		taskId: string;
		dependsOn: string;
		reason: string;
	}>;
	/** Suggested parallel groups */
	parallelGroups: Array<{
		group: number;
		taskIds: string[];
	}>;
	/** Recommended execution order */
	executionOrder: string[];
}

/** Output from Executor (EX) */
export interface EXOutput {
	/** Whether execution was successful */
	success: boolean;
	/** Files modified */
	filesModified: string[];
	/** Summary of changes */
	summary: string;
	/** Error if failed */
	error?: string;
}

/** Output from Truth Verifier (TV) */
export interface TVOutput {
	/** Overall verification result */
	overallPass: boolean;
	/** Individual gate results */
	gates: Array<{
		name: string;
		passed: boolean;
		message?: string;
		evidence?: Evidence[];
	}>;
	/** Recommendations for improvement */
	recommendations: string[];
}

/**
 * Agent lifecycle hooks
 */

/** Hook called before agent execution */
export type BeforeExecuteHook = (request: AgentRequest) => Promise<AgentRequest>;

/** Hook called after agent execution */
export type AfterExecuteHook = (
	request: AgentRequest,
	response: AgentResponse,
) => Promise<AgentResponse>;

/** Hook called on error */
export type OnErrorHook = (request: AgentRequest, error: Error) => Promise<void>;

/** Agent lifecycle hooks configuration */
export interface AgentHooks {
	/** Called before execution */
	beforeExecute?: BeforeExecuteHook[];
	/** Called after execution */
	afterExecute?: AfterExecuteHook[];
	/** Called on error */
	onError?: OnErrorHook[];
}

/**
 * Helper functions
 */

/**
 * Check if a role is a pipeline agent
 */
export function isPipelineAgent(role: AgentRole): boolean {
	return AGENT_CATEGORIES[role] === "pipeline";
}

/**
 * Check if a role is read-only (non-pipeline agents are read-only, EX is the only pipeline writer)
 */
export function isReadOnlyAgent(role: AgentRole): boolean {
	const category = AGENT_CATEGORIES[role];
	if (category !== "pipeline") return true;
	return role !== "EX";
}

/**
 * Get all roles in a category
 */
export function getRolesByCategory(category: AgentCategory): AgentRole[] {
	return (Object.keys(AGENT_CATEGORIES) as AgentRole[]).filter(
		(role) => AGENT_CATEGORIES[role] === category,
	);
}

/**
 * Get pipeline phase order
 */
export const PIPELINE_PHASE_ORDER: AgentRole[] = ["LI", "IV", "PL", "PR", "CDM", "EX", "TV"];

/**
 * Check if role A should execute before role B in the pipeline
 */
export function shouldExecuteBefore(roleA: AgentRole, roleB: AgentRole): boolean {
	const indexA = PIPELINE_PHASE_ORDER.indexOf(roleA);
	const indexB = PIPELINE_PHASE_ORDER.indexOf(roleB);

	// If either is not in pipeline, no ordering
	if (indexA === -1 || indexB === -1) {
		return false;
	}

	return indexA < indexB;
}
