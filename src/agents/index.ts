/**
 * Agent System - Central export module
 *
 * Provides:
 * - Type definitions and schemas for agent roles and configurations
 * - Base agent class with common functionality
 * - Specialized agent implementations for each pipeline stage
 * - Agent registry and factory for creating agents by role
 * - Parallel execution utilities
 *
 * Pipeline Agents:
 * - LI (Lead Investigator): Initial scan and problem identification
 * - IV (Issue Validator): Per-issue validation with evidence
 * - PL (Planner): WBS generation for validated issues
 * - PR (Plan Reviewer): WBS review and refinement
 * - CDM (Consolidator): Deduplication and unified planning
 * - EX (Executor): Task execution with minimal changes
 * - TV (Truth Verifier): Evidence validation gate
 */

// ============================================================================
// Type definitions and schemas
// ============================================================================
export {
	// Agent role schema and type
	AgentRoleSchema,
	type AgentRole,
	// Role descriptions and categories
	AGENT_ROLE_DESCRIPTIONS,
	AGENT_CATEGORIES,
	type AgentCategory,
	// Capabilities
	type AgentCapabilities,
	CATEGORY_CAPABILITIES,
	AGENT_CAPABILITY_OVERRIDES,
	getAgentCapabilities,
	// Configuration
	type AgentConfig,
	DEFAULT_AGENT_CONFIGS,
	getAgentConfig,
	// Prompt building
	type PromptSectionType,
	type PromptSection,
	type PromptTemplate,
	SECTION_PRIORITIES,
	buildPromptFromSections,
	createRoleSection,
	// Request/Response types
	type AgentRequest,
	type AgentRequestMetadata,
	type AgentResponse,
	type AgentMetrics,
	createEmptyMetrics,
	createMetricsFromResult,
	// Agent-specific input types
	type LIInput,
	type IVInput,
	type PLInput,
	type PRInput,
	type CDMInput,
	type EXInput,
	type TVInput,
	// Agent-specific output types
	type LIOutput,
	type IVOutput,
	type PLOutput,
	type PROutput,
	type CDMOutput,
	type EXOutput,
	type TVOutput,
	// Parallel execution types
	type ParallelStrategy,
	type ParallelExecutionConfig,
	DEFAULT_PARALLEL_CONFIG,
	type ParallelExecutionResult,
	// Lifecycle hooks
	type BeforeExecuteHook,
	type AfterExecuteHook,
	type OnErrorHook,
	type AgentHooks,
	// Helper functions
	isPipelineAgent,
	isInspectorAgent,
	isReadOnlyAgent,
	getRolesByCategory,
	PIPELINE_PHASE_ORDER,
	shouldExecuteBefore,
} from "./types.ts";

// ============================================================================
// Base agent class and utilities
// ============================================================================
export {
	// Error classes
	AgentExecutionError,
	AgentNotAvailableError,
	AgentTimeoutError,
	// Base agent interface and class
	type IAgent,
	BaseAgent,
	// Parallel execution
	executeAgentsInParallel,
	// Utility functions
	supportsParallel,
	isReadOnly,
	getAgentCategory,
	createAgentRequest,
	mergeAgentMetrics,
} from "./base.ts";

// ============================================================================
// Lead Investigator (LI) Agent
// ============================================================================
export {
	LeadInvestigatorAgent,
	parseIssuesFromResponse,
	isValidSeverity as isValidLISeverity,
	createLeadInvestigatorAgent,
	buildLeadInvestigatorPrompt,
	convertToIssueData,
} from "./lead-investigator.ts";

// ============================================================================
// Issue Validator (IV) Agent
// ============================================================================
export {
	IssueValidatorAgent,
	parseValidationFromResponse,
	isValidIssueStatus,
	isValidValidationStatus,
	createIssueValidatorAgent,
	buildIssueValidatorPrompt,
	convertToIssueUpdate,
	isIssueConfirmed,
	isIssueRefuted,
	isIssueMisdiagnosed,
	getValidationSeverity,
} from "./issue-validator.ts";

// ============================================================================
// Planner (PL) Agent
// ============================================================================
export {
	PlannerAgent,
	parseWBSFromResponse,
	createPlannerAgent,
	buildPlannerPrompt,
	convertToTaskData,
	hasTasksPlanned,
	getTaskCount,
	getTasksWithDependencies,
	getRootTasks,
	validateTaskDependencies,
	hasCircularDependencies,
	getPlanComplexity,
} from "./planner.ts";

// ============================================================================
// Plan Reviewer (PR) Agent
// ============================================================================
export {
	type ReviewSeverity,
	PlanReviewerAgent,
	parseReviewFromResponse,
	isValidSeverity as isValidPRSeverity,
	createPlanReviewerAgent,
	buildPlanReviewerPrompt,
	hasBlockingIssues,
	getIssuesBySeverity,
	getCriticalIssues,
	getHighIssues,
	countIssuesBySeverity,
	getTotalIssueCount,
	isPlanApproved,
	getIssuesForTask,
	getGeneralIssues,
	formatReviewAsMarkdown,
} from "./plan-reviewer.ts";

// ============================================================================
// Consolidator (CDM) Agent
// ============================================================================
export {
	ConsolidatorAgent,
	parseConsolidationFromResponse,
	createConsolidatorAgent,
	buildConsolidatorPrompt,
	hasDuplicates,
	getDuplicateRemoveCount,
	hasCrossDependencies,
	getCrossDependencyCount,
	getParallelGroupCount,
	getTasksInGroup,
	getParallelGroupNumbers,
	isExecutionOrderValid,
	getKeptTaskIds,
	getRemovedTaskIds,
	isTaskMarkedForRemoval,
	getKeepIdForRemovedTask,
	getCrossDependenciesForTask,
	getTasksDependingOn,
	applyConsolidationToTasks,
	formatConsolidationAsMarkdown,
} from "./consolidator.ts";

// ============================================================================
// Executor (EX) Agent
// ============================================================================
export {
	ExecutorAgent,
	parseExecutionFromResponse,
	createExecutorAgent,
	buildExecutorPrompt,
	isExecutionSuccessful,
	hasModifiedFiles,
	getModifiedFileCount,
	wasFileModified,
	getModifiedFilesMatching,
	getModifiedFilesByExtension,
	hasExecutionError,
	getExecutionError,
	convertToTaskUpdate,
	createExecutionRecordData,
	validateTaskForExecution,
	areAcceptanceCriteriaSatisfiable,
	getCriteriaWithCheckCommands,
	getCriteriaWithoutCheckCommands,
	formatExecutionAsMarkdown,
} from "./executor.ts";

// ============================================================================
// Truth Verifier (TV) Agent
// ============================================================================
export {
	type GateName,
	GATE_DESCRIPTIONS,
	VerifierAgent,
	parseVerificationFromResponse,
	createVerifierAgent,
	buildVerifierPrompt,
	isVerificationPassed,
	hasFailedGates,
	getFailedGates,
	getPassedGates,
	getGateCount,
	getPassedGateCount,
	getFailedGateCount,
	getGateByName,
	isGatePassed,
	hasRecommendations,
	getRecommendationCount,
	formatVerificationAsMarkdown,
	createVerificationSummary,
	isEvidenceGatePassed,
	isPlaceholderGatePassed,
	isDiffHygieneGatePassed,
	isDoDGatePassed,
	isEnvConsistencyGatePassed,
	getAllGateEvidence,
	getGateEvidence,
} from "./verifier.ts";

// ============================================================================
// Agent Registry and Factory
// ============================================================================

import type { IAgent } from "./base.ts";
import { ConsolidatorAgent } from "./consolidator.ts";
import { ExecutorAgent } from "./executor.ts";
import { IssueValidatorAgent } from "./issue-validator.ts";
import { LeadInvestigatorAgent } from "./lead-investigator.ts";
import { PlanReviewerAgent } from "./plan-reviewer.ts";
import { PlannerAgent } from "./planner.ts";
import type { AgentConfig, AgentRole } from "./types.ts";
import { VerifierAgent } from "./verifier.ts";

/**
 * Type for pipeline agent roles only
 */
export type PipelineAgentRole = "LI" | "IV" | "PL" | "PR" | "CDM" | "EX" | "TV";

/**
 * Check if a role is a pipeline agent role
 */
export function isPipelineAgentRole(role: AgentRole): role is PipelineAgentRole {
	return ["LI", "IV", "PL", "PR", "CDM", "EX", "TV"].includes(role);
}

/**
 * Agent class constructors for pipeline agents
 */
export const AGENT_CLASSES: Record<
	PipelineAgentRole,
	new (
		configOverrides?: Partial<AgentConfig>,
	) => IAgent<unknown, unknown>
> = {
	LI: LeadInvestigatorAgent,
	IV: IssueValidatorAgent,
	PL: PlannerAgent,
	PR: PlanReviewerAgent,
	CDM: ConsolidatorAgent,
	EX: ExecutorAgent,
	TV: VerifierAgent,
};

/**
 * Create an agent instance by role
 *
 * @param role - The agent role to create
 * @param configOverrides - Optional configuration overrides
 * @returns The created agent instance
 * @throws Error if the role is not a pipeline agent
 */
export function createAgent(
	role: PipelineAgentRole,
	configOverrides?: Partial<AgentConfig>,
): IAgent<unknown, unknown> {
	const AgentClass = AGENT_CLASSES[role];
	if (!AgentClass) {
		throw new Error(`Unknown pipeline agent role: ${role}`);
	}
	return new AgentClass(configOverrides);
}

/**
 * Create a typed Lead Investigator agent
 */
export function createLI(configOverrides?: Partial<AgentConfig>): LeadInvestigatorAgent {
	return new LeadInvestigatorAgent(configOverrides);
}

/**
 * Create a typed Issue Validator agent
 */
export function createIV(configOverrides?: Partial<AgentConfig>): IssueValidatorAgent {
	return new IssueValidatorAgent(configOverrides);
}

/**
 * Create a typed Planner agent
 */
export function createPL(configOverrides?: Partial<AgentConfig>): PlannerAgent {
	return new PlannerAgent(configOverrides);
}

/**
 * Create a typed Plan Reviewer agent
 */
export function createPR(configOverrides?: Partial<AgentConfig>): PlanReviewerAgent {
	return new PlanReviewerAgent(configOverrides);
}

/**
 * Create a typed Consolidator agent
 */
export function createCDM(configOverrides?: Partial<AgentConfig>): ConsolidatorAgent {
	return new ConsolidatorAgent(configOverrides);
}

/**
 * Create a typed Executor agent
 */
export function createEX(configOverrides?: Partial<AgentConfig>): ExecutorAgent {
	return new ExecutorAgent(configOverrides);
}

/**
 * Create a typed Verifier agent
 */
export function createTV(configOverrides?: Partial<AgentConfig>): VerifierAgent {
	return new VerifierAgent(configOverrides);
}

/**
 * Get agent by role with proper typing
 *
 * Helper function that returns a properly typed agent for each role.
 * Useful when you know the role at compile time.
 */
export function getTypedAgent<R extends PipelineAgentRole>(
	role: R,
	configOverrides?: Partial<AgentConfig>,
): R extends "LI"
	? LeadInvestigatorAgent
	: R extends "IV"
		? IssueValidatorAgent
		: R extends "PL"
			? PlannerAgent
			: R extends "PR"
				? PlanReviewerAgent
				: R extends "CDM"
					? ConsolidatorAgent
					: R extends "EX"
						? ExecutorAgent
						: R extends "TV"
							? VerifierAgent
							: never {
	switch (role) {
		case "LI":
			return new LeadInvestigatorAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "IV":
			return new IssueValidatorAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "PL":
			return new PlannerAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "PR":
			return new PlanReviewerAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "CDM":
			return new ConsolidatorAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "EX":
			return new ExecutorAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		case "TV":
			return new VerifierAgent(configOverrides) as ReturnType<typeof getTypedAgent<R>>;
		default:
			throw new Error(`Unknown pipeline agent role: ${role}`);
	}
}

/**
 * Registry entry for an agent
 */
export interface AgentRegistryEntry {
	/** Agent role */
	role: PipelineAgentRole;
	/** Agent class constructor */
	AgentClass: new (
		configOverrides?: Partial<AgentConfig>,
	) => IAgent<unknown, unknown>;
	/** Factory function to create the agent */
	create: (configOverrides?: Partial<AgentConfig>) => IAgent<unknown, unknown>;
	/** Human-readable name */
	name: string;
	/** Description of what the agent does */
	description: string;
}

/**
 * Agent registry - provides metadata and factories for all pipeline agents
 */
export const AGENT_REGISTRY: Record<PipelineAgentRole, AgentRegistryEntry> = {
	LI: {
		role: "LI",
		AgentClass: LeadInvestigatorAgent,
		create: createLI,
		name: "Lead Investigator",
		description: "Initial scan and problem candidate identification",
	},
	IV: {
		role: "IV",
		AgentClass: IssueValidatorAgent,
		create: createIV,
		name: "Issue Validator",
		description: "Per-issue validation with evidence",
	},
	PL: {
		role: "PL",
		AgentClass: PlannerAgent,
		create: createPL,
		name: "Planner",
		description: "WBS generation for validated issues",
	},
	PR: {
		role: "PR",
		AgentClass: PlanReviewerAgent,
		create: createPR,
		name: "Plan Reviewer",
		description: "WBS review and refinement",
	},
	CDM: {
		role: "CDM",
		AgentClass: ConsolidatorAgent,
		create: createCDM,
		name: "Consolidator",
		description: "Deduplication and unified planning",
	},
	EX: {
		role: "EX",
		AgentClass: ExecutorAgent,
		create: createEX,
		name: "Executor",
		description: "Task execution with minimal changes",
	},
	TV: {
		role: "TV",
		AgentClass: VerifierAgent,
		create: createTV,
		name: "Truth Verifier",
		description: "Evidence validation gate",
	},
};

/**
 * Get all pipeline agent roles
 */
export function getPipelineAgentRoles(): PipelineAgentRole[] {
	return ["LI", "IV", "PL", "PR", "CDM", "EX", "TV"];
}

/**
 * Get agent registry entry by role
 */
export function getAgentRegistryEntry(role: PipelineAgentRole): AgentRegistryEntry {
	return AGENT_REGISTRY[role];
}

/**
 * Check if an agent role is registered
 */
export function isAgentRegistered(role: string): role is PipelineAgentRole {
	return role in AGENT_REGISTRY;
}

/**
 * Create all pipeline agents with optional config overrides
 */
export function createAllAgents(
	configOverrides?: Partial<AgentConfig>,
): Record<PipelineAgentRole, IAgent<unknown, unknown>> {
	return {
		LI: createLI(configOverrides),
		IV: createIV(configOverrides),
		PL: createPL(configOverrides),
		PR: createPR(configOverrides),
		CDM: createCDM(configOverrides),
		EX: createEX(configOverrides),
		TV: createTV(configOverrides),
	};
}
