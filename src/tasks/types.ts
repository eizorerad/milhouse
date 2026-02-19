/**
 * Milhouse Task Types
 *
 * This module defines the core task types for Milhouse.
 * @module tasks/types
 * @since 1.0.0
 */

// ============================================================================
// Constants (kept in this module)
// ============================================================================

/**
 * Priority weights for sorting (higher = more important)
 */
export const PRIORITY_WEIGHTS: Record<string, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
};

/**
 * Status weights for sorting (higher = more urgent)
 */
export const STATUS_WEIGHTS: Record<string, number> = {
	in_progress: 5,
	pending: 4,
	blocked: 3,
	failed: 2,
	skipped: 1,
	completed: 0,
};

// ============================================================================
// Re-exports from sources/types
// ============================================================================

// Re-export all types from sources/types
export type {
	// Provenance types
	TaskSourceKind,
	TaskProvenance,
	// Complexity types
	TaskComplexity,
	ComplexityEstimate,
	// Engine types
	EngineType,
	EngineHints,
	// Artifact types
	ArtifactType,
	ExpectedArtifact,
	// Milhouse task types
	MilhouseTaskMetadata,
	MilhouseTask,
	MilhouseTaskCollection,
	// Source configuration
	MilhouseSourceConfig,
	MilhouseSourceStats,
	// Source interface
	IMilhouseTaskSource,
	MilhouseLoadOptions,
	// Validation types
	ValidationResult,
	ValidationError,
	ValidationWarning,
	// Operation types
	TaskOperationResult,
	MilhouseSyncResult,
} from "./sources/types";

// Re-export schemas
export {
	TaskProvenanceSchema,
	ComplexityEstimateSchema,
	EngineHintsSchema,
	ExpectedArtifactSchema,
	MilhouseTaskMetadataSchema,
	MilhouseTaskSchema,
	MilhouseTaskCollectionSchema,
	MilhouseSourceConfigSchema,
	MILHOUSE_TASK_SCHEMA_VERSION,
	COMPLEXITY_WEIGHTS,
	COMPLEXITY_TIME_ESTIMATES,
} from "./sources/types";

// ============================================================================
// Legacy Types (Deprecated - for backward compatibility)
// ============================================================================

/**
 * @deprecated Use MilhouseTask from tasks/sources/types instead
 * A single task to be executed (legacy interface)
 */
export interface Task {
	/** Unique identifier (line number for markdown, index for yaml, issue number for github) */
	id: string;
	/** Task title/description */
	title: string;
	/** Full task body (for github issues) */
	body?: string;
	/** Parallel group number (0 = sequential, >0 = can run in parallel with same group) */
	parallelGroup?: number;
	/** Whether the task is completed */
	completed: boolean;
}

/**
 * @deprecated Use MilhouseSourceConfig['type'] from tasks/sources/types instead
 * Task source type
 */
export type TaskSourceType = "markdown" | "markdown-folder" | "yaml" | "github";

/**
 * @deprecated Use IMilhouseTaskSource from tasks/sources/types instead
 * Task source interface - one per format
 */
export interface TaskSource {
	/** Type of task source */
	type: TaskSourceType;
	/** Get all remaining (incomplete) tasks */
	getAllTasks(): Promise<Task[]>;
	/** Get the next task to execute */
	getNextTask(): Promise<Task | null>;
	/** Mark a task as complete */
	markComplete(id: string): Promise<void>;
	/** Count remaining tasks */
	countRemaining(): Promise<number>;
	/** Count completed tasks */
	countCompleted(): Promise<number>;
	/** Get tasks in a specific parallel group */
	getTasksInGroup?(group: number): Promise<Task[]>;
}
