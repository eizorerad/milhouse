/**
 * Milhouse GitHub Task Source
 *
 * Reads tasks from GitHub issues with rich metadata extraction and provides
 * Milhouse-specific features including:
 * - Task provenance tracking
 * - Schema validation
 * - Complexity estimation from issue content
 * - Engine hints from labels
 * - Dependency extraction from issue body
 *
 * @module tasks/sources/github
 * @since 1.0.0
 */

import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
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
// Types and Schemas
// ============================================================================

/**
 * GitHub-specific configuration options
 */
interface GitHubOptions {
	/** Repository in owner/repo format */
	repo?: string;
	/** Filter issues by label */
	filterLabel?: string;
	/** Extract priority from labels */
	priorityLabels?: boolean;
	/** Include issue body in task description */
	includeBody?: boolean;
	/** Extract complexity from labels */
	complexityLabels?: boolean;
	/** Extract engine hints from labels */
	engineLabels?: boolean;
	/** Maximum issues to fetch */
	maxIssues?: number;
}

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
 * Map size labels to complexity
 */
function sizeToComplexity(size: string): TaskComplexity {
	const mapping: Record<string, TaskComplexity> = {
		"size:XS": "trivial",
		"size:S": "simple",
		"size:M": "medium",
		"size:L": "complex",
		"size:XL": "epic",
	};
	return mapping[size] || "medium";
}

/**
 * Estimate complexity from issue content
 */
function estimateComplexityFromIssue(
	title: string,
	body: string | null,
	labels: string[],
): ComplexityEstimate {
	const lowerTitle = title.toLowerCase();
	let level: TaskComplexity = "medium";
	let confidence = 0.4;
	const factors: string[] = [];

	// Check for explicit complexity labels
	for (const label of labels) {
		if (label.startsWith("complexity:")) {
			const explicitLevel = label.replace("complexity:", "") as TaskComplexity;
			return {
				level: explicitLevel,
				confidence: 1,
				estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[explicitLevel],
				factors: ["explicit complexity label"],
			};
		}
		if (label.startsWith("size:")) {
			const sizeLevel = sizeToComplexity(label);
			return {
				level: sizeLevel,
				confidence: 0.9,
				estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[sizeLevel],
				factors: ["size label mapping"],
			};
		}
	}

	// Heuristics based on content
	if (lowerTitle.includes("bug") || lowerTitle.includes("fix") || lowerTitle.includes("typo")) {
		level = "simple";
		confidence = 0.6;
		factors.push("bug/fix keyword in title");
	} else if (
		lowerTitle.includes("refactor") ||
		lowerTitle.includes("redesign") ||
		lowerTitle.includes("migrate")
	) {
		level = "complex";
		confidence = 0.6;
		factors.push("refactor/redesign keyword in title");
	} else if (lowerTitle.includes("feature") || lowerTitle.includes("implement")) {
		level = "medium";
		confidence = 0.5;
		factors.push("feature/implement keyword in title");
	}

	// Check body length as complexity indicator
	if (body) {
		const bodyLength = body.length;
		if (bodyLength > 2000) {
			if (level === "simple") level = "medium";
			else if (level === "medium") level = "complex";
			factors.push("long issue body");
			confidence += 0.1;
		}

		// Check for checklist items
		const checklistItems = (body.match(/- \[ \]/g) || []).length;
		if (checklistItems > 5) {
			if (level === "simple") level = "medium";
			else if (level === "medium") level = "complex";
			factors.push(`${checklistItems} checklist items`);
			confidence += 0.1;
		}
	}

	return {
		level,
		confidence: Math.min(confidence, 1),
		estimatedMinutes: COMPLEXITY_TIME_ESTIMATES[level],
		factors,
	};
}

/**
 * Extract engine hints from labels
 */
function extractEngineHints(labels: string[]): EngineHints | undefined {
	const preferred: EngineType[] = [];
	const excluded: EngineType[] = [];

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

	for (const label of labels) {
		if (label.startsWith("engine:")) {
			const engine = label.replace("engine:", "").toLowerCase();
			if (validEngines.includes(engine as EngineType)) {
				preferred.push(engine as EngineType);
			}
		}
		if (label.startsWith("no-engine:")) {
			const engine = label.replace("no-engine:", "").toLowerCase();
			if (validEngines.includes(engine as EngineType)) {
				excluded.push(engine as EngineType);
			}
		}
	}

	if (preferred.length === 0 && excluded.length === 0) {
		return undefined;
	}

	return {
		preferred,
		excluded: excluded.length > 0 ? excluded : undefined,
	};
}

/**
 * Extract expected artifacts from issue body
 */
function extractArtifacts(body: string | null): ExpectedArtifact[] {
	if (!body) return [];

	const artifacts: ExpectedArtifact[] = [];

	// Pattern: <!-- artifact: type:pattern -->
	const artifactPattern = /<!--\s*artifact:\s*(\w+):([^>]+)\s*-->/g;
	let match: RegExpExecArray | null;

	while ((match = artifactPattern.exec(body)) !== null) {
		artifacts.push({
			type: match[1] as ExpectedArtifact["type"],
			pattern: match[2].trim(),
			required: true,
		});
	}

	// Also check for file references in code blocks
	const filePattern = /```(?:diff|patch)?\s*\n(?:---|\+\+\+)\s+([^\n]+)/g;
	while ((match = filePattern.exec(body)) !== null) {
		const filePath = match[1].replace(/^[ab]\//, "").trim();
		if (filePath && !artifacts.some((a) => a.pattern === filePath)) {
			artifacts.push({
				type: "file",
				pattern: filePath,
				required: false,
				description: "Referenced in diff",
			});
		}
	}

	return artifacts;
}

// ============================================================================
// GitHubTaskSource Class
// ============================================================================

/**
 * GitHubTaskSource - Milhouse implementation for reading tasks from GitHub issues
 *
 * @description Maps GitHub issues to Milhouse tasks with rich metadata extraction.
 * Supports priority, complexity, and engine hints via labels.
 *
 * Label Conventions:
 * - Priority: `priority:critical`, `priority:high`, `priority:medium`, `priority:low`, `P0`-`P3`
 * - Complexity: `complexity:trivial`-`epic`, `size:XS`-`XL`
 * - Engine: `engine:claude`, `engine:codex`, etc.
 * - Groups: `group:1`, `group:2`, etc.
 *
 * Body Conventions:
 * - Dependencies: "Depends on #123", "Blocked by #456", "Requires #789"
 * - Artifacts: `<!-- artifact: file:src/*.ts -->`
 *
 * @example
 * ```typescript
 * const source = new GitHubTaskSource({
 *   type: "github",
 *   path: "owner/repo",
 *   options: {
 *     filterLabel: "milhouse",
 *     priorityLabels: true,
 *     complexityLabels: true
 *   },
 *   trackProvenance: true
 * });
 *
 * const collection = await source.load();
 * ```
 */
export class GitHubTaskSource implements IMilhouseTaskSource, ITaskSource {
	readonly name = "github";
	readonly config: MilhouseSourceConfig;
	private octokit: Octokit;
	private owner: string;
	private repo: string;
	private filterLabel?: string;
	private priorityLabels: boolean;
	private complexityLabels: boolean;
	private engineLabels: boolean;
	private includeBody: boolean;
	private maxIssues: number;
	private cachedCollection: MilhouseTaskCollection | null = null;
	private lastLoadTime = 0;

	/**
	 * Create a new GitHubTaskSource
	 *
	 * @param config - Source configuration
	 */
	constructor(config: TaskSourceConfig | MilhouseSourceConfig) {
		this.config = {
			...config,
			trackProvenance: (config as MilhouseSourceConfig).trackProvenance ?? true,
			estimateComplexity: (config as MilhouseSourceConfig).estimateComplexity ?? true,
		};

		// Parse options
		const options = (config.options || {}) as GitHubOptions;
		const repoPath = options.repo || config.path || "";

		// Parse owner/repo format
		const [owner, repo] = repoPath.split("/");
		if (!owner || !repo) {
			throw new Error(`Invalid repo format: ${repoPath}. Expected owner/repo`);
		}

		this.owner = owner;
		this.repo = repo;
		this.filterLabel = options.filterLabel;
		this.priorityLabels = options.priorityLabels ?? true;
		this.complexityLabels = options.complexityLabels ?? true;
		this.engineLabels = options.engineLabels ?? true;
		this.includeBody = options.includeBody ?? true;
		this.maxIssues = options.maxIssues ?? 100;

		// Initialize Octokit with token from environment
		this.octokit = new Octokit({
			auth: process.env.GITHUB_TOKEN,
		});
	}

	/**
	 * Load issues from GitHub as tasks
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

		const issues = await this.octokit.paginate(
			this.octokit.issues.listForRepo,
			{
				owner: this.owner,
				repo: this.repo,
				state: "all",
				labels: this.filterLabel,
				per_page: 100,
			},
			(response, done) => {
				// Stop pagination if we've reached maxIssues
				if (response.data.length >= this.maxIssues) {
					done();
				}
				return response.data;
			},
		);

		const tasks = issues
			.filter((issue) => !issue.pull_request) // Exclude PRs
			.slice(0, this.maxIssues)
			.map((issue) => this.issueToTask(issue));

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
			source: `github:${this.owner}/${this.repo}`,
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
	 * Convert GitHub issue to Milhouse task
	 */
	private issueToTask(issue: any): MilhouseTask {
		const labels = issue.labels?.map((l: any) => (typeof l === "string" ? l : l.name)) || [];
		const discoveredAt = new Date().toISOString();

		// Extract priority from labels
		const priority = this.extractPriority(labels);

		// Determine status from issue state
		const status: TaskStatus = issue.state === "closed" ? "completed" : "pending";

		// Extract parallel group from labels (e.g., "group:1")
		const parallelGroup = this.extractParallelGroup(labels);

		// Extract dependencies from issue body
		const dependencies = this.extractDependencies(issue.body || "");

		// Build provenance if tracking is enabled
		const provenance: TaskProvenance | undefined = this.config.trackProvenance
			? {
					sourceKind: "github",
					sourcePath: `${this.owner}/${this.repo}#${issue.number}`,
					discoveredAt,
					lastSyncedAt: discoveredAt,
					contentHash: generateContentHash(
						JSON.stringify({ title: issue.title, body: issue.body }),
					),
					version: 1,
				}
			: undefined;

		// Build complexity estimate
		const complexity: ComplexityEstimate | undefined = this.config.estimateComplexity
			? estimateComplexityFromIssue(issue.title, issue.body, labels)
			: undefined;

		// Build engine hints
		const engineHints: EngineHints | undefined = this.engineLabels
			? extractEngineHints(labels) || this.config.defaultEngineHints
			: this.config.defaultEngineHints;

		// Extract expected artifacts
		const expectedArtifacts = extractArtifacts(issue.body);

		// Filter out metadata labels from display labels
		const displayLabels = labels.filter(
			(l: string) =>
				!l.startsWith("priority:") &&
				!l.startsWith("complexity:") &&
				!l.startsWith("size:") &&
				!l.startsWith("group:") &&
				!l.startsWith("engine:") &&
				!l.startsWith("no-engine:") &&
				!["P0", "P1", "P2", "P3"].includes(l),
		);

		// Build metadata
		const metadata: MilhouseTaskMetadata = {
			source: "github",
			sourceFile: `${this.owner}/${this.repo}#${issue.number}`,
			parallelGroup,
			dependencies,
			labels: displayLabels,
			assignee: issue.assignee?.login,
			provenance,
			complexity,
			engineHints,
			expectedArtifacts: expectedArtifacts.length > 0 ? expectedArtifacts : undefined,
			custom: {
				issueNumber: issue.number,
				issueUrl: issue.html_url,
				milestone: issue.milestone?.title,
				reactions: issue.reactions?.total_count,
			},
		};

		return {
			id: `gh-${issue.number}`,
			title: issue.title,
			description: this.includeBody ? issue.body || undefined : undefined,
			status,
			priority,
			metadata,
			createdAt: issue.created_at,
			updatedAt: issue.updated_at,
			completedAt: issue.closed_at || undefined,
		};
	}

	/**
	 * Extract priority from labels
	 */
	private extractPriority(labels: string[]): TaskPriority {
		if (!this.priorityLabels) return "medium";

		for (const label of labels) {
			// Standard priority labels
			if (label === "priority:critical" || label === "P0") return "critical";
			if (label === "priority:high" || label === "P1") return "high";
			if (label === "priority:medium" || label === "P2") return "medium";
			if (label === "priority:low" || label === "P3") return "low";
		}

		return "medium";
	}

	/**
	 * Extract parallel group from labels
	 */
	private extractParallelGroup(labels: string[]): number | undefined {
		for (const label of labels) {
			const match = label.match(/^group:(\d+)$/);
			if (match) {
				return Number.parseInt(match[1], 10);
			}
		}
		return undefined;
	}

	/**
	 * Extract dependencies from issue body
	 */
	private extractDependencies(body: string): string[] {
		const deps: string[] = [];
		const patterns = [
			/depends on #(\d+)/gi,
			/blocked by #(\d+)/gi,
			/requires #(\d+)/gi,
			/after #(\d+)/gi,
		];

		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(body)) !== null) {
				deps.push(`gh-${match[1]}`);
			}
		}

		return [...new Set(deps)];
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
	 * Update task status by closing/reopening issue
	 *
	 * @param taskId - Task identifier
	 * @param status - New status
	 */
	async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
		const issueNumber = this.extractIssueNumber(taskId);

		if (issueNumber === null) {
			throw new Error(`Invalid task ID: ${taskId}`);
		}

		const state = status === "completed" || status === "skipped" ? "closed" : "open";

		await this.octokit.issues.update({
			owner: this.owner,
			repo: this.repo,
			issue_number: issueNumber,
			state,
		});

		// Emit event
		bus.emit("task:complete", {
			taskId,
			duration: 0,
			success: status === "completed",
		});

		// Invalidate cache
		this.cachedCollection = null;
	}

	/**
	 * Extract issue number from task ID
	 */
	private extractIssueNumber(taskId: string): number | null {
		const match = taskId.match(/^gh-(\d+)$/);
		return match ? Number.parseInt(match[1], 10) : null;
	}

	/**
	 * Check if GitHub API is accessible
	 */
	async isAvailable(): Promise<boolean> {
		try {
			await this.octokit.repos.get({
				owner: this.owner,
				repo: this.repo,
			});
			return true;
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
	 * Update task metadata (limited for GitHub - only labels can be updated)
	 *
	 * @param taskId - Task identifier
	 * @param metadata - Partial metadata to merge
	 */
	async updateMetadata(taskId: string, metadata: Partial<MilhouseTaskMetadata>): Promise<void> {
		const issueNumber = this.extractIssueNumber(taskId);

		if (issueNumber === null) {
			throw new Error(`Invalid task ID: ${taskId}`);
		}

		// For GitHub, we can only update labels
		if (metadata.labels) {
			await this.octokit.issues.setLabels({
				owner: this.owner,
				repo: this.repo,
				issue_number: issueNumber,
				labels: metadata.labels,
			});
		}

		// Invalidate cache
		this.cachedCollection = null;
	}

	/**
	 * Get full issue body for a task
	 *
	 * @param taskId - Task identifier
	 */
	async getIssueBody(taskId: string): Promise<string> {
		const issueNumber = this.extractIssueNumber(taskId);

		if (issueNumber === null) {
			return "";
		}

		const issue = await this.octokit.issues.get({
			owner: this.owner,
			repo: this.repo,
			issue_number: issueNumber,
		});

		return issue.data.body || "";
	}

	/**
	 * Add a comment to an issue
	 *
	 * @param taskId - Task identifier
	 * @param comment - Comment body
	 */
	async addComment(taskId: string, comment: string): Promise<void> {
		const issueNumber = this.extractIssueNumber(taskId);

		if (issueNumber === null) {
			throw new Error(`Invalid task ID: ${taskId}`);
		}

		await this.octokit.issues.createComment({
			owner: this.owner,
			repo: this.repo,
			issue_number: issueNumber,
			body: comment,
		});
	}

	/**
	 * Add labels to an issue
	 *
	 * @param taskId - Task identifier
	 * @param labels - Labels to add
	 */
	async addLabels(taskId: string, labels: string[]): Promise<void> {
		const issueNumber = this.extractIssueNumber(taskId);

		if (issueNumber === null) {
			throw new Error(`Invalid task ID: ${taskId}`);
		}

		await this.octokit.issues.addLabels({
			owner: this.owner,
			repo: this.repo,
			issue_number: issueNumber,
			labels,
		});

		this.cachedCollection = null;
	}

	/**
	 * Create a new issue
	 *
	 * @param title - Issue title
	 * @param body - Issue body
	 * @param labels - Issue labels
	 * @returns Task ID of the created issue
	 */
	async createIssue(title: string, body?: string, labels?: string[]): Promise<string> {
		const issue = await this.octokit.issues.create({
			owner: this.owner,
			repo: this.repo,
			title,
			body,
			labels,
		});

		this.cachedCollection = null;
		return `gh-${issue.data.number}`;
	}

	/**
	 * Get repository information
	 */
	getRepoInfo(): { owner: string; repo: string } {
		return { owner: this.owner, repo: this.repo };
	}
}
