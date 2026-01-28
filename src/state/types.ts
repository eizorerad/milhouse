import { z } from "zod";

/**
 * Evidence reference - proof for claims
 */
export const EvidenceSchema = z.object({
	type: z.enum(["file", "probe", "log", "command"]),
	file: z.string().optional(),
	line_start: z.number().optional(),
	line_end: z.number().optional(),
	probe_id: z.string().optional(),
	command: z.string().optional(),
	output: z.string().optional(),
	timestamp: z.string(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Issue/Problem status
 */
export const IssueStatusSchema = z.enum([
	"UNVALIDATED",
	"CONFIRMED",
	"FALSE",
	"PARTIAL",
	"MISDIAGNOSED",
]);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/**
 * Issue severity levels
 */
export const SeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Issue/Problem model
 */
export const IssueSchema = z.object({
	id: z.string(),
	symptom: z.string(),
	hypothesis: z.string(),
	evidence: z.array(EvidenceSchema).default([]),
	status: IssueStatusSchema.default("UNVALIDATED"),
	corrected_description: z.string().nullish(), // Accept both null and undefined
	severity: SeveritySchema.default("MEDIUM"),
	frequency: z.string().nullish(),
	blast_radius: z.string().nullish(),
	strategy: z.string().nullish(),
	related_task_ids: z.array(z.string()).default([]),
	created_at: z.string(),
	updated_at: z.string(),
	validated_by: z.string().nullish(),
});

export type Issue = z.infer<typeof IssueSchema>;

/**
 * Task status
 */
export const TaskStatusSchema = z.enum([
	"pending",
	"blocked",
	"running",
	"done",
	"failed",
	"skipped",
	"merge_error",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Definition of Done criteria
 */
export const DoDCriteriaSchema = z.object({
	description: z.string(),
	check_command: z.string().optional(),
	verified: z.boolean().default(false),
});

export type DoDCriteria = z.infer<typeof DoDCriteriaSchema>;

/**
 * Task model (enhanced for Milhouse pipeline)
 */
export const TaskSchema = z.object({
	id: z.string(),
	issue_id: z.string().optional(),
	title: z.string(),
	description: z.string().optional(),
	files: z.array(z.string()).default([]),
	depends_on: z.array(z.string()).default([]),
	checks: z.array(z.string()).default([]),
	acceptance: z.array(DoDCriteriaSchema).default([]),
	risk: z.string().optional(),
	rollback: z.string().optional(),
	parallel_group: z.number().default(0),
	status: TaskStatusSchema.default("pending"),
	branch: z.string().optional(),
	worktree: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string(),
	completed_at: z.string().optional(),
	error: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

/**
 * Execution record
 */
export const ExecutionRecordSchema = z.object({
	id: z.string(),
	task_id: z.string(),
	started_at: z.string(),
	completed_at: z.string().optional(),
	success: z.boolean().optional(),
	error: z.string().optional(),
	commit_sha: z.string().optional(),
	branch: z.string().optional(),
	pr_url: z.string().optional(),
	input_tokens: z.number().default(0),
	output_tokens: z.number().default(0),
	agent_role: z.string().optional(),
	follow_up_task_ids: z.array(z.string()).default([]),
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

/**
 * Dependency graph node
 */
export const GraphNodeSchema = z.object({
	id: z.string(),
	depends_on: z.array(z.string()).default([]),
	parallel_group: z.number().default(0),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * Common statistics fields shared between RunState and RunMeta
 * These track progress through the pipeline
 */
export const RunStatsSchema = z.object({
	issues_found: z.number().default(0),
	issues_validated: z.number().default(0),
	tasks_total: z.number().default(0),
	tasks_completed: z.number().default(0),
	tasks_failed: z.number().default(0),
});

export type RunStats = z.infer<typeof RunStatsSchema>;

/**
 * Run state - current pipeline state (LEGACY)
 *
 * @deprecated Use RunMeta from the new runs system instead.
 * This schema is maintained for backward compatibility with existing
 * .milhouse/state/run.json files. New code should use:
 * - createRun() to create a new run
 * - getCurrentRun() to get the current run metadata
 * - updateRunPhaseInMeta() to update run phase
 *
 * Will be removed in v2.0.
 */
export const RunStateSchema = z.object({
	run_id: z.string(),
	started_at: z.string(),
	phase: z.enum([
		"idle",
		"scanning",
		"validating",
		"planning",
		"reviewing",
		"consolidating",
		"executing",
		"verifying",
		"completed",
		"failed",
	]),
	current_task_id: z.string().optional(),
	// Stats fields - duplicated in RunMeta for backward compatibility
	// In v2.0, these will be removed and RunMeta will be the single source of truth
	issues_found: z.number().default(0),
	issues_validated: z.number().default(0),
	tasks_total: z.number().default(0),
	tasks_completed: z.number().default(0),
	tasks_failed: z.number().default(0),
});

/**
 * @deprecated Use RunMeta instead. Will be removed in v2.0.
 */
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * Agent role types
 */
export const AgentRoleSchema = z.enum([
	"LI",
	"IV",
	"PL",
	"PR",
	"CDM",
	"EX",
	"TV",
	"RL",
	"ETI",
	"DLA",
	"CA",
	"SI",
	"DVA",
	"RR",
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Agent role descriptions
 */
export const AGENT_ROLES: Record<AgentRole, string> = {
	LI: "Lead Investigator - Initial scan and problem candidate identification",
	IV: "Issue Validator - Per-problem validation with evidence",
	PL: "Planner - WBS generation for validated issues",
	PR: "Plan Reviewer - WBS review and refinement",
	CDM: "Consistency & Dependency Manager - Deduplication and unified planning",
	EX: "Executor - Story execution with minimal changes",
	TV: "Truth Verifier Gate - Evidence validation blocker",
	RL: "Repo Librarian - Fast context collection",
	ETI: "Environment Topology Inspector - compose/k8s/.env",
	DLA: "Database Layer Auditor - postgres schema/migrations",
	CA: "Cache Auditor - redis TTL/keyspace/prefix",
	SI: "Storage Inspector - S3/MinIO/FS/volume",
	DVA: "Dependency Version Auditor - lockfile vs installed",
	RR: "Repro Runner - logs and reproduction",
};

/**
 * Probe type identifiers - matches inspector agent roles
 */
export const ProbeTypeSchema = z.enum([
	"compose", // ETI - Environment Topology Inspector
	"postgres", // DLA - Database Layer Auditor
	"redis", // CA - Cache Auditor
	"storage", // SI - Storage Inspector
	"deps", // DVA - Dependency Version Auditor
	"repro", // RR - Repro Runner
	"validation", // Used during issue validation
]);

export type ProbeType = z.infer<typeof ProbeTypeSchema>;

/**
 * Probe severity for issues found
 */
export const ProbeSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

export type ProbeSeverity = z.infer<typeof ProbeSeveritySchema>;

/**
 * Probe finding - an issue or observation discovered by a probe
 */
export const ProbeFindingSchema = z.object({
	/** Unique finding identifier */
	id: z.string(),
	/** Brief title of the finding */
	title: z.string(),
	/** Detailed description */
	description: z.string(),
	/** Severity level */
	severity: ProbeSeveritySchema,
	/** File location if applicable */
	file: z.string().optional(),
	/** Line number in file if applicable */
	line: z.number().optional(),
	/** End line number if applicable */
	line_end: z.number().optional(),
	/** Suggested fix or action */
	suggestion: z.string().optional(),
	/** Related evidence */
	evidence: z.array(z.string()).default([]),
	/** Additional metadata */
	metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProbeFinding = z.infer<typeof ProbeFindingSchema>;

/**
 * Probe result - output from a probe execution
 */
export const ProbeResultSchema = z.object({
	/** Unique probe result identifier */
	probe_id: z.string(),
	/** Type of probe */
	probe_type: ProbeTypeSchema,
	/** Whether the probe executed successfully */
	success: z.boolean(),
	/** Human-readable output summary */
	output: z.string().optional(),
	/** Error message if probe failed */
	error: z.string().optional(),
	/** ISO timestamp of probe execution */
	timestamp: z.string(),
	/** Whether the probe was read-only (no side effects) */
	read_only: z.boolean().default(true),
	/** Execution duration in milliseconds */
	duration_ms: z.number().optional(),
	/** Findings discovered by the probe */
	findings: z.array(ProbeFindingSchema).default([]),
	/** Raw command output if applicable */
	raw_output: z.string().optional(),
	/** Exit code if a command was executed */
	exit_code: z.number().optional(),
});

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/**
 * Gate check result
 */
export const GateResultSchema = z.object({
	gate: z.string(),
	passed: z.boolean(),
	message: z.string().optional(),
	evidence: z.array(EvidenceSchema).default([]),
	timestamp: z.string(),
});

export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * State file paths
 */
export const STATE_FILES = {
	run: "run.json",
	issues: "issues.json",
	tasks: "tasks.json",
	graph: "graph.json",
	executions: "executions.json",
} as const;

/**
 * Plan file paths
 */
export const PLAN_FILES = {
	problem_brief: "problem_brief.md",
	execution_plan: "execution_plan.md",
} as const;

/**
 * Run phase enum for pipeline runs
 */
export const RunPhaseSchema = z.enum([
	"scan",
	"validate",
	"plan",
	"consolidate",
	"exec",
	"verify",
	"completed",
	"failed",
]);

export type RunPhase = z.infer<typeof RunPhaseSchema>;

/**
 * Run metadata - stored in each run's meta.json
 *
 * This is the SINGLE SOURCE OF TRUTH for run state in the new runs system.
 * It replaces the legacy RunState schema and provides:
 * - Run identification (id, name, scope)
 * - Timestamps (created_at, updated_at)
 * - Pipeline phase tracking
 * - Progress statistics (issues_found, tasks_completed, etc.)
 * - Validation report references
 *
 * Use the following functions to work with RunMeta:
 * - createRun() - Create a new run
 * - getCurrentRun() - Get the current active run
 * - updateRunPhaseInMeta() - Update run phase
 * - updateRunStats() - Update progress statistics
 * - updateRunMetaWithLock() - Thread-safe updates
 */
export const RunMetaSchema = z.object({
	/** Unique run identifier (e.g., "run-20240115-abc123") */
	id: z.string(),
	/** Optional human-readable name for the run */
	name: z.string().optional(),
	/** Investigation scope that initiated this run */
	scope: z.string().optional(),
	/** ISO timestamp when run was created */
	created_at: z.string(),
	/** ISO timestamp of last update */
	updated_at: z.string(),
	/** Current pipeline phase */
	phase: RunPhaseSchema,
	/** Number of issues discovered during scan */
	issues_found: z.number().default(0),
	/** Number of issues that passed validation */
	issues_validated: z.number().default(0),
	/** Total number of tasks planned */
	tasks_total: z.number().default(0),
	/** Number of tasks successfully completed */
	tasks_completed: z.number().default(0),
	/** Number of tasks that failed */
	tasks_failed: z.number().default(0),
	/** IDs of validation reports associated with this run */
	validation_reports: z.array(z.string()).optional(),
});

export type RunMeta = z.infer<typeof RunMetaSchema>;

/**
 * Runs index - stored in .milhouse/runs-index.json
 * Tracks all runs and which one is currently active
 */
export const RunsIndexSchema = z.object({
	current_run: z.string().nullable(),
	runs: z.array(
		z.object({
			id: z.string(),
			name: z.string().optional(),
			scope: z.string().optional(),
			created_at: z.string(),
			phase: RunPhaseSchema,
		}),
	),
});

export type RunsIndex = z.infer<typeof RunsIndexSchema>;

/**
 * Runs directory constants
 */
export const RUNS_FILES = {
	index: "runs-index.json",
	meta: "meta.json",
	runsDir: "runs",
} as const;

// ============================================================================
// AUDIT TYPES
// ============================================================================

/**
 * Audit entry - records a state change for audit trail
 *
 * Stored in append-only audit.jsonl files within each run directory.
 * Each line is a JSON object representing one audit entry.
 */
export const AuditEntrySchema = z.object({
	/** ISO timestamp when the change occurred */
	timestamp: z.string(),
	/** Agent ID that made the change (if applicable) */
	agent_id: z.string().optional(),
	/** Action type (e.g., "task:status:changed", "run:created", "issue:validated") */
	action: z.string(),
	/** Entity type being changed (e.g., "task", "run", "issue") */
	entity_type: z.string(),
	/** Entity ID being changed */
	entity_id: z.string(),
	/** State before the change (for rollback/diff) */
	before: z.unknown().optional(),
	/** State after the change */
	after: z.unknown().optional(),
	/** Optional additional metadata */
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Common audit action types
 */
export const AUDIT_ACTIONS = {
	// Run actions
	RUN_CREATED: "run:created",
	RUN_DELETED: "run:deleted",
	RUN_PHASE_CHANGED: "run:phase:changed",
	RUN_STATS_UPDATED: "run:stats:updated",

	// Task actions
	TASK_CREATED: "task:created",
	TASK_DELETED: "task:deleted",
	TASK_STATUS_CHANGED: "task:status:changed",
	TASK_UPDATED: "task:updated",

	// Issue actions
	ISSUE_CREATED: "issue:created",
	ISSUE_DELETED: "issue:deleted",
	ISSUE_STATUS_CHANGED: "issue:status:changed",
	ISSUE_VALIDATED: "issue:validated",
	ISSUE_UPDATED: "issue:updated",

	// Execution actions
	EXECUTION_STARTED: "execution:started",
	EXECUTION_COMPLETED: "execution:completed",
	EXECUTION_FAILED: "execution:failed",

	// Validation actions
	VALIDATION_REPORT_CREATED: "validation:report:created",

	// State actions
	STATE_SNAPSHOT_CREATED: "state:snapshot:created",
	STATE_ROLLBACK: "state:rollback",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

// ============================================================================
// VALIDATION INDEX TYPES
// ============================================================================

/**
 * Validation report reference in the index
 */
export const ValidationReportRefSchema = z.object({
	/** Issue ID this report validates */
	issue_id: z.string(),
	/** Path to the report file (relative to run directory) */
	report_path: z.string(),
	/** ISO timestamp when report was created */
	created_at: z.string(),
	/** Validation status */
	status: z.enum(["valid", "invalid", "partial"]),
});

export type ValidationReportRef = z.infer<typeof ValidationReportRefSchema>;

/**
 * Validation index - tracks all validation reports for a run
 *
 * Stored in .milhouse/runs/<run-id>/validation-index.json
 */
export const ValidationIndexSchema = z.object({
	/** Run ID this index belongs to */
	run_id: z.string(),
	/** Array of validation report references */
	reports: z.array(ValidationReportRefSchema),
	/** ISO timestamp of last update */
	updated_at: z.string(),
});

export type ValidationIndex = z.infer<typeof ValidationIndexSchema>;
