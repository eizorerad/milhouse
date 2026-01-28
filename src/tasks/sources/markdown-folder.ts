/**
 * Milhouse Markdown Folder Task Source
 *
 * Discovers and aggregates tasks from multiple markdown files in a directory.
 * Provides Milhouse-specific features including:
 * - Task provenance tracking across multiple files
 * - Schema validation
 * - Aggregated statistics
 * - File-level grouping
 *
 * @module tasks/sources/markdown-folder
 * @since 1.0.0
 */

import { basename, resolve } from "node:path";
import { globby } from "globby";
import type { TaskStatus } from "../../schemas/tasks.schema";
import type { ITaskSource, TaskSourceConfig } from "../core/types";
import { MarkdownTaskSource } from "./markdown";
import {
	type IMilhouseTaskSource,
	MILHOUSE_TASK_SCHEMA_VERSION,
	type MilhouseLoadOptions,
	type MilhouseSourceConfig,
	type MilhouseSourceStats,
	type MilhouseTask,
	type MilhouseTaskCollection,
	type MilhouseTaskMetadata,
	MilhouseTaskSchema,
	type ValidationResult,
} from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * File discovery result with metadata
 */
interface DiscoveredFile {
	/** Absolute path to the file */
	path: string;
	/** File name without extension */
	name: string;
	/** Relative path from folder root */
	relativePath: string;
}

/**
 * Aggregated file statistics
 */
interface FileStats {
	/** File path */
	path: string;
	/** Number of tasks in file */
	taskCount: number;
	/** Number of completed tasks */
	completedCount: number;
	/** Number of pending tasks */
	pendingCount: number;
}

// ============================================================================
// MarkdownFolderTaskSource Class
// ============================================================================

/**
 * MarkdownFolderTaskSource - Milhouse implementation for aggregating tasks from multiple markdown files
 *
 * @description Discovers markdown files using globby patterns and aggregates tasks
 * from all discovered files. Provides unified task management across multiple files
 * with proper provenance tracking.
 *
 * Features:
 * - Glob-based file discovery
 * - Unified task collection across files
 * - Per-file statistics
 * - Task grouping by source file
 * - Provenance tracking with file context
 *
 * @example
 * ```typescript
 * const source = new MarkdownFolderTaskSource({
 *   type: "markdown-folder",
 *   path: "./docs",
 *   patterns: ["**​/*.md", "!**​/node_modules/**"],
 *   trackProvenance: true
 * });
 *
 * const collection = await source.load();
 * const byFile = await source.getTasksByFile();
 * ```
 */
export class MarkdownFolderTaskSource implements IMilhouseTaskSource, ITaskSource {
	readonly name = "markdown-folder";
	readonly config: MilhouseSourceConfig;
	private folderPath: string;
	private patterns: string[];
	private cachedCollection: MilhouseTaskCollection | null = null;
	private discoveredFiles: DiscoveredFile[] = [];
	private lastLoadTime = 0;

	/**
	 * Create a new MarkdownFolderTaskSource
	 *
	 * @param config - Source configuration
	 */
	constructor(config: TaskSourceConfig | MilhouseSourceConfig) {
		this.config = {
			...config,
			trackProvenance: (config as MilhouseSourceConfig).trackProvenance ?? true,
			estimateComplexity: (config as MilhouseSourceConfig).estimateComplexity ?? true,
		};
		this.folderPath = config.path || ".";
		this.patterns = config.patterns || ["**/*.md", "!**/node_modules/**", "!**/.git/**"];
	}

	/**
	 * Load all tasks from discovered markdown files
	 *
	 * @param options - Load options for filtering and pagination
	 * @returns Aggregated task collection with provenance
	 */
	async load(options?: MilhouseLoadOptions): Promise<MilhouseTaskCollection> {
		// Check cache validity
		if (
			!options?.forceRefresh &&
			this.cachedCollection &&
			this.config.cache?.enabled &&
			Date.now() - this.lastLoadTime < (this.config.cache.ttlSeconds ?? 60) * 1000
		) {
			return this.applyLoadOptions(this.cachedCollection, options);
		}

		// Discover markdown files using globby
		await this.discoverFiles();

		const allTasks: MilhouseTask[] = [];
		let globalIndex = 0;
		const discoveredAt = new Date().toISOString();

		for (const file of this.discoveredFiles) {
			const source = new MarkdownTaskSource({
				type: "markdown",
				path: file.path,
				trackProvenance: this.config.trackProvenance,
				estimateComplexity: this.config.estimateComplexity,
				defaultEngineHints: this.config.defaultEngineHints,
			});

			if (await source.isAvailable()) {
				const collection = await source.load({ includeCompleted: true });

				// Re-map task IDs with folder context for uniqueness
				const filePrefix = this.getFilePrefix(file.name);
				const tasks = collection.tasks.map((task) => ({
					...task,
					id: `${filePrefix}-${globalIndex++}`,
					metadata: {
						...task.metadata,
						sourceFile: file.path,
						provenance: task.metadata.provenance
							? {
									...task.metadata.provenance,
									sourcePath: file.relativePath,
								}
							: undefined,
						custom: {
							...task.metadata.custom,
							folderSource: this.folderPath,
							originalId: task.id,
						},
					},
				}));

				allTasks.push(...tasks);
			}
		}

		// Apply filtering and sorting
		let filteredTasks = allTasks;
		let filteredCount = 0;

		if (options) {
			const originalCount = allTasks.length;
			filteredTasks = this.filterTasks(allTasks, options);
			filteredCount = originalCount - filteredTasks.length;
			filteredTasks = this.sortTasks(filteredTasks, options);
			filteredTasks = this.paginateTasks(filteredTasks, options);
		}

		this.cachedCollection = {
			tasks: filteredTasks,
			source: this.folderPath,
			lastSynced: discoveredAt,
			collectionMetadata: {
				totalDiscovered: allTasks.length,
				filteredCount,
				filterCriteria: this.getFilterCriteria(options),
				schemaVersion: MILHOUSE_TASK_SCHEMA_VERSION,
			},
		};

		this.lastLoadTime = Date.now();
		return this.cachedCollection;
	}

	/**
	 * Discover markdown files in the folder
	 */
	private async discoverFiles(): Promise<void> {
		const absolutePaths = await globby(this.patterns, {
			cwd: this.folderPath,
			absolute: true,
			onlyFiles: true,
		});

		this.discoveredFiles = absolutePaths.map((absPath) => ({
			path: absPath,
			name: basename(absPath, ".md"),
			relativePath: absPath.replace(resolve(this.folderPath) + "/", ""),
		}));

		// Sort for consistent ordering
		this.discoveredFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	}

	/**
	 * Get a unique prefix from file name
	 */
	private getFilePrefix(fileName: string): string {
		return fileName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
	}

	/**
	 * Filter tasks based on load options
	 */
	private filterTasks(tasks: MilhouseTask[], options: MilhouseLoadOptions): MilhouseTask[] {
		return tasks.filter((task) => {
			if (!options.includeCompleted && task.status === "completed") {
				return false;
			}
			if (options.statusFilter && !options.statusFilter.includes(task.status)) {
				return false;
			}
			if (options.priorityFilter && !options.priorityFilter.includes(task.priority)) {
				return false;
			}
			if (options.labelFilter) {
				const hasMatchingLabel = options.labelFilter.some((label) =>
					task.metadata.labels.includes(label),
				);
				if (!hasMatchingLabel) return false;
			}
			return true;
		});
	}

	/**
	 * Sort tasks based on load options
	 */
	private sortTasks(tasks: MilhouseTask[], options: MilhouseLoadOptions): MilhouseTask[] {
		if (!options.sortBy) return tasks;

		const direction = options.sortDirection === "desc" ? -1 : 1;

		return [...tasks].sort((a, b) => {
			switch (options.sortBy) {
				case "priority": {
					const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
					return (priorityOrder[b.priority] - priorityOrder[a.priority]) * direction;
				}
				case "createdAt":
					return (a.createdAt || "").localeCompare(b.createdAt || "") * direction;
				case "title":
					return a.title.localeCompare(b.title) * direction;
				case "complexity": {
					const complexityOrder = { trivial: 1, simple: 2, medium: 3, complex: 4, epic: 5 };
					const aLevel = a.metadata.complexity?.level || "medium";
					const bLevel = b.metadata.complexity?.level || "medium";
					return (complexityOrder[aLevel] - complexityOrder[bLevel]) * direction;
				}
				default:
					return 0;
			}
		});
	}

	/**
	 * Paginate tasks based on load options
	 */
	private paginateTasks(tasks: MilhouseTask[], options: MilhouseLoadOptions): MilhouseTask[] {
		const offset = options.offset || 0;
		const limit = options.limit;

		if (limit !== undefined) {
			return tasks.slice(offset, offset + limit);
		}
		return tasks.slice(offset);
	}

	/**
	 * Get filter criteria description for metadata
	 */
	private getFilterCriteria(options?: MilhouseLoadOptions): string[] | undefined {
		if (!options) return undefined;

		const criteria: string[] = [];
		if (options.statusFilter) criteria.push(`status in [${options.statusFilter.join(", ")}]`);
		if (options.priorityFilter) criteria.push(`priority in [${options.priorityFilter.join(", ")}]`);
		if (options.labelFilter) criteria.push(`labels include [${options.labelFilter.join(", ")}]`);
		if (!options.includeCompleted) criteria.push("excludes completed");

		return criteria.length > 0 ? criteria : undefined;
	}

	/**
	 * Apply load options to cached collection
	 */
	private applyLoadOptions(
		collection: MilhouseTaskCollection,
		options?: MilhouseLoadOptions,
	): MilhouseTaskCollection {
		if (!options) return collection;

		let tasks = this.filterTasks(collection.tasks, options);
		tasks = this.sortTasks(tasks, options);
		tasks = this.paginateTasks(tasks, options);

		return {
			...collection,
			tasks,
			collectionMetadata: {
				...collection.collectionMetadata!,
				filteredCount: collection.tasks.length - tasks.length,
				filterCriteria: this.getFilterCriteria(options),
			},
		};
	}

	/**
	 * Update task status - delegates to appropriate file source
	 *
	 * @param taskId - Task identifier
	 * @param status - New status
	 */
	async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
		// Find the task to get its source file
		const collection = await this.load({ includeCompleted: true });
		const task = collection.tasks.find((t) => t.id === taskId);

		if (!task || !task.metadata.sourceFile) {
			throw new Error(`Task not found or missing source file: ${taskId}`);
		}

		// Create a source for the specific file
		const fileSource = new MarkdownTaskSource({
			type: "markdown",
			path: task.metadata.sourceFile,
			trackProvenance: this.config.trackProvenance,
		});

		// Find the original task ID in that file (by line number)
		const fileCollection = await fileSource.load({ includeCompleted: true });
		const originalTask = fileCollection.tasks.find(
			(t) => t.metadata.lineNumber === task.metadata.lineNumber,
		);

		if (originalTask) {
			await fileSource.updateStatus(originalTask.id, status);
		}

		// Invalidate cache
		this.cachedCollection = null;
	}

	/**
	 * Check if folder exists and contains markdown files
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const files = await globby(this.patterns, {
				cwd: this.folderPath,
				absolute: true,
				onlyFiles: true,
			});
			return files.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Get aggregated statistics from all files
	 */
	async getStats(): Promise<MilhouseSourceStats> {
		const collection = await this.load({ includeCompleted: true });
		const stats: MilhouseSourceStats = {
			total: collection.tasks.length,
			pending: 0,
			completed: 0,
			failed: 0,
			inProgress: 0,
			skipped: 0,
			blocked: 0,
			byComplexity: {
				trivial: 0,
				simple: 0,
				medium: 0,
				complex: 0,
				epic: 0,
			},
			byPriority: {
				critical: 0,
				high: 0,
				medium: 0,
				low: 0,
			},
			byLabel: {},
		};

		for (const task of collection.tasks) {
			// Count by status
			switch (task.status) {
				case "pending":
					stats.pending++;
					break;
				case "completed":
					stats.completed++;
					break;
				case "failed":
					stats.failed++;
					break;
				case "in_progress":
					stats.inProgress++;
					break;
				case "skipped":
					stats.skipped++;
					break;
				case "blocked":
					stats.blocked++;
					break;
			}

			// Count by complexity
			if (task.metadata.complexity && stats.byComplexity) {
				stats.byComplexity[task.metadata.complexity.level]++;
			}

			// Count by priority
			if (stats.byPriority) {
				stats.byPriority[task.priority]++;
			}

			// Count by label
			if (stats.byLabel) {
				for (const label of task.metadata.labels) {
					stats.byLabel[label] = (stats.byLabel[label] || 0) + 1;
				}
			}
		}

		// Calculate completion rate
		stats.completionRate = stats.total > 0 ? stats.completed / stats.total : 0;

		return stats;
	}

	/**
	 * Refresh by re-discovering files and reloading
	 */
	async refresh(): Promise<void> {
		this.cachedCollection = null;
		this.discoveredFiles = [];
		await this.load({ forceRefresh: true });
	}

	/**
	 * Validate tasks against Milhouse schema
	 */
	async validate(): Promise<ValidationResult> {
		const collection = await this.load({ includeCompleted: true, forceRefresh: true });
		const result: ValidationResult = {
			valid: true,
			errors: [],
			warnings: [],
			validTasks: [],
			invalidTasks: [],
		};

		for (const task of collection.tasks) {
			const parseResult = MilhouseTaskSchema.safeParse(task);

			if (parseResult.success) {
				result.validTasks.push(task);
			} else {
				result.valid = false;
				const zodErrors = parseResult.error.issues.map((issue) => ({
					code: issue.code,
					message: issue.message,
					path: issue.path.map(String),
					taskId: task.id,
				}));
				result.errors.push(...zodErrors);
				result.invalidTasks.push({ task, errors: zodErrors });
			}

			// Add warnings for potential issues
			if (!task.metadata.provenance) {
				result.warnings.push({
					code: "MISSING_PROVENANCE",
					message: "Task is missing provenance tracking",
					taskId: task.id,
				});
			}
		}

		return result;
	}

	/**
	 * Get a specific task by ID
	 *
	 * @param taskId - Task identifier
	 */
	async getTask(taskId: string): Promise<MilhouseTask | null> {
		const collection = await this.load({ includeCompleted: true });
		return collection.tasks.find((t) => t.id === taskId) || null;
	}

	/**
	 * Update task metadata
	 *
	 * @param taskId - Task identifier
	 * @param metadata - Partial metadata to merge
	 */
	async updateMetadata(taskId: string, metadata: Partial<MilhouseTaskMetadata>): Promise<void> {
		const collection = await this.load({ includeCompleted: true });
		const task = collection.tasks.find((t) => t.id === taskId);

		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Merge metadata
		Object.assign(task.metadata, metadata);

		// Update provenance version
		if (task.metadata.provenance) {
			task.metadata.provenance.version++;
			task.metadata.provenance.lastSyncedAt = new Date().toISOString();
		}
	}

	/**
	 * Get list of discovered markdown files
	 */
	getDiscoveredFiles(): DiscoveredFile[] {
		return [...this.discoveredFiles];
	}

	/**
	 * Get tasks grouped by source file
	 *
	 * @returns Map of file path to tasks
	 */
	async getTasksByFile(): Promise<Map<string, MilhouseTask[]>> {
		const collection = await this.load({ includeCompleted: true });
		const byFile = new Map<string, MilhouseTask[]>();

		for (const task of collection.tasks) {
			const file = task.metadata.sourceFile || "unknown";
			if (!byFile.has(file)) {
				byFile.set(file, []);
			}
			byFile.get(file)?.push(task);
		}

		return byFile;
	}

	/**
	 * Get statistics per file
	 *
	 * @returns Array of file statistics
	 */
	async getFileStats(): Promise<FileStats[]> {
		const byFile = await this.getTasksByFile();
		const stats: FileStats[] = [];

		for (const [path, tasks] of byFile) {
			stats.push({
				path,
				taskCount: tasks.length,
				completedCount: tasks.filter((t) => t.status === "completed").length,
				pendingCount: tasks.filter((t) => t.status === "pending").length,
			});
		}

		return stats.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * Get file count
	 */
	getFileCount(): number {
		return this.discoveredFiles.length;
	}

	/**
	 * Get folder path
	 */
	getFolderPath(): string {
		return this.folderPath;
	}

	/**
	 * Get glob patterns used for discovery
	 */
	getPatterns(): string[] {
		return [...this.patterns];
	}
}
