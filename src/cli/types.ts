/**
 * @fileoverview Milhouse CLI Types
 *
 * Core type definitions for the Milhouse CLI command system.
 * These types define the structure of command results, contexts,
 * and the command tree architecture.
 *
 * @module cli/types
 *
 * @since 4.3.0
 */

import type { RuntimeOptions } from "./runtime-options.ts";

/**
 * Milhouse CLI version information
 */
export const MILHOUSE_CLI_VERSION = "4.3.0";

/**
 * Milhouse pipeline phases
 */
export type MilhousePhase = "scan" | "validate" | "plan" | "consolidate" | "exec" | "verify";

/**
 * All Milhouse pipeline phases in order
 */
export const MILHOUSE_PHASES: MilhousePhase[] = [
	"scan",
	"validate",
	"plan",
	"consolidate",
	"exec",
	"verify",
];

/**
 * Milhouse CLI branding constants
 *
 * These constants define all Milhouse-specific branding used throughout
 * the CLI. They ensure consistent naming and help differentiate Milhouse
 * from other similar tools.
 */
export const MILHOUSE_BRANDING = {
	/** Full product name */
	name: "Milhouse",
	/** Display name with tagline */
	displayName: "Milhouse AI Pipeline Orchestrator",
	/** Short name for CLI commands */
	shortName: "milhouse",
	/** Short description for help text */
	description: "AI Pipeline Orchestrator",
	/** CLI version */
	version: MILHOUSE_CLI_VERSION,
	/** Configuration directory name */
	configDir: ".milhouse",
	/** Worktree directory for parallel execution */
	worktreeDir: ".milhouse-worktrees",
	/** Git branch prefix for Milhouse branches */
	branchPrefix: "milhouse/",
	/** Branch name for autostash operations */
	autostashBranch: "milhouse-autostash",
	/** Author name for PRs and commits */
	prAuthor: "Milhouse",
	/** Footer text for PRs */
	prFooter: "Automated by Milhouse Pipeline Orchestrator",
	/** Project website URL */
	website: "https://github.com/milhouse-ai/milhouse",
	/** Repository URL */
	repoUrl: "https://github.com/milhouse-ai/milhouse",
	/** Documentation URL */
	docsUrl: "https://github.com/milhouse-ai/milhouse#readme",
} as const;

/**
 * Command execution status
 */
export type CommandStatus = "success" | "failure" | "partial" | "skipped";

/**
 * Base result type for all CLI commands
 */
export interface CommandResult {
	/** Whether the command succeeded */
	success: boolean;
	/** Human-readable status message */
	message?: string;
	/** Error details if failed */
	error?: string;
	/** Execution duration in milliseconds */
	durationMs?: number;
	/** Token usage for AI operations */
	tokens?: {
		input: number;
		output: number;
	};
}

/**
 * Result type for core commands (init, config)
 */
export interface CoreCommandResult extends CommandResult {
	/** Path to created/modified config */
	configPath?: string;
	/** Detected project information */
	detected?: {
		name: string;
		language?: string;
		framework?: string;
		testCmd?: string;
		lintCmd?: string;
		buildCmd?: string;
	};
}

/**
 * Result type for task-related commands
 */
export interface TaskCommandResult extends CommandResult {
	/** Number of tasks processed */
	tasksProcessed?: number;
	/** Number of tasks completed successfully */
	tasksCompleted?: number;
	/** Number of tasks that failed */
	tasksFailed?: number;
	/** Number of tasks skipped */
	tasksSkipped?: number;
}

/**
 * Result type for pipeline commands (scan, validate, plan, exec, verify)
 */
export interface PipelineCommandResult extends CommandResult {
	/** Current pipeline phase */
	phase?: string;
	/** Number of issues found/processed */
	issuesCount?: number;
	/** Number of tasks created/processed */
	tasksCount?: number;
	/** Path to generated artifacts */
	artifactPaths?: string[];
}

/**
 * Result type for scan command
 */
export interface ScanCommandResult extends PipelineCommandResult {
	/** Number of issues found */
	issuesFound: number;
	/** Path to generated Problem Brief */
	problemBriefPath?: string;
	/** Run ID for this scan */
	runId?: string;
}

/**
 * Result type for validate command
 */
export interface ValidateCommandResult extends PipelineCommandResult {
	/** Number of issues validated */
	issuesValidated: number;
	/** Number of issues confirmed */
	issuesConfirmed: number;
	/** Number of false positives */
	issuesFalse: number;
	/** Number of partial matches */
	issuesPartial: number;
	/** Number of misdiagnosed issues */
	issuesMisdiagnosed: number;
}

/**
 * Result type for plan command
 */
export interface PlanCommandResult extends PipelineCommandResult {
	/** Number of issues planned */
	issuesPlanned: number;
	/** Number of tasks created */
	tasksCreated: number;
	/** Paths to generated WBS plans */
	planPaths: string[];
}

/**
 * Result type for consolidate command
 */
export interface ConsolidateCommandResult extends PipelineCommandResult {
	/** Number of tasks consolidated */
	tasksConsolidated: number;
	/** Number of parallel groups */
	parallelGroups: number;
	/** Number of duplicates removed */
	duplicatesRemoved: number;
	/** Path to execution plan */
	executionPlanPath: string;
}

/**
 * Result type for exec command
 */
export interface ExecCommandResult extends PipelineCommandResult {
	/** Number of tasks executed */
	tasksExecuted: number;
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of tasks failed */
	tasksFailed: number;
}

/**
 * Result type for verify command
 */
export interface VerifyCommandResult extends PipelineCommandResult {
	/** Number of gates run */
	gatesRun: number;
	/** Number of gates passed */
	gatesPassed: number;
	/** Number of gates failed */
	gatesFailed: number;
	/** Verification issues found */
	issues: VerificationIssue[];
}

/**
 * Verification issue structure
 */
export interface VerificationIssue {
	gate: string;
	severity: "ERROR" | "WARNING";
	file?: string;
	line?: number;
	message: string;
}

/**
 * Result type for export command
 */
export interface ExportCommandResult extends CommandResult {
	/** Paths to created export files */
	filesCreated: string[];
	/** Export formats used */
	formats: string[];
}

/**
 * Result type for runs management commands
 */
export interface RunsCommandResult extends CommandResult {
	/** List of runs (for list command) */
	runs?: RunInfo[];
	/** Current run info (for info command) */
	currentRun?: RunInfo;
}

/**
 * Run information structure
 */
export interface RunInfo {
	id: string;
	scope?: string;
	name?: string;
	phase: string;
	createdAt: string;
	updatedAt: string;
	isCurrent: boolean;
	stats: {
		issuesFound: number;
		issuesValidated: number;
		tasksTotal: number;
		tasksCompleted: number;
		tasksFailed: number;
	};
}

/**
 * CLI execution context
 */
export interface CLIContext {
	/** Working directory */
	workDir: string;
	/** Runtime options from CLI args */
	options: RuntimeOptions;
	/** Whether verbose mode is enabled */
	verbose: boolean;
	/** Whether dry-run mode is enabled */
	dryRun: boolean;
}

/**
 * Command group definitions for the command tree
 */
export type CommandGroup = "core" | "tasks" | "pipeline" | "utils";

/**
 * Command metadata for help and documentation
 */
export interface CommandMeta {
	/** Command name */
	name: string;
	/** Command group */
	group: CommandGroup;
	/** Short description */
	description: string;
	/** Usage examples */
	examples: string[];
	/** Related commands */
	related?: string[];
	/** Whether this is a pipeline phase */
	isPipelinePhase?: boolean;
	/** Pipeline phase order (if applicable) */
	phaseOrder?: number;
}

/**
 * Milhouse command tree structure
 *
 * Commands are organized into groups:
 * - core: Configuration and initialization (init, config)
 * - tasks: Task management (task, run, runs)
 * - pipeline: Pipeline phases (scan, validate, plan, consolidate, exec, verify)
 * - utils: Utility commands (export)
 */
export const COMMAND_TREE: Record<CommandGroup, CommandMeta[]> = {
	core: [
		{
			name: "init",
			group: "core",
			description: "Initialize Milhouse configuration in the current directory",
			examples: ["milhouse --init", "milhouse init"],
			related: ["config"],
		},
		{
			name: "config",
			group: "core",
			description: "Show or modify Milhouse configuration",
			examples: ["milhouse --config", 'milhouse --add-rule "Always use TypeScript"'],
			related: ["init"],
		},
	],
	tasks: [
		{
			name: "task",
			group: "tasks",
			description: "Execute a single task (brownfield mode)",
			examples: ['milhouse "Fix the login bug"', 'milhouse "Add user authentication" --claude'],
			related: ["run", "exec"],
		},
		{
			name: "run",
			group: "tasks",
			description: "Run the full Milhouse pipeline",
			examples: [
				"milhouse --run",
				"milhouse --run --parallel",
				"milhouse --run --start-phase validate",
			],
			related: ["scan", "validate", "plan", "exec", "verify"],
			isPipelinePhase: false,
		},
		{
			name: "runs",
			group: "tasks",
			description: "Manage pipeline runs",
			examples: [
				"milhouse runs list",
				"milhouse runs info",
				"milhouse runs switch <id>",
				"milhouse runs delete <id>",
			],
			related: ["run"],
		},
	],
	pipeline: [
		{
			name: "scan",
			group: "pipeline",
			description: "Scan repository for issues (Lead Investigator agent)",
			examples: ["milhouse --scan", 'milhouse --scan --scope "frontend"'],
			related: ["validate"],
			isPipelinePhase: true,
			phaseOrder: 1,
		},
		{
			name: "validate",
			group: "pipeline",
			description: "Validate issues with probes (Issue Validator agents)",
			examples: ["milhouse --validate", "milhouse --validate --issues P-xxx,P-yyy"],
			related: ["scan", "plan"],
			isPipelinePhase: true,
			phaseOrder: 2,
		},
		{
			name: "plan",
			group: "pipeline",
			description: "Generate WBS for validated issues (Planner agents)",
			examples: ["milhouse --plan", "milhouse --plan --min-severity HIGH"],
			related: ["validate", "consolidate"],
			isPipelinePhase: true,
			phaseOrder: 3,
		},
		{
			name: "consolidate",
			group: "pipeline",
			description: "Merge WBS into unified Execution Plan (CDM agent)",
			examples: ["milhouse --consolidate"],
			related: ["plan", "exec"],
			isPipelinePhase: true,
			phaseOrder: 4,
		},
		{
			name: "exec",
			group: "pipeline",
			description: "Execute tasks from the Execution Plan (Executor agents)",
			examples: [
				"milhouse --exec",
				"milhouse --exec --parallel",
				"milhouse --exec --task-id T-xxx",
			],
			related: ["consolidate", "verify"],
			isPipelinePhase: true,
			phaseOrder: 5,
		},
		{
			name: "verify",
			group: "pipeline",
			description: "Run verification gates (Truth Verifier agent)",
			examples: ["milhouse --verify"],
			related: ["exec", "export"],
			isPipelinePhase: true,
			phaseOrder: 6,
		},
	],
	utils: [
		{
			name: "export",
			group: "utils",
			description: "Export state to markdown/JSON formats",
			examples: ["milhouse --export", "milhouse --export --format md"],
			related: ["verify"],
		},
	],
};

/**
 * Get all commands in pipeline order
 */
export function getPipelineCommands(): CommandMeta[] {
	return COMMAND_TREE.pipeline.sort((a, b) => (a.phaseOrder ?? 0) - (b.phaseOrder ?? 0));
}

/**
 * Get command metadata by name
 */
export function getCommandMeta(name: string): CommandMeta | undefined {
	for (const group of Object.values(COMMAND_TREE)) {
		const cmd = group.find((c) => c.name === name);
		if (cmd) return cmd;
	}
	return undefined;
}

/**
 * Get all commands in a group
 */
export function getCommandsByGroup(group: CommandGroup): CommandMeta[] {
	return COMMAND_TREE[group] ?? [];
}

/**
 * Configuration display structure for CLI output
 */
export interface MilhouseConfigDisplay {
	project: {
		name: string;
		language?: string;
		framework?: string;
		description?: string;
	};
	commands: {
		test?: string;
		lint?: string;
		build?: string;
	};
	rules: string[];
	boundaries: {
		neverTouch: string[];
	};
}
