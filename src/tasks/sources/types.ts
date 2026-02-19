/**
 * Milhouse Task Sources - Type Definitions
 *
 * This module defines Milhouse-specific types for task sources that differentiate
 * from generic implementations. Key features:
 * - Task provenance tracking (where tasks originated)
 * - Schema validation interfaces
 * - Richer metadata (engine hints, expected artifacts, complexity)
 *
 * @module tasks/sources/types
 * @since 1.0.0
 */

import { z } from "zod";
import type { TaskPriority, TaskSourceConfig, TaskStatus } from "../../schemas/tasks.schema";

// ============================================================================
// Task Provenance Types - Track where tasks originated
// ============================================================================

/**
 * Source type enumeration for provenance tracking
 */
export type TaskSourceKind = "markdown" | "markdown-folder" | "yaml" | "github" | "api" | "manual";

/**
 * Task provenance - detailed tracking of task origin
 *
 * @description Tracks the complete lineage of a task including:
 * - Original source file/location
 * - Line numbers for file-based sources
 * - Timestamps for when the task was discovered
 * - Hash for change detection
 *
 * @example
 * ```typescript
 * const provenance: TaskProvenance = {
 *   sourceKind: "markdown",
 *   sourcePath: "./PRD.md",
 *   lineNumber: 42,
 *   columnNumber: 3,
 *   discoveredAt: "2026-01-23T10:00:00Z",
 *   contentHash: "sha256:abc123...",
 *   version: 1
 * };
 * ```
 */
export interface TaskProvenance {
	/** The type of source this task came from */
	sourceKind: TaskSourceKind;

	/** Path to the source file or identifier (e.g., "owner/repo" for GitHub) */
	sourcePath: string;

	/** Line number in source file (1-indexed) */
	lineNumber?: number;

	/** Column number in source file (1-indexed) */
	columnNumber?: number;

	/** ISO timestamp when this task was first discovered */
	discoveredAt: string;

	/** ISO timestamp when this task was last synced from source */
	lastSyncedAt?: string;

	/** Content hash for change detection (sha256) */
	contentHash?: string;

	/** Version number for optimistic concurrency */
	version: number;

	/** Parent task ID if this is a subtask */
	parentTaskId?: string;

	/** Original raw content before parsing */
	rawContent?: string;
}

// Zod schema for provenance validation
export const TaskProvenanceSchema = z.object({
	sourceKind: z.enum(["markdown", "markdown-folder", "yaml", "github", "api", "manual"]),
	sourcePath: z.string(),
	lineNumber: z.number().int().positive().optional(),
	columnNumber: z.number().int().positive().optional(),
	discoveredAt: z.string().datetime(),
	lastSyncedAt: z.string().datetime().optional(),
	contentHash: z.string().optional(),
	version: z.number().int().nonnegative(),
	parentTaskId: z.string().optional(),
	rawContent: z.string().optional(),
});

// ============================================================================
// Task Complexity Types
// ============================================================================

/**
 * Task complexity levels for estimation and scheduling
 */
export type TaskComplexity = "trivial" | "simple" | "medium" | "complex" | "epic";

/**
 * Complexity estimation with confidence
 */
export interface ComplexityEstimate {
	/** Estimated complexity level */
	level: TaskComplexity;

	/** Confidence in the estimate (0-1) */
	confidence: number;

	/** Estimated time in minutes */
	estimatedMinutes?: number;

	/** Factors that influenced the estimate */
	factors?: string[];
}

export const ComplexityEstimateSchema = z.object({
	level: z.enum(["trivial", "simple", "medium", "complex", "epic"]),
	confidence: z.number().min(0).max(1),
	estimatedMinutes: z.number().positive().optional(),
	factors: z.array(z.string()).optional(),
});

// ============================================================================
// Engine Hints Types
// ============================================================================

/**
 * Supported execution engines in Milhouse
 */
export type EngineType =
	| "claude"
	| "codex"
	| "aider"
	| "cursor"
	| "gemini"
	| "qwen"
	| "droid"
	| "opencode";

/**
 * Engine hints for task execution
 *
 * @description Provides suggestions for which engines are best suited
 * for executing a particular task, along with configuration hints.
 */
export interface EngineHints {
	/** Preferred engines in order of preference */
	preferred: EngineType[];

	/** Engines that should not be used for this task */
	excluded?: EngineType[];

	/** Minimum capability requirements */
	requirements?: {
		/** Requires code editing capability */
		codeEditing?: boolean;
		/** Requires file system access */
		fileSystem?: boolean;
		/** Requires web browsing */
		webBrowsing?: boolean;
		/** Requires terminal access */
		terminal?: boolean;
		/** Requires vision/image understanding */
		vision?: boolean;
	};

	/** Custom engine configuration overrides */
	configOverrides?: Record<string, unknown>;
}

export const EngineHintsSchema = z.object({
	preferred: z.array(
		z.enum(["claude", "codex", "aider", "cursor", "gemini", "qwen", "droid", "opencode"]),
	),
	excluded: z
		.array(z.enum(["claude", "codex", "aider", "cursor", "gemini", "qwen", "droid", "opencode"]))
		.optional(),
	requirements: z
		.object({
			codeEditing: z.boolean().optional(),
			fileSystem: z.boolean().optional(),
			webBrowsing: z.boolean().optional(),
			terminal: z.boolean().optional(),
			vision: z.boolean().optional(),
		})
		.optional(),
	configOverrides: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Expected Artifacts Types
// ============================================================================

/**
 * Types of artifacts that can be produced by task execution
 */
export type ArtifactType =
	| "file"
	| "directory"
	| "commit"
	| "branch"
	| "pr"
	| "issue"
	| "test-result"
	| "documentation"
	| "config";

/**
 * Expected artifact from task completion
 */
export interface ExpectedArtifact {
	/** Type of artifact */
	type: ArtifactType;

	/** Path or identifier pattern (supports globs) */
	pattern: string;

	/** Human-readable description */
	description?: string;

	/** Whether this artifact is required for task completion */
	required: boolean;

	/** Validation rules for the artifact */
	validation?: {
		/** File must exist */
		exists?: boolean;
		/** Minimum file size in bytes */
		minSize?: number;
		/** Maximum file size in bytes */
		maxSize?: number;
		/** Content must match regex */
		contentPattern?: string;
		/** Custom validation function name */
		customValidator?: string;
	};
}

export const ExpectedArtifactSchema = z.object({
	type: z.enum([
		"file",
		"directory",
		"commit",
		"branch",
		"pr",
		"issue",
		"test-result",
		"documentation",
		"config",
	]),
	pattern: z.string(),
	description: z.string().optional(),
	required: z.boolean(),
	validation: z
		.object({
			exists: z.boolean().optional(),
			minSize: z.number().positive().optional(),
			maxSize: z.number().positive().optional(),
			contentPattern: z.string().optional(),
			customValidator: z.string().optional(),
		})
		.optional(),
});

// ============================================================================
// Milhouse-Specific Task Metadata
// ============================================================================

/**
 * Extended task metadata specific to Milhouse
 *
 * @description Extends the base task metadata with Milhouse-specific fields
 * for provenance tracking, complexity estimation, and execution hints.
 */
export interface MilhouseTaskMetadata {
	/** Base source identifier */
	source: string;

	/** Source file path */
	sourceFile?: string;

	/** Line number in source */
	lineNumber?: number;

	/** Parallel execution group */
	parallelGroup?: number;

	/** Task dependencies (other task IDs) */
	dependencies: string[];

	/** Task labels/tags */
	labels: string[];

	/** Assigned user */
	assignee?: string;

	/** Due date (ISO string) */
	dueDate?: string;

	/** Estimated effort (e.g., "2h", "1d") */
	estimatedEffort?: string;

	// ---- Milhouse-specific extensions ----

	/** Full provenance tracking */
	provenance?: TaskProvenance;

	/** Complexity estimation */
	complexity?: ComplexityEstimate;

	/** Engine execution hints */
	engineHints?: EngineHints;

	/** Expected artifacts from task completion */
	expectedArtifacts?: ExpectedArtifact[];

	/** Custom key-value metadata */
	custom?: Record<string, unknown>;

	/** Execution history summary */
	executionHistory?: {
		attempts: number;
		lastAttemptAt?: string;
		lastEngine?: EngineType;
		averageDuration?: number;
	};
}

export const MilhouseTaskMetadataSchema = z.object({
	source: z.string(),
	sourceFile: z.string().optional(),
	lineNumber: z.number().optional(),
	parallelGroup: z.number().optional(),
	dependencies: z.array(z.string()).default([]),
	labels: z.array(z.string()).default([]),
	assignee: z.string().optional(),
	dueDate: z.string().optional(),
	estimatedEffort: z.string().optional(),
	provenance: TaskProvenanceSchema.optional(),
	complexity: ComplexityEstimateSchema.optional(),
	engineHints: EngineHintsSchema.optional(),
	expectedArtifacts: z.array(ExpectedArtifactSchema).optional(),
	custom: z.record(z.string(), z.unknown()).optional(),
	executionHistory: z
		.object({
			attempts: z.number().int().nonnegative(),
			lastAttemptAt: z.string().datetime().optional(),
			lastEngine: z
				.enum(["claude", "codex", "aider", "cursor", "gemini", "qwen", "droid", "opencode"])
				.optional(),
			averageDuration: z.number().positive().optional(),
		})
		.optional(),
});

// ============================================================================
// Milhouse Task Type
// ============================================================================

/**
 * Milhouse-specific task with extended metadata
 */
export interface MilhouseTask {
	/** Unique task identifier */
	id: string;

	/** Task title */
	title: string;

	/** Detailed description */
	description?: string;

	/** Current status */
	status: TaskStatus;

	/** Priority level */
	priority: TaskPriority;

	/** Extended Milhouse metadata */
	metadata: MilhouseTaskMetadata;

	/** Creation timestamp */
	createdAt?: string;

	/** Last update timestamp */
	updatedAt?: string;

	/** Completion timestamp */
	completedAt?: string;
}

export const MilhouseTaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(["pending", "in_progress", "completed", "failed", "skipped", "blocked"]),
	priority: z.enum(["critical", "high", "medium", "low"]),
	metadata: MilhouseTaskMetadataSchema,
	createdAt: z.string().datetime().optional(),
	updatedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
});

// ============================================================================
// Task Collection with Provenance
// ============================================================================

/**
 * Collection of Milhouse tasks with source tracking
 */
export interface MilhouseTaskCollection {
	/** Tasks in this collection */
	tasks: MilhouseTask[];

	/** Source identifier */
	source: string;

	/** Last sync timestamp */
	lastSynced?: string;

	/** Collection-level metadata */
	collectionMetadata?: {
		/** Total discovered tasks (including filtered) */
		totalDiscovered: number;
		/** Number of tasks filtered out */
		filteredCount: number;
		/** Filter criteria applied */
		filterCriteria?: string[];
		/** Schema version used */
		schemaVersion: string;
	};
}

export const MilhouseTaskCollectionSchema = z.object({
	tasks: z.array(MilhouseTaskSchema),
	source: z.string(),
	lastSynced: z.string().datetime().optional(),
	collectionMetadata: z
		.object({
			totalDiscovered: z.number().int().nonnegative(),
			filteredCount: z.number().int().nonnegative(),
			filterCriteria: z.array(z.string()).optional(),
			schemaVersion: z.string(),
		})
		.optional(),
});

// ============================================================================
// Source Configuration Extensions
// ============================================================================

/**
 * Extended source configuration for Milhouse
 */
export interface MilhouseSourceConfig extends TaskSourceConfig {
	/** Enable provenance tracking */
	trackProvenance?: boolean;

	/** Enable complexity estimation */
	estimateComplexity?: boolean;

	/** Default engine hints for all tasks from this source */
	defaultEngineHints?: EngineHints;

	/** Validation options */
	validation?: {
		/** Validate task schema on load */
		validateOnLoad?: boolean;
		/** Strict mode - fail on validation errors */
		strict?: boolean;
		/** Custom validators to run */
		customValidators?: string[];
	};

	/** Caching options */
	cache?: {
		/** Enable caching */
		enabled?: boolean;
		/** Cache TTL in seconds */
		ttlSeconds?: number;
		/** Cache key prefix */
		keyPrefix?: string;
	};
}

export const MilhouseSourceConfigSchema = z.object({
	type: z.enum(["markdown", "markdown-folder", "yaml", "github"]),
	path: z.string().optional(),
	patterns: z.array(z.string()).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
	trackProvenance: z.boolean().optional(),
	estimateComplexity: z.boolean().optional(),
	defaultEngineHints: EngineHintsSchema.optional(),
	validation: z
		.object({
			validateOnLoad: z.boolean().optional(),
			strict: z.boolean().optional(),
			customValidators: z.array(z.string()).optional(),
		})
		.optional(),
	cache: z
		.object({
			enabled: z.boolean().optional(),
			ttlSeconds: z.number().positive().optional(),
			keyPrefix: z.string().optional(),
		})
		.optional(),
});

// ============================================================================
// Source Statistics Extensions
// ============================================================================

/**
 * Extended statistics for Milhouse task sources
 */
export interface MilhouseSourceStats {
	/** Total tasks */
	total: number;

	/** Pending tasks */
	pending: number;

	/** Completed tasks */
	completed: number;

	/** Failed tasks */
	failed: number;

	/** In-progress tasks */
	inProgress: number;

	/** Skipped tasks */
	skipped: number;

	/** Blocked tasks */
	blocked: number;

	// ---- Milhouse extensions ----

	/** Tasks by complexity */
	byComplexity?: Record<TaskComplexity, number>;

	/** Tasks by priority */
	byPriority?: Record<TaskPriority, number>;

	/** Tasks by label */
	byLabel?: Record<string, number>;

	/** Average completion time in minutes */
	avgCompletionTime?: number;

	/** Completion rate (0-1) */
	completionRate?: number;

	/** Last activity timestamp */
	lastActivity?: string;
}

// ============================================================================
// Source Interface Extensions
// ============================================================================

/**
 * Load options for Milhouse task sources
 */
export interface MilhouseLoadOptions {
	/** Force refresh, bypassing cache */
	forceRefresh?: boolean;

	/** Include completed tasks */
	includeCompleted?: boolean;

	/** Filter by status */
	statusFilter?: TaskStatus[];

	/** Filter by priority */
	priorityFilter?: TaskPriority[];

	/** Filter by labels */
	labelFilter?: string[];

	/** Maximum number of tasks to load */
	limit?: number;

	/** Offset for pagination */
	offset?: number;

	/** Sort field */
	sortBy?: "priority" | "createdAt" | "title" | "complexity";

	/** Sort direction */
	sortDirection?: "asc" | "desc";
}

/**
 * Validation result for task sources
 */
export interface ValidationResult {
	/** Whether validation passed */
	valid: boolean;

	/** Validation errors */
	errors: ValidationError[];

	/** Validation warnings */
	warnings: ValidationWarning[];

	/** Tasks that passed validation */
	validTasks: MilhouseTask[];

	/** Tasks that failed validation */
	invalidTasks: Array<{ task: unknown; errors: ValidationError[] }>;
}

export interface ValidationError {
	/** Error code */
	code: string;

	/** Human-readable message */
	message: string;

	/** Path to the invalid field */
	path?: string[];

	/** Task ID if applicable */
	taskId?: string;
}

export interface ValidationWarning {
	/** Warning code */
	code: string;

	/** Human-readable message */
	message: string;

	/** Path to the field */
	path?: string[];

	/** Task ID if applicable */
	taskId?: string;
}

/**
 * Milhouse task source interface
 *
 * @description Extended interface for Milhouse task sources with
 * provenance tracking, validation, and rich metadata support.
 */
export interface IMilhouseTaskSource {
	/** Source name identifier */
	readonly name: string;

	/** Source configuration */
	readonly config: MilhouseSourceConfig;

	/**
	 * Load tasks from source with options
	 * @param options - Load options for filtering and pagination
	 */
	load(options?: MilhouseLoadOptions): Promise<MilhouseTaskCollection>;

	/**
	 * Update task status
	 * @param taskId - Task identifier
	 * @param status - New status
	 */
	updateStatus(taskId: string, status: TaskStatus): Promise<void>;

	/**
	 * Check if source is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Get source statistics
	 */
	getStats(): Promise<MilhouseSourceStats>;

	/**
	 * Refresh/reload from source
	 */
	refresh(): Promise<void>;

	/**
	 * Validate tasks against schema
	 */
	validate(): Promise<ValidationResult>;

	/**
	 * Get task by ID with full provenance
	 * @param taskId - Task identifier
	 */
	getTask(taskId: string): Promise<MilhouseTask | null>;

	/**
	 * Update task metadata
	 * @param taskId - Task identifier
	 * @param metadata - Partial metadata to merge
	 */
	updateMetadata(taskId: string, metadata: Partial<MilhouseTaskMetadata>): Promise<void>;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Result type for operations that can fail
 */
export type TaskOperationResult<T> =
	| { success: true; data: T }
	| { success: false; error: string; code?: string };

/**
 * Sync result with detailed information
 */
export interface MilhouseSyncResult {
	/** Number of tasks added */
	added: number;

	/** Number of tasks updated */
	updated: number;

	/** Number of tasks removed */
	removed: number;

	/** Number of tasks unchanged */
	unchanged: number;

	/** Errors encountered */
	errors: Array<{ taskId?: string; message: string }>;

	/** Sync duration in milliseconds */
	durationMs: number;

	/** Timestamp of sync */
	syncedAt: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Current schema version for Milhouse tasks */
export const MILHOUSE_TASK_SCHEMA_VERSION = "1.0.0";

/** Default complexity weights for estimation */
export const COMPLEXITY_WEIGHTS: Record<TaskComplexity, number> = {
	trivial: 1,
	simple: 2,
	medium: 5,
	complex: 13,
	epic: 21,
};

/** Default time estimates in minutes by complexity */
export const COMPLEXITY_TIME_ESTIMATES: Record<TaskComplexity, number> = {
	trivial: 5,
	simple: 15,
	medium: 60,
	complex: 240,
	epic: 480,
};
