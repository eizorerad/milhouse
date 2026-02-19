/**
 * VCS Naming Policies
 *
 * Centralized naming conventions for branches, worktrees, and identifiers.
 * Uses runId-based naming for better isolation and traceability.
 *
 * @module vcs/policies/naming
 */

/**
 * Configuration for branch naming
 */
export interface NamingConfig {
	/** Prefix for task branches */
	taskPrefix: string;
	/** Prefix for agent branches */
	agentPrefix: string;
	/** Prefix for integration branches */
	integrationPrefix: string;
	/** Identifier for autostash operations */
	stashIdentifier: string;
	/** Maximum length for slugified text */
	maxSlugLength: number;
}

/**
 * Default naming configuration for Milhouse
 */
export const DEFAULT_NAMING_CONFIG: NamingConfig = {
	taskPrefix: "mh/task/",
	agentPrefix: "mh/ex/",
	integrationPrefix: "mh/int/",
	stashIdentifier: "mh-autostash",
	maxSlugLength: 50,
};

/**
 * Options for generating an agent branch name
 */
export interface AgentBranchNameOptions {
	/** Branch prefix (defaults to DEFAULT_NAMING_CONFIG.agentPrefix) */
	prefix?: string;
	/** Run ID for isolation */
	runId: string;
	/** Agent identifier (optional) */
	agentId?: string;
	/** Task slug or identifier */
	taskSlug: string;
	/** Random nonce for uniqueness (optional) */
	nonce?: string;
}

/**
 * Options for generating a task branch name
 */
export interface TaskBranchNameOptions {
	/** Branch prefix (defaults to DEFAULT_NAMING_CONFIG.taskPrefix) */
	prefix?: string;
	/** Task slug or identifier */
	taskSlug: string;
}

/**
 * Options for generating an integration branch name
 */
export interface IntegrationBranchNameOptions {
	/** Branch prefix (defaults to DEFAULT_NAMING_CONFIG.integrationPrefix) */
	prefix?: string;
	/** Group number */
	groupNum: number;
}

/**
 * Slugify text for use in branch names
 *
 * Converts text to lowercase, replaces non-alphanumeric characters with hyphens,
 * removes leading/trailing hyphens, and truncates to maxLength.
 *
 * @param text - The text to slugify
 * @param maxLength - Maximum length (defaults to DEFAULT_NAMING_CONFIG.maxSlugLength)
 * @returns A URL-safe slug suitable for branch names
 *
 * @example
 * ```ts
 * slugify("Fix: User Login Bug!") // "fix-user-login-bug"
 * slugify("Add Feature #123") // "add-feature-123"
 * ```
 */
export function slugify(text: string, maxLength = DEFAULT_NAMING_CONFIG.maxSlugLength): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength);
}

/**
 * Generate a unique nonce for branch names
 *
 * Combines timestamp with random suffix to prevent collisions.
 *
 * @returns A unique nonce string
 */
export function generateNonce(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `${timestamp}-${random}`;
}

/**
 * Generate an agent branch name
 *
 * Format: {prefix}{runId}/{taskSlug}[-{nonce}]
 *
 * @param options - Branch name options
 * @returns The generated branch name
 *
 * @example
 * ```ts
 * makeAgentBranchName({
 *   runId: "run-abc123",
 *   taskSlug: "fix-login",
 * })
 * // "mh/ex/run-abc123/fix-login"
 *
 * makeAgentBranchName({
 *   runId: "run-abc123",
 *   agentId: "agent-1",
 *   taskSlug: "fix-login",
 *   nonce: "xyz789",
 * })
 * // "mh/ex/run-abc123/agent-1/fix-login-xyz789"
 * ```
 */
export function makeAgentBranchName(options: AgentBranchNameOptions): string {
	const prefix = options.prefix ?? DEFAULT_NAMING_CONFIG.agentPrefix;
	const slug = slugify(options.taskSlug);

	let branchName = `${prefix}${options.runId}/`;

	if (options.agentId) {
		branchName += `${options.agentId}/`;
	}

	branchName += slug;

	if (options.nonce) {
		branchName += `-${options.nonce}`;
	}

	return branchName;
}

/**
 * Generate a task branch name
 *
 * Format: {prefix}{taskSlug}
 *
 * @param options - Branch name options
 * @returns The generated branch name
 *
 * @example
 * ```ts
 * makeTaskBranchName({ taskSlug: "implement-feature" })
 * // "mh/task/implement-feature"
 * ```
 */
export function makeTaskBranchName(options: TaskBranchNameOptions): string {
	const prefix = options.prefix ?? DEFAULT_NAMING_CONFIG.taskPrefix;
	const slug = slugify(options.taskSlug);
	return `${prefix}${slug}`;
}

/**
 * Generate an integration branch name
 *
 * Format: {prefix}group-{groupNum}
 *
 * @param options - Branch name options
 * @returns The generated branch name
 *
 * @example
 * ```ts
 * makeIntegrationBranchName({ groupNum: 1 })
 * // "mh/int/group-1"
 * ```
 */
export function makeIntegrationBranchName(options: IntegrationBranchNameOptions): string {
	const prefix = options.prefix ?? DEFAULT_NAMING_CONFIG.integrationPrefix;
	return `${prefix}group-${options.groupNum}`;
}

/**
 * Check if a branch name is a Milhouse-managed branch
 *
 * @param branchName - The branch name to check
 * @returns True if the branch is Milhouse-managed
 */
export function isMillhouseBranch(branchName: string): boolean {
	return (
		branchName.startsWith(DEFAULT_NAMING_CONFIG.taskPrefix) ||
		branchName.startsWith(DEFAULT_NAMING_CONFIG.agentPrefix) ||
		branchName.startsWith(DEFAULT_NAMING_CONFIG.integrationPrefix)
	);
}

/**
 * Extract run ID from an agent branch name
 *
 * @param branchName - The branch name to parse
 * @returns The run ID or null if not found
 */
export function extractRunIdFromBranch(branchName: string): string | null {
	const prefix = DEFAULT_NAMING_CONFIG.agentPrefix;
	if (!branchName.startsWith(prefix)) {
		return null;
	}

	const withoutPrefix = branchName.slice(prefix.length);
	const parts = withoutPrefix.split("/");
	return parts[0] || null;
}
