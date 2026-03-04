import { existsSync } from "node:fs";
import type { ITaskSource, TaskSourceConfig } from "../core/types";
import { MarkdownTaskSource } from "../sources/markdown";
import { MarkdownFolderTaskSource } from "../sources/markdown-folder";
import { YamlTaskSource } from "../sources/yaml";

// GitHubTaskSource is loaded dynamically to avoid requiring @octokit/rest
// when it's not needed (it's an optional dependency)
let GitHubTaskSourceClass: typeof import("../sources/github").GitHubTaskSource | null = null;

async function getGitHubTaskSource(): Promise<typeof import("../sources/github").GitHubTaskSource> {
	if (!GitHubTaskSourceClass) {
		const module = await import("../sources/github");
		GitHubTaskSourceClass = module.GitHubTaskSource;
	}
	return GitHubTaskSourceClass;
}

/**
 * Create a task source based on configuration
 * Factory pattern for instantiating the appropriate source adapter
 */
export function createTaskSource(config: TaskSourceConfig): ITaskSource {
	switch (config.type) {
		case "markdown":
			return new MarkdownTaskSource(config);

		case "markdown-folder":
			return new MarkdownFolderTaskSource(config);

		case "yaml":
			return new YamlTaskSource(config);

		case "github":
			// For GitHub source, we need to throw a helpful error since we can't
			// use async in a sync function. Users should use createTaskSourceAsync instead.
			throw new Error(
				"GitHub task source requires async initialization. Use createTaskSourceAsync() instead.",
			);

		default:
			throw new Error(`Unknown task source type: ${(config as TaskSourceConfig).type}`);
	}
}

/**
 * Create a task source based on configuration (async version)
 * Required for GitHub source which needs dynamic import
 */
export async function createTaskSourceAsync(config: TaskSourceConfig): Promise<ITaskSource> {
	switch (config.type) {
		case "markdown":
			return new MarkdownTaskSource(config);

		case "markdown-folder":
			return new MarkdownFolderTaskSource(config);

		case "yaml":
			return new YamlTaskSource(config);

		case "github": {
			const GitHubTaskSource = await getGitHubTaskSource();
			return new GitHubTaskSource(config);
		}

		default:
			throw new Error(`Unknown task source type: ${(config as TaskSourceConfig).type}`);
	}
}

/**
 * Auto-detect task source from project directory
 * Checks for common task file patterns and returns appropriate config
 */
export async function detectTaskSource(projectPath: string): Promise<TaskSourceConfig | null> {
	// Check for PRD.md (common pattern)
	if (existsSync(`${projectPath}/PRD.md`)) {
		return {
			type: "markdown",
			path: `${projectPath}/PRD.md`,
		};
	}

	// Check for tasks.md
	if (existsSync(`${projectPath}/tasks.md`)) {
		return {
			type: "markdown",
			path: `${projectPath}/tasks.md`,
		};
	}

	// Check for tasks.yaml or tasks.yml
	if (existsSync(`${projectPath}/tasks.yaml`)) {
		return {
			type: "yaml",
			path: `${projectPath}/tasks.yaml`,
		};
	}

	if (existsSync(`${projectPath}/tasks.yml`)) {
		return {
			type: "yaml",
			path: `${projectPath}/tasks.yml`,
		};
	}

	// Check for .milhouse/tasks.yaml
	if (existsSync(`${projectPath}/.milhouse/tasks.yaml`)) {
		return {
			type: "yaml",
			path: `${projectPath}/.milhouse/tasks.yaml`,
		};
	}

	// Check for docs/ folder with markdown files
	if (existsSync(`${projectPath}/docs`)) {
		return {
			type: "markdown-folder",
			path: `${projectPath}/docs`,
			patterns: ["**/*.md"],
		};
	}

	return null;
}

/**
 * Create multiple task sources from an array of configs
 */
export function createTaskSources(configs: TaskSourceConfig[]): ITaskSource[] {
	return configs.map((config) => createTaskSource(config));
}

/**
 * Validate task source configuration
 */
export function validateSourceConfig(config: TaskSourceConfig): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!config.type) {
		errors.push("Task source type is required");
	}

	if (!["markdown", "markdown-folder", "yaml", "github"].includes(config.type)) {
		errors.push(`Invalid task source type: ${config.type}`);
	}

	if (config.type === "github") {
		const options = config.options as { repo?: string } | undefined;
		if (!config.path && !options?.repo) {
			errors.push("GitHub source requires repo path (owner/repo format)");
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Get source type from file extension
 */
export function getSourceTypeFromPath(filePath: string): TaskSourceConfig["type"] | null {
	const lower = filePath.toLowerCase();

	if (lower.endsWith(".md")) {
		return "markdown";
	}

	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
		return "yaml";
	}

	return null;
}

/**
 * Create a source config from a file path
 */
export function createConfigFromPath(filePath: string): TaskSourceConfig | null {
	const type = getSourceTypeFromPath(filePath);

	if (!type) {
		return null;
	}

	return {
		type,
		path: filePath,
	};
}
