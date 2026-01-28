/**
 * Milhouse Markdown Task Source
 *
 * Reads tasks from markdown files with checkbox format and provides
 * Milhouse-specific features including:
 * - Task provenance tracking
 * - Schema validation
 * - Complexity estimation
 * - Engine hints extraction
 *
 * @module tasks/sources/markdown
 * @since 1.0.0
 */

import { createHash } from "node:crypto";
import { bus } from "../../events";
import type { TaskStatus } from "../../schemas/tasks.schema";
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
// Regex Patterns for Markdown Parsing
// ============================================================================

/** Pattern for matching checkbox items */
const CHECKBOX_PATTERN = /^(\s*)-\s*\[([ xX])\]\s+(.+)$/;

/** Pattern for extracting parallel group: @group(n) */
const PARALLEL_GROUP_PATTERN = /@group\((\d+)\)/;

/** Pattern for extracting priority: @priority(level) */
const PRIORITY_PATTERN = /@priority\((critical|high|medium|low)\)/i;

/** Pattern for extracting labels: @label(name) */
const LABEL_PATTERN = /@label\(([^)]+)\)/g;

/** Pattern for extracting complexity: @complexity(level) */
const COMPLEXITY_PATTERN = /@complexity\((trivial|simple|medium|complex|epic)\)/i;

/** Pattern for extracting engine hints: @engine(name) */
const ENGINE_PATTERN = /@engine\(([^)]+)\)/g;

/** Pattern for extracting expected artifacts: @artifact(type:pattern) */
const ARTIFACT_PATTERN = /@artifact\(([^:]+):([^)]+)\)/g;

/** Pattern for extracting dependencies: @depends(id) */
const DEPENDS_PATTERN = /@depends\(([^)]+)\)/g;

/** Pattern for extracting assignee: @assignee(name) */
const ASSIGNEE_PATTERN = /@assignee\(([^)]+)\)/;

/** Pattern for extracting due date: @due(date) */
const DUE_DATE_PATTERN = /@due\(([^)]+)\)/;

/** Pattern for extracting estimated effort: @effort(time) */
const EFFORT_PATTERN = /@effort\(([^)]+)\)/;

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
 * Estimate complexity based on task title and metadata
 */
function estimateComplexity(title: string, hasArtifacts: boolean): ComplexityEstimate {
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

	// Adjust based on title length (longer titles often indicate more complex tasks)
	if (title.length > 100) {
		if (level === "simple") level = "medium";
		else if (level === "medium") level = "complex";
		factors.push("long title suggests complexity");
	}

	return {
		level,
		confidence: Math.min(confidence, 1),
		estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[level],
		factors,
	};
}

/**
 * Parse engine type from string
 */
function parseEngineType(engine: string): EngineType | null {
	const normalized = engine.toLowerCase().trim();
	const validEngines: EngineType[] = [
		"claude",
		"codex",
		"aider",
		"cursor",
		"gemini",
		"qwen",
		"droid",
		"opencode",
	];
	return validEngines.includes(normalized as EngineType) ? (normalized as EngineType) : null;
}

// ============================================================================
// MarkdownTaskSource Class
// ============================================================================

/**
 * MarkdownTaskSource - Milhouse implementation for reading tasks from markdown files
 *
 * @description Reads tasks from markdown files with checkbox format and provides
 * rich metadata extraction, provenance tracking, and schema validation.
 *
 * Supported formats:
 * - `- [ ] Task description` (pending)
 * - `- [x] Task description` (completed)
 *
 * Supported metadata tags:
 * - `@group(n)` - Parallel execution group
 * - `@priority(level)` - Task priority (critical/high/medium/low)
 * - `@label(name)` - Task labels (can be repeated)
 * - `@complexity(level)` - Complexity hint (trivial/simple/medium/complex/epic)
 * - `@engine(name)` - Preferred engine (can be repeated)
 * - `@artifact(type:pattern)` - Expected artifact
 * - `@depends(id)` - Task dependency
 * - `@assignee(name)` - Assigned user
 * - `@due(date)` - Due date
 * - `@effort(time)` - Estimated effort
 *
 * @example
 * ```typescript
 * const source = new MarkdownTaskSource({
 *   type: "markdown",
 *   path: "./PRD.md",
 *   trackProvenance: true,
 *   estimateComplexity: true
 * });
 *
 * const collection = await source.load();
 * console.log(`Found ${collection.tasks.length} tasks`);
 * ```
 */
export class MarkdownTaskSource implements IMilhouseTaskSource, ITaskSource {
	readonly name = "markdown";
	readonly config: MilhouseSourceConfig;
	private filePath: string;
	private cachedCollection: MilhouseTaskCollection | null = null;
	private lastLoadTime = 0;

	/**
	 * Create a new MarkdownTaskSource
	 *
	 * @param config - Source configuration
	 */
	constructor(config: TaskSourceConfig | MilhouseSourceConfig) {
		this.config = {
			...config,
			trackProvenance: (config as MilhouseSourceConfig).trackProvenance ?? true,
			estimateComplexity: (config as MilhouseSourceConfig).estimateComplexity ?? true,
		};
		this.filePath = config.path || "PRD.md";
	}

	/**
	 * Load all tasks from the markdown file
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
		const tasks = this.parseMarkdownContent(content);

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
	 * Parse markdown content into Milhouse tasks
	 */
	private parseMarkdownContent(content: string): MilhouseTask[] {
		const lines = content.split("\n");
		const tasks: MilhouseTask[] = [];
		let taskIndex = 0;
		const discoveredAt = new Date().toISOString();

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum];
			const match = line.match(CHECKBOX_PATTERN);

			if (match) {
				const [, indent, checkMark, rawTitle] = match;
				const isCompleted = checkMark.toLowerCase() === "x";
				const task = this.createTaskFromLine(
					rawTitle,
					isCompleted,
					lineNum + 1,
					taskIndex++,
					line,
					discoveredAt,
				);
				tasks.push(task);
			}
		}

		return tasks;
	}

	/**
	 * Create a Milhouse task from a parsed line
	 */
	private createTaskFromLine(
		rawTitle: string,
		isCompleted: boolean,
		lineNumber: number,
		index: number,
		rawLine: string,
		discoveredAt: string,
	): MilhouseTask {
		// Extract parallel group
		const groupMatch = rawTitle.match(PARALLEL_GROUP_PATTERN);
		const parallelGroup = groupMatch ? Number.parseInt(groupMatch[1], 10) : undefined;

		// Extract priority
		const priorityMatch = rawTitle.match(PRIORITY_PATTERN);
		const priority = (priorityMatch?.[1]?.toLowerCase() as MilhouseTask["priority"]) || "medium";

		// Extract labels
		const labels: string[] = [];
		let labelMatch: RegExpExecArray | null;
		const labelRegex = new RegExp(LABEL_PATTERN.source, "g");
		while ((labelMatch = labelRegex.exec(rawTitle)) !== null) {
			labels.push(labelMatch[1]);
		}

		// Extract complexity hint
		const complexityMatch = rawTitle.match(COMPLEXITY_PATTERN);
		const complexityHint = complexityMatch?.[1]?.toLowerCase() as TaskComplexity | undefined;

		// Extract engine hints
		const engines: EngineType[] = [];
		let engineMatch: RegExpExecArray | null;
		const engineRegex = new RegExp(ENGINE_PATTERN.source, "g");
		while ((engineMatch = engineRegex.exec(rawTitle)) !== null) {
			const engine = parseEngineType(engineMatch[1]);
			if (engine) engines.push(engine);
		}

		// Extract expected artifacts
		const artifacts: ExpectedArtifact[] = [];
		let artifactMatch: RegExpExecArray | null;
		const artifactRegex = new RegExp(ARTIFACT_PATTERN.source, "g");
		while ((artifactMatch = artifactRegex.exec(rawTitle)) !== null) {
			artifacts.push({
				type: artifactMatch[1] as ExpectedArtifact["type"],
				pattern: artifactMatch[2],
				required: true,
			});
		}

		// Extract dependencies
		const dependencies: string[] = [];
		let dependsMatch: RegExpExecArray | null;
		const dependsRegex = new RegExp(DEPENDS_PATTERN.source, "g");
		while ((dependsMatch = dependsRegex.exec(rawTitle)) !== null) {
			dependencies.push(dependsMatch[1]);
		}

		// Extract assignee
		const assigneeMatch = rawTitle.match(ASSIGNEE_PATTERN);
		const assignee = assigneeMatch?.[1];

		// Extract due date
		const dueDateMatch = rawTitle.match(DUE_DATE_PATTERN);
		const dueDate = dueDateMatch?.[1];

		// Extract effort
		const effortMatch = rawTitle.match(EFFORT_PATTERN);
		const estimatedEffort = effortMatch?.[1];

		// Clean title by removing all metadata tags
		const cleanTitle = rawTitle
			.replace(PARALLEL_GROUP_PATTERN, "")
			.replace(PRIORITY_PATTERN, "")
			.replace(LABEL_PATTERN, "")
			.replace(COMPLEXITY_PATTERN, "")
			.replace(ENGINE_PATTERN, "")
			.replace(ARTIFACT_PATTERN, "")
			.replace(DEPENDS_PATTERN, "")
			.replace(ASSIGNEE_PATTERN, "")
			.replace(DUE_DATE_PATTERN, "")
			.replace(EFFORT_PATTERN, "")
			.trim();

		// Build provenance if tracking is enabled
		const provenance: TaskProvenance | undefined = this.config.trackProvenance
			? {
					sourceKind: "markdown",
					sourcePath: this.filePath,
					lineNumber,
					columnNumber: 1,
					discoveredAt,
					lastSyncedAt: discoveredAt,
					contentHash: generateContentHash(rawLine),
					version: 1,
					rawContent: rawLine,
				}
			: undefined;

		// Build complexity estimate
		const complexity: ComplexityEstimate | undefined = this.config.estimateComplexity
			? complexityHint
				? {
						level: complexityHint,
						confidence: 1,
						estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[complexityHint],
						factors: ["explicitly specified"],
					}
				: estimateComplexity(cleanTitle, artifacts.length > 0)
			: undefined;

		// Build engine hints
		const engineHints: EngineHints | undefined =
			engines.length > 0 || this.config.defaultEngineHints
				? {
						preferred:
							engines.length > 0 ? engines : this.config.defaultEngineHints?.preferred || [],
						excluded: this.config.defaultEngineHints?.excluded,
						requirements: this.config.defaultEngineHints?.requirements,
					}
				: undefined;

		// Build metadata
		const metadata: MilhouseTaskMetadata = {
			source: "markdown",
			sourceFile: this.filePath,
			lineNumber,
			parallelGroup,
			dependencies,
			labels,
			assignee,
			dueDate,
			estimatedEffort,
			provenance,
			complexity,
			engineHints,
			expectedArtifacts: artifacts.length > 0 ? artifacts : undefined,
		};

		return {
			id: `md-${index}`,
			title: cleanTitle,
			status: isCompleted ? "completed" : "pending",
			priority,
			metadata,
		};
	}

	/**
	 * Filter tasks based on load options
	 */
	private filterTasks(tasks: MilhouseTask[], options: MilhouseLoadOptions): MilhouseTask[] {
		return tasks.filter((task) => {
			// Filter by completion status
			if (!options.includeCompleted && task.status === "completed") {
				return false;
			}

			// Filter by status
			if (options.statusFilter && !options.statusFilter.includes(task.status)) {
				return false;
			}

			// Filter by priority
			if (options.priorityFilter && !options.priorityFilter.includes(task.priority)) {
				return false;
			}

			// Filter by labels
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
	 * Update task status in the markdown file
	 *
	 * @param taskId - Task identifier
	 * @param status - New status
	 */
	async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
		const file = Bun.file(this.filePath);
		const content = await file.text();
		const lines = content.split("\n");

		// Find the task to get its line number
		const collection = await this.load({ forceRefresh: true });
		const task = collection.tasks.find((t) => t.id === taskId);

		if (!task || !task.metadata.lineNumber) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const lineIndex = task.metadata.lineNumber - 1;
		const line = lines[lineIndex];

		if (lineIndex >= 0 && lineIndex < lines.length) {
			if (status === "completed") {
				lines[lineIndex] = line.replace(/- \[ \]/, "- [x]");
			} else if (status === "pending") {
				lines[lineIndex] = line.replace(/- \[x\]/i, "- [ ]");
			}

			await Bun.write(this.filePath, lines.join("\n"));

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
	 * Check if the markdown file exists and is readable
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
	 * Get statistics about tasks in this source
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
	 * Refresh cache by reloading from file
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
		// For markdown source, metadata updates are stored in memory only
		// as the file format doesn't support arbitrary metadata
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
	 * Get the file path for this source
	 */
	getFilePath(): string {
		return this.filePath;
	}
}
