/**
 * Configuration Types Module
 *
 * This module re-exports configuration types from the domain layer
 * and provides CLI-specific runtime options.
 *
 * @module config/types
 * @deprecated Import from 'domain/config' or 'services/config' instead
 */

import type { Severity } from "../state/types.ts";

// Re-export directory constants from domain layer
export {
	MILHOUSE_DIR,
	CONFIG_FILE,
	PROGRESS_FILE,
	STATE_DIR,
	PROBES_DIR,
	PLANS_DIR,
	WORK_DIR,
	DIRECTORIES,
} from "../domain/config/directories.ts";

// Re-export Zod schemas from domain layer
export {
	ProjectInfoSchema as ProjectSchema,
	CommandsConfigSchema as CommandsSchema,
	BoundariesConfigSchema as BoundariesSchema,
	AllowedCommandsConfigSchema as AllowedCommandsSchema,
	ProbeConfigSchema,
	CurrentConfigSchema as MilhouseConfigSchema,
} from "../domain/config/schema.ts";

// Re-export types from domain layer
export type {
	MilhouseConfig,
	ProjectInfo,
	CommandsConfig,
	BoundariesConfig,
	AllowedCommandsConfig,
	ProbeConfig,
	ExecutionConfig,
	GatesConfig,
} from "../domain/config/types.ts";

/**
 * Available execution modes for task processing
 */
export type ExecutionMode = "in-place" | "branch" | "worktree" | "pr";

/**
 * Predefined scan scope categories
 */
export type ScanScope = "fastapi" | "redis" | "db" | "storage" | "deps" | "compose" | "all";

/**
 * CLI runtime options parsed from command-line arguments
 *
 * These options control the behavior of the CLI during execution
 * and are separate from the persisted configuration.
 *
 * @since 4.5.0 - Added new Milhouse-first field names with deprecated aliases
 */
export interface RuntimeOptions {
	// Test and lint control
	skipTests: boolean;
	skipLint: boolean;

	// AI engine settings
	aiEngine: string;
	modelOverride?: string;

	// Execution control
	dryRun: boolean;
	maxIterations: number;
	maxRetries: number;
	retryDelay: number;
	verbose: boolean;
	failFast?: boolean;

	// Branch and PR settings (new Milhouse-first names)
	/**
	 * Create isolated branch/worktree for each task
	 * @since 4.5.0 - Replaces deprecated `branchPerTask`
	 */
	branchPerTask: boolean;
	/**
	 * Alias for branchPerTask (new preferred name)
	 * @since 4.5.0
	 */
	isolate?: boolean;
	baseBranch: string;
	createPr: boolean;
	draftPr: boolean;
	autoCommit: boolean;
	skipMerge?: boolean;

	// Parallel execution (new Milhouse-first names)
	/**
	 * Enable parallel execution
	 * @deprecated Use `workers` instead (since 4.5.0)
	 */
	parallel: boolean;
	/**
	 * Number of parallel workers (new preferred name)
	 * @since 4.5.0 - Replaces deprecated `maxParallel`
	 */
	maxParallel: number;
	/**
	 * Alias for parallel + maxParallel (new preferred name)
	 * When set to a number, enables parallel with that many workers
	 * @since 4.5.0
	 */
	workers?: number;
	useWorktrees?: boolean;
	execByIssue?: boolean;

	// Task source configuration (new Milhouse-first names)
	/**
	 * Task source type
	 */
	prdSource: "markdown" | "markdown-folder" | "yaml" | "github";
	/**
	 * Task input file path
	 * @deprecated Use `input` instead (since 4.5.0)
	 */
	prdFile: string;
	/**
	 * Task input file or folder path (new preferred name)
	 * @since 4.5.0 - Replaces deprecated `prdFile`
	 */
	input?: string;
	prdIsFolder: boolean;
	githubRepo: string;
	githubLabel: string;

	// Browser automation
	browserEnabled: "auto" | "true" | "false";

	// Milhouse-specific execution options
	mode?: ExecutionMode;
	scope?: ScanScope[];
	scanFocus?: string;
	env?: string;
	exportFormat?: ("md" | "json")[];
	taskId?: string;

	// Issue filtering
	issueIds?: string[];
	excludeIssueIds?: string[];
	minSeverity?: Severity;
	severityFilter?: Severity[];

	// Probe control
	skipProbes?: boolean;

	// Validation retry settings
	/**
	 * Maximum retry attempts for UNVALIDATED issues during validation
	 * @default 2
	 */
	maxValidationRetries?: number;

	/**
	 * Whether to retry UNVALIDATED issues automatically
	 * @default true
	 */
	retryUnvalidated?: boolean;

	/**
	 * Delay between validation retry rounds in milliseconds
	 * @default 2000
	 */
	retryDelayValidation?: number;
}

/**
 * Default values for runtime options
 *
 * These defaults are used when CLI arguments are not provided.
 */
export const DEFAULT_OPTIONS: RuntimeOptions = {
	// Test and lint defaults
	skipTests: false,
	skipLint: false,

	// AI engine defaults
	aiEngine: "claude",

	// Execution defaults
	dryRun: false,
	maxIterations: 0,
	maxRetries: 3,
	retryDelay: 5000,
	verbose: false,

	// Branch and PR defaults
	branchPerTask: false,
	baseBranch: "",
	createPr: false,
	draftPr: false,
	autoCommit: true,

	// Parallel execution defaults
	parallel: false,
	maxParallel: 4,

	// PRD source defaults
	prdSource: "markdown",
	prdFile: "PRD.md",
	prdIsFolder: false,
	githubRepo: "",
	githubLabel: "",

	// Browser automation default
	browserEnabled: "auto",

	// Milhouse-specific defaults
	mode: "branch",
	scope: ["all"],
	env: "local",
	skipProbes: false,

	// Validation retry defaults
	maxValidationRetries: 2,
	retryUnvalidated: true,
	retryDelayValidation: 2000,
};
