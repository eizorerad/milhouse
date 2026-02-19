/**
 * Milhouse Tasks Module
 *
 * This module provides a complete task management system for Milhouse with:
 * - Multiple source adapters (Markdown, YAML, GitHub)
 * - Task provenance tracking
 * - Schema validation with Zod
 * - Complexity estimation
 * - Engine hints for execution
 *
 * @module tasks
 * @since 1.0.0
 */

// ============================================================================
// Milhouse-Specific Types (New Architecture)
// ============================================================================

// Export all Milhouse-specific types from sources/types
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

// Export schemas and constants
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
// Source Adapters (New Architecture)
// ============================================================================

// Export new source implementations
export { MarkdownTaskSource } from "./sources/markdown";
export { MarkdownFolderTaskSource } from "./sources/markdown-folder";
export { YamlTaskSource } from "./sources/yaml";
// GitHubTaskSource is not exported directly to avoid requiring @octokit/rest
// Use getGitHubTaskSource() or createTaskSourceAsync() instead

/**
 * Dynamically load GitHubTaskSource to avoid requiring @octokit/rest at build time
 * @returns Promise resolving to GitHubTaskSource class
 */
export async function getGitHubTaskSource(): Promise<
	typeof import("./sources/github").GitHubTaskSource
> {
	const module = await import("./sources/github");
	return module.GitHubTaskSource;
}

// ============================================================================
// Core Types and Interfaces
// ============================================================================

export * from "./core/types";
export { TaskModel } from "./core/model";
export { TaskSelector } from "./core/selector";

// ============================================================================
// Runtime Utilities
// ============================================================================

export {
	createTaskSource,
	createTaskSourceAsync,
	detectTaskSource,
	createTaskSources,
	validateSourceConfig,
	getSourceTypeFromPath,
	createConfigFromPath,
} from "./runtime/factory";
export { TaskSyncManager, createSyncManager } from "./runtime/sync";

// ============================================================================
// Schema Exports (from schemas module)
// ============================================================================

export {
	TaskSchema,
	TaskStatusSchema,
	TaskPrioritySchema,
	TaskMetadataSchema,
	TaskCollectionSchema,
	TaskSourceConfigSchema,
} from "../schemas/tasks.schema";

export type {
	Task,
	TaskStatus,
	TaskPriority,
	TaskMetadata,
	TaskCollection,
	TaskSourceConfig,
} from "../schemas/tasks.schema";

// ============================================================================
// Legacy Types (for backward compatibility)
// ============================================================================

// Legacy types from types.ts - only export what's actually used
export type {
	Task as LegacyTask,
	TaskSource as LegacyTaskSource,
	TaskSourceType,
} from "./types";

export {
	PRIORITY_WEIGHTS,
	STATUS_WEIGHTS,
} from "./types";

// ============================================================================
// Backward Compatibility Adapter
// ============================================================================

import type { Task as NewTask } from "../schemas/tasks.schema";
import type { TaskSourceConfig } from "../schemas/tasks.schema";
import { createTaskSource as newCreateTaskSource } from "./runtime/factory";
import type {
	TaskSourceType as LegacySourceType,
	TaskSource as LegacyTaskSourceType,
	Task as LegacyTaskType,
} from "./types";

/**
 * Convert new Task to legacy format
 */
function toLegacyTask(task: NewTask): LegacyTaskType {
	return {
		id: task.id,
		title: task.title,
		body: task.description,
		parallelGroup: task.metadata.parallelGroup,
		completed: task.status === "completed",
	};
}

/**
 * Adapter to wrap new source as legacy source
 */
class LegacySourceAdapter implements LegacyTaskSourceType {
	type: LegacySourceType;
	private source: ReturnType<typeof newCreateTaskSource>;

	constructor(source: ReturnType<typeof newCreateTaskSource>, type: LegacySourceType) {
		this.source = source;
		this.type = type;
	}

	async getAllTasks(): Promise<LegacyTaskType[]> {
		const collection = await this.source.load();
		return collection.tasks.filter((t) => t.status !== "completed").map(toLegacyTask);
	}

	async getNextTask(): Promise<LegacyTaskType | null> {
		const tasks = await this.getAllTasks();
		return tasks[0] || null;
	}

	async markComplete(id: string): Promise<void> {
		await this.source.updateStatus(id, "completed");
	}

	async countRemaining(): Promise<number> {
		const stats = await this.source.getStats();
		return stats.pending + stats.inProgress + stats.failed;
	}

	async countCompleted(): Promise<number> {
		const stats = await this.source.getStats();
		return stats.completed;
	}

	async getTasksInGroup(group: number): Promise<LegacyTaskType[]> {
		const collection = await this.source.load();
		return collection.tasks
			.filter((t) => t.metadata.parallelGroup === group && t.status !== "completed")
			.map(toLegacyTask);
	}
}

/**
 * @deprecated Use createTaskSource from runtime/factory instead
 * Creates a task source with legacy API compatibility
 */
interface LegacyTaskSourceOptions {
	type: LegacySourceType;
	filePath?: string;
	repo?: string;
	label?: string;
}

/**
 * @deprecated Use createTaskSource from runtime/factory instead
 * Creates a task source with legacy API compatibility
 */
export function createLegacyTaskSource(options: LegacyTaskSourceOptions): LegacyTaskSourceType {
	console.warn(
		"[DEPRECATION WARNING] createLegacyTaskSource is deprecated. " +
			"Use createTaskSource from tasks/runtime/factory instead.",
	);

	const config: TaskSourceConfig = {
		type: options.type,
		path: options.filePath,
		options: options.repo ? { repo: options.repo, filterLabel: options.label } : undefined,
	};

	const source = newCreateTaskSource(config);
	return new LegacySourceAdapter(source, options.type);
}
