/**
 * Milhouse YAML Task Source
 *
 * Reads tasks from YAML files with rich metadata support and provides
 * Milhouse-specific features including:
 * - Task provenance tracking
 * - Schema validation with Zod
 * - Complexity estimation
 * - Engine hints extraction
 *
 * @module tasks/sources/yaml
 * @since 1.0.0
 */

import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import { bus } from "../../events";
import type { TaskPriority, TaskStatus } from "../../schemas/tasks.schema";
import type { ITaskSource, TaskSourceConfig } from "../core/types";
import {
	COMPLEXITY_TIME_ESTIMATES,
	type ComplexityEstimate,
	type EngineHints,
	type EngineType,
	type ExpectedArtifact,
	type IMilhouseTaskSource,
	MILHOUSE_TASK_SCHEMA_VERSION,
	type MilhouseLoadOptions,
	type MilhouseSourceConfig,
	type MilhouseSourceStats,
	type MilhouseTask,
	type MilhouseTaskCollection,
	type MilhouseTaskMetadata,
	MilhouseTaskSchema,
	type TaskComplexity,
	type TaskProvenance,
	type ValidationResult,
} from "./types";

// ============================================================================
// Zod Schemas for YAML Task Format
// ============================================================================

/**
 * Schema for expected artifacts in YAML format
 */
const YamlArtifactSchema = z.object({
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
	required: z.boolean().optional().default(true),
});

/**
 * Schema for engine hints in YAML format
 */
const YamlEngineHintsSchema = z.object({
	preferred: z
		.array(z.enum(["claude", "codex", "aider", "cursor", "gemini", "qwen", "droid", "opencode"]))
		.optional(),
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
});

/**
 * Schema for individual YAML task
 */
const YamlTaskSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	completed: z.boolean().optional().default(false),
	status: z
		.enum(["pending", "in_progress", "completed", "failed", "skipped", "blocked"])
		.optional(),
	priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
	parallel_group: z.number().optional(),
	labels: z.array(z.string()).optional().default([]),
	dependencies: z.array(z.string()).optional().default([]),
	assignee: z.string().optional(),
	due_date: z.string().optional(),
	estimated_effort: z.string().optional(),
	// Milhouse-specific extensions
	complexity: z.enum(["trivial", "simple", "medium", "complex", "epic"]).optional(),
	engine_hints: YamlEngineHintsSchema.optional(),
	expected_artifacts: z.array(YamlArtifactSchema).optional(),
	custom: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for YAML task file
 */
const YamlTaskFileSchema = z.object({
	tasks: z.array(YamlTaskSchema),
	metadata: z
		.object({
			version: z.string().optional(),
			project: z.string().optional(),
			description: z.string().optional(),
			default_priority: z.enum(["critical", "high", "medium", "low"]).optional(),
			default_engine_hints: YamlEngineHintsSchema.optional(),
		})
		.optional(),
});

type YamlTask = z.infer<typeof YamlTaskSchema>;
type YamlTaskFile = z.infer<typeof YamlTaskFileSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate SHA-256 hash of content for change detection
 */
function generateContentHash(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/**
 * Create URL-safe slug from title
 */
function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
}

/**
 * Estimate complexity based on task title and metadata
 */
function estimateComplexity(
	title: string,
	hasArtifacts: boolean,
	hasDependencies: boolean,
): ComplexityEstimate {
	const lowerTitle = title.toLowerCase();
	let level: TaskComplexity = "medium";
	let confidence = 0.5;
	const factors: string[] = [];

	// Simple heuristics for complexity estimation
	if (lowerTitle.includes("fix") || lowerTitle.includes("typo") || lowerTitle.includes("update")) {
		level = "simple";
		confidence = 0.7;
		factors.push("contains simple action verb");
	} else if (
		lowerTitle.includes("refactor") ||
		lowerTitle.includes("redesign") ||
		lowerTitle.includes("migrate")
	) {
		level = "complex";
		confidence = 0.6;
		factors.push("contains complex action verb");
	} else if (
		lowerTitle.includes("implement") ||
		lowerTitle.includes("create") ||
		lowerTitle.includes("build")
	) {
		level = "medium";
		confidence = 0.6;
		factors.push("contains implementation verb");
	}

	if (hasArtifacts) {
		factors.push("has expected artifacts");
		confidence += 0.1;
	}

	if (hasDependencies) {
		factors.push("has dependencies");
		if (level === "simple") level = "medium";
	}

	return {
		level,
		confidence: Math.min(confidence, 1),
		estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[level],
		factors,
	};
}

// ============================================================================
// YamlTaskSource Class
// ============================================================================

/**
 * YamlTaskSource - Milhouse implementation for reading tasks from YAML files
 *
 * @description Reads tasks from YAML files with rich metadata support.
 * Validates input using Zod schemas and provides comprehensive task management.
 *
 * YAML Format:
 * ```yaml
 * metadata:
 *   version: "1.0"
 *   project: "My Project"
 *   default_priority: medium
 *
 * tasks:
 *   - title: "Task description"
 *     description: "Detailed description"
 *     status: pending
 *     priority: high
 *     parallel_group: 1
 *     labels: [feature, backend]
 *     dependencies: [task-1]
 *     complexity: medium
 *     engine_hints:
 *       preferred: [claude, codex]
 *     expected_artifacts:
 *       - type: file
 *         pattern: "src/*.ts"
 *         required: true
 * ```
 *
 * @example
 * ```typescript
 * const source = new YamlTaskSource({
 *   type: "yaml",
 *   path: "./tasks.yaml",
 *   trackProvenance: true,
 *   validation: { validateOnLoad: true, strict: true }
 * });
 *
 * const collection = await source.load();
 * const validation = await source.validate();
 * ```
 */
export class YamlTaskSource implements IMilhouseTaskSource, ITaskSource {
	readonly name = "yaml";
	readonly config: MilhouseSourceConfig;
	private filePath: string;
	private cachedCollection: MilhouseTaskCollection | null = null;
	private lastLoadTime = 0;
	private fileMetadata: YamlTaskFile["metadata"] | null = null;

	/**
	 * Create a new YamlTaskSource
	 *
	 * @param config - Source configuration
	 */
	constructor(config: TaskSourceConfig | MilhouseSourceConfig) {
		this.config = {
			...config,
			trackProvenance: (config as MilhouseSourceConfig).trackProvenance ?? true,
			estimateComplexity: (config as MilhouseSourceConfig).estimateComplexity ?? true,
		};
		this.filePath = config.path || "tasks.yaml";
	}

	/**
	 * Load and validate tasks from YAML file
	 *
	 * @param options - Load options for filtering and pagination
	 * @returns Task collection with provenance
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

		const file = Bun.file(this.filePath);
		const content = await file.text();
		const parsed = YAML.parse(content);

		// Validate with Zod
		const validated = YamlTaskFileSchema.parse(parsed);
		this.fileMetadata = validated.metadata;

		const tasks = this.convertToTasks(validated.tasks, content);

		// Apply filtering and sorting
		let filteredTasks = tasks;
		let filteredCount = 0;

		if (options) {
			const originalCount = tasks.length;
			filteredTasks = this.filterTasks(tasks, options);
			filteredCount = originalCount - filteredTasks.length;
			filteredTasks = this.sortTasks(filteredTasks, options);
			filteredTasks = this.paginateTasks(filteredTasks, options);
		}

		this.cachedCollection = {
			tasks: filteredTasks,
			source: this.filePath,
			lastSynced: new Date().toISOString(),
			collectionMetadata: {
				totalDiscovered: tasks.length,
				filteredCount,
				filterCriteria: this.getFilterCriteria(options),
				schemaVersion: MILHOUSE_TASK_SCHEMA_VERSION,
			},
		};

		this.lastLoadTime = Date.now();
		return this.cachedCollection;
	}

	/**
	 * Convert YAML tasks to Milhouse task format
	 */
	private convertToTasks(yamlTasks: YamlTask[], rawContent: string): MilhouseTask[] {
		const discoveredAt = new Date().toISOString();
		const defaultPriority = this.fileMetadata?.default_priority || "medium";
		const defaultEngineHints = this.fileMetadata?.default_engine_hints;

		return yamlTasks.map((yamlTask, index) => {
			// Determine status from completed flag or explicit status
			let status: TaskStatus = "pending";
			if (yamlTask.status) {
				status = yamlTask.status;
			} else if (yamlTask.completed) {
				status = "completed";
			}

			// Build provenance if tracking is enabled
			const provenance: TaskProvenance | undefined = this.config.trackProvenance
				? {
						sourceKind: "yaml",
						sourcePath: this.filePath,
						discoveredAt,
						lastSyncedAt: discoveredAt,
						contentHash: generateContentHash(JSON.stringify(yamlTask)),
						version: 1,
					}
				: undefined;

			// Build complexity estimate
			const complexity: ComplexityEstimate | undefined = this.config.estimateComplexity
				? yamlTask.complexity
					? {
							level: yamlTask.complexity,
							confidence: 1,
							estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[yamlTask.complexity],
							factors: ["explicitly specified in YAML"],
						}
					: estimateComplexity(
							yamlTask.title,
							(yamlTask.expected_artifacts?.length || 0) > 0,
							(yamlTask.dependencies?.length || 0) > 0,
						)
				: undefined;

			// Build engine hints
			const engineHints: EngineHints | undefined =
				yamlTask.engine_hints || defaultEngineHints
					? {
							preferred:
								yamlTask.engine_hints?.preferred ||
								defaultEngineHints?.preferred ||
								([] as EngineType[]),
							excluded: yamlTask.engine_hints?.excluded || defaultEngineHints?.excluded,
							requirements: yamlTask.engine_hints?.requirements || defaultEngineHints?.requirements,
						}
					: undefined;

			// Build expected artifacts
			const expectedArtifacts: ExpectedArtifact[] | undefined = yamlTask.expected_artifacts?.map(
				(artifact) => ({
					type: artifact.type,
					pattern: artifact.pattern,
					description: artifact.description,
					required: artifact.required,
				}),
			);

			// Build metadata
			const metadata: MilhouseTaskMetadata = {
				source: "yaml",
				sourceFile: this.filePath,
				parallelGroup: yamlTask.parallel_group,
				dependencies: yamlTask.dependencies || [],
				labels: yamlTask.labels || [],
				assignee: yamlTask.assignee,
				dueDate: yamlTask.due_date,
				estimatedEffort: yamlTask.estimated_effort,
				provenance,
				complexity,
				engineHints,
				expectedArtifacts,
				custom: yamlTask.custom,
			};

			return {
				id: `yaml-${index}-${slugify(yamlTask.title)}`,
				title: yamlTask.title,
				description: yamlTask.description,
				status,
				priority: (yamlTask.priority || defaultPriority) as TaskPriority,
				metadata,
			};
		});
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
	 * Update task status in YAML file
	 *
	 * @param taskId - Task identifier
	 * @param status - New status
	 */
	async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
		const file = Bun.file(this.filePath);
		const content = await file.text();
		const parsed = YAML.parse(content) as YamlTaskFile;

		// Find task by matching the ID pattern
		const collection = await this.load({ includeCompleted: true, forceRefresh: true });
		const task = collection.tasks.find((t) => t.id === taskId);

		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Find the YAML task by title
		const yamlTask = parsed.tasks.find((t) => t.title === task.title);

		if (yamlTask) {
			// Update status
			yamlTask.status = status;
			yamlTask.completed = status === "completed";

			// Write back to file with preserved formatting
			await Bun.write(this.filePath, YAML.stringify(parsed));

			// Emit event
			bus.emit("task:complete", {
				taskId,
				duration: 0,
				success: status === "completed",
			});

			// Invalidate cache
			this.cachedCollection = null;
		}
	}

	/**
	 * Check if YAML file exists
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const file = Bun.file(this.filePath);
			return await file.exists();
		} catch {
			return false;
		}
	}

	/**
	 * Get task statistics
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
	 * Refresh cache
	 */
	async refresh(): Promise<void> {
		this.cachedCollection = null;
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

			if (!task.metadata.complexity) {
				result.warnings.push({
					code: "MISSING_COMPLEXITY",
					message: "Task is missing complexity estimate",
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

		// For YAML, we can persist some metadata back to the file
		await this.persistMetadataToFile(task);
	}

	/**
	 * Persist task metadata back to YAML file
	 */
	private async persistMetadataToFile(task: MilhouseTask): Promise<void> {
		const file = Bun.file(this.filePath);
		const content = await file.text();
		const parsed = YAML.parse(content) as YamlTaskFile;

		const yamlTask = parsed.tasks.find((t) => t.title === task.title);

		if (yamlTask) {
			// Update supported YAML fields
			yamlTask.labels = task.metadata.labels;
			yamlTask.dependencies = task.metadata.dependencies;
			yamlTask.assignee = task.metadata.assignee;
			yamlTask.due_date = task.metadata.dueDate;
			yamlTask.estimated_effort = task.metadata.estimatedEffort;
			yamlTask.complexity = task.metadata.complexity?.level;
			yamlTask.custom = task.metadata.custom as Record<string, unknown>;

			if (task.metadata.engineHints) {
				yamlTask.engine_hints = {
					preferred: task.metadata.engineHints.preferred,
					excluded: task.metadata.engineHints.excluded,
					requirements: task.metadata.engineHints.requirements,
				};
			}

			if (task.metadata.expectedArtifacts) {
				yamlTask.expected_artifacts = task.metadata.expectedArtifacts.map((a) => ({
					type: a.type,
					pattern: a.pattern,
					description: a.description,
					required: a.required,
				}));
			}

			await Bun.write(this.filePath, YAML.stringify(parsed));
			this.cachedCollection = null;
		}
	}

	/**
	 * Get tasks by parallel group
	 *
	 * @param group - Parallel group number
	 */
	async getTasksByGroup(group: number): Promise<MilhouseTask[]> {
		const collection = await this.load({ includeCompleted: true });
		return collection.tasks.filter((t) => t.metadata.parallelGroup === group);
	}

	/**
	 * Get all unique parallel groups
	 */
	async getGroups(): Promise<number[]> {
		const collection = await this.load({ includeCompleted: true });
		const groups = new Set<number>();

		for (const task of collection.tasks) {
			if (task.metadata.parallelGroup !== undefined) {
				groups.add(task.metadata.parallelGroup);
			}
		}

		return Array.from(groups).sort((a, b) => a - b);
	}

	/**
	 * Add a new task to the YAML file
	 *
	 * @param task - Task data to add
	 */
	async addTask(task: Omit<YamlTask, "completed">): Promise<string> {
		const file = Bun.file(this.filePath);
		const content = await file.text();
		const parsed = YAML.parse(content) as YamlTaskFile;

		parsed.tasks.push({
			...task,
			completed: false,
		});

		await Bun.write(this.filePath, YAML.stringify(parsed));
		this.cachedCollection = null;

		// Return the new task ID
		return `yaml-${parsed.tasks.length - 1}-${slugify(task.title)}`;
	}

	/**
	 * Remove a task from the YAML file
	 *
	 * @param taskId - Task identifier
	 */
	async removeTask(taskId: string): Promise<void> {
		const file = Bun.file(this.filePath);
		const content = await file.text();
		const parsed = YAML.parse(content) as YamlTaskFile;

		const collection = await this.load({ includeCompleted: true });
		const task = collection.tasks.find((t) => t.id === taskId);

		if (task) {
			parsed.tasks = parsed.tasks.filter((t) => t.title !== task.title);
			await Bun.write(this.filePath, YAML.stringify(parsed));
			this.cachedCollection = null;
		}
	}

	/**
	 * Get file metadata
	 */
	getFileMetadata(): YamlTaskFile["metadata"] | null {
		return this.fileMetadata;
	}

	/**
	 * Get file path
	 */
	getFilePath(): string {
		return this.filePath;
	}
}
