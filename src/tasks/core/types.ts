import type {
	Task,
	TaskCollection,
	TaskSourceConfig,
	TaskStatus,
} from "../../schemas/tasks.schema";

// Re-export schema types for convenience
export type { Task, TaskStatus, TaskCollection, TaskSourceConfig };

// Task source statistics for monitoring
export interface TaskSourceStats {
	total: number;
	pending: number;
	completed: number;
	failed: number;
	inProgress: number;
	skipped: number;
	blocked: number;
}

// Task filter criteria for querying
export interface TaskFilter {
	status?: TaskStatus[];
	priority?: string[];
	parallelGroup?: number;
	labels?: string[];
	search?: string;
	sourceFile?: string;
}

// Task sort options
export interface TaskSort {
	field: "priority" | "createdAt" | "title" | "parallelGroup" | "status";
	direction: "asc" | "desc";
}

// Task source interface - adapter pattern for different sources
export interface ITaskSource {
	readonly name: string;
	readonly config: TaskSourceConfig;

	// Load all tasks from source
	load(): Promise<TaskCollection>;

	// Update task status in source
	updateStatus(taskId: string, status: TaskStatus): Promise<void>;

	// Check if source is available/accessible
	isAvailable(): Promise<boolean>;

	// Get source statistics
	getStats(): Promise<TaskSourceStats>;

	// Refresh/reload from source
	refresh?(): Promise<void>;
}

// Task source factory function type
export type TaskSourceFactory = (config: TaskSourceConfig) => ITaskSource;

// Task sync result
export interface TaskSyncResult {
	added: number;
	updated: number;
	removed: number;
	errors: string[];
}

// Task execution context
export interface TaskExecutionContext {
	taskId: string;
	startedAt: Date;
	source: string;
	parallelGroup?: number;
}

// Priority weight mapping for sorting
export const PRIORITY_WEIGHTS: Record<string, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
};

// Status weight mapping for sorting
export const STATUS_WEIGHTS: Record<TaskStatus, number> = {
	in_progress: 5,
	pending: 4,
	blocked: 3,
	failed: 2,
	skipped: 1,
	completed: 0,
};
