import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeOptions } from "../cli/runtime-options.ts";
import { logError, logWarn } from "../ui/logger.ts";
import { AsyncMutex, withFileLock } from "./file-lock.ts";
import { getRunStateDir, getStatePathForCurrentRun } from "./paths.ts";
import { type Issue, IssueSchema, type IssueStatus, STATE_FILES, type Severity } from "./types.ts";

/**
 * Get path to issues state file
 * Uses run-aware path resolution - returns run-specific path if a run is active
 */
function getIssuesPath(workDir = process.cwd()): string {
	return getStatePathForCurrentRun("issues", workDir);
}

/**
 * Get path to issues state file for a specific run
 * This is the run-aware version that accepts an explicit runId parameter
 *
 * @param runId - The run ID to get the issues path for
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns Full path to the issues.json file for the specified run
 */
function getIssuesPathForRun(runId: string, workDir = process.cwd()): string {
	return join(getRunStateDir(runId, workDir), STATE_FILES.issues);
}

/**
 * Generate unique issue ID with P- prefix
 */
export function generateIssueId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `P-${timestamp}-${random}`;
}

// ============================================================================
// INTERNAL HELPERS (deduplicated load/save)
// ============================================================================

/** Load issues from a given file path with per-item validation */
function loadIssuesFromPath(path: string): Issue[] {
	if (!existsSync(path)) return [];

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed)) return [];

		const valid: Issue[] = [];
		for (const item of parsed) {
			const result = IssueSchema.safeParse(item);
			if (result.success) {
				valid.push(result.data);
			} else {
				logWarn(`Skipping invalid issue ${item?.id || "unknown"}:`, result.error.message);
			}
		}
		return valid;
	} catch (error) {
		logError(`Failed to load issues from ${path}:`, error);
		return [];
	}
}

/** Save issues array to a given file path */
function saveIssuesToPath(path: string, issues: Issue[]): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(issues, null, 2));
}

/** Update a single issue in the file at path */
function updateIssueAtPath(
	path: string,
	issueId: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
): Issue | null {
	const issues = loadIssuesFromPath(path);
	const index = issues.findIndex((i) => i.id === issueId);
	if (index === -1) return null;

	const updated: Issue = { ...issues[index], ...update, updated_at: new Date().toISOString() };
	const newIssues = [...issues.slice(0, index), updated, ...issues.slice(index + 1)];
	saveIssuesToPath(path, newIssues);
	return updated;
}

/** Create a new issue at a given file path */
function createIssueAtPath(
	path: string,
	issue: Omit<Issue, "id" | "created_at" | "updated_at">,
): Issue {
	const issues = loadIssuesFromPath(path);
	const now = new Date().toISOString();
	const newIssue: Issue = { ...issue, id: generateIssueId(), created_at: now, updated_at: now };
	saveIssuesToPath(path, [...issues, newIssue]);
	return newIssue;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * @deprecated Use loadIssuesForRun() with explicit runId.
 */
export function loadIssues(workDir = process.cwd()): Issue[] {
	return loadIssuesFromPath(getIssuesPath(workDir));
}

export function loadIssuesForRun(runId: string, workDir = process.cwd()): Issue[] {
	return loadIssuesFromPath(getIssuesPathForRun(runId, workDir));
}

/** @deprecated Use saveIssuesForRun() with explicit runId. */
export function saveIssues(issues: Issue[], workDir = process.cwd()): void {
	saveIssuesToPath(getIssuesPath(workDir), issues);
}

export function saveIssuesForRun(runId: string, issues: Issue[], workDir = process.cwd()): void {
	saveIssuesToPath(getIssuesPathForRun(runId, workDir), issues);
}

export function createIssue(
	issue: Omit<Issue, "id" | "created_at" | "updated_at">,
	workDir = process.cwd(),
): Issue {
	return createIssueAtPath(getIssuesPath(workDir), issue);
}

export function createIssueForRun(
	runId: string,
	issue: Omit<Issue, "id" | "created_at" | "updated_at">,
	workDir = process.cwd(),
): Issue {
	return createIssueAtPath(getIssuesPathForRun(runId, workDir), issue);
}

/**
 * Read a single issue by ID
 */
export function readIssue(id: string, workDir = process.cwd()): Issue | null {
	const issues = loadIssues(workDir);
	return issues.find((i) => i.id === id) || null;
}

/** @deprecated Use updateIssueForRun() with explicit runId. */
export function updateIssue(
	id: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Issue | null {
	return updateIssueAtPath(getIssuesPath(workDir), id, update);
}

export function updateIssueForRun(
	runId: string,
	issueId: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Issue | null {
	return updateIssueAtPath(getIssuesPathForRun(runId, workDir), issueId, update);
}

/**
 * Delete an issue by ID
 */
export function deleteIssue(id: string, workDir = process.cwd()): boolean {
	const issues = loadIssues(workDir);
	const index = issues.findIndex((i) => i.id === id);

	if (index === -1) {
		return false;
	}

	const newIssues = [...issues.slice(0, index), ...issues.slice(index + 1)];
	saveIssues(newIssues, workDir);
	return true;
}

/**
 * Filter issues by status
 */
export function filterIssuesByStatus(status: IssueStatus, workDir = process.cwd()): Issue[] {
	const issues = loadIssues(workDir);
	return issues.filter((i) => i.status === status);
}

/**
 * Filter issues by multiple statuses
 */
export function filterIssuesByStatuses(statuses: IssueStatus[], workDir = process.cwd()): Issue[] {
	const issues = loadIssues(workDir);
	return issues.filter((i) => statuses.includes(i.status));
}

/**
 * Get all confirmed issues (CONFIRMED or PARTIAL status)
 */
export function getConfirmedIssues(workDir = process.cwd()): Issue[] {
	return filterIssuesByStatuses(["CONFIRMED", "PARTIAL"], workDir);
}

/**
 * Get all unvalidated issues
 */
export function getUnvalidatedIssues(workDir = process.cwd()): Issue[] {
	return filterIssuesByStatus("UNVALIDATED", workDir);
}

/**
 * Get issues count by status
 */
export function countIssuesByStatus(workDir = process.cwd()): Record<IssueStatus, number> {
	const issues = loadIssues(workDir);

	const counts: Record<IssueStatus, number> = {
		UNVALIDATED: 0,
		CONFIRMED: 0,
		FALSE: 0,
		PARTIAL: 0,
		MISDIAGNOSED: 0,
	};

	for (const issue of issues) {
		counts[issue.status]++;
	}

	return counts;
}

/**
 * Check if an issue exists
 */
export function issueExists(id: string, workDir = process.cwd()): boolean {
	return readIssue(id, workDir) !== null;
}

/**
 * Get total issue count
 */
export function countIssues(workDir = process.cwd()): number {
	return loadIssues(workDir).length;
}

// ============================================================================
// CONCURRENT-SAFE UPDATE WITH SIMPLE FILE LOCKING
// ============================================================================

/** In-process mutex for issue updates */
const issueMutex = new AsyncMutex();

/**
 * Update a single issue with mutex locking.
 * Ensures atomic read-modify-write even when called concurrently.
 */
export async function updateIssueWithLock(
	id: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<Issue | null> {
	return issueMutex.run(() => updateIssue(id, update, workDir));
}

/**
 * Update multiple issues concurrently but safely
 * Each update is queued and executed in order
 *
 * @param updates - Map of issue ID to partial update
 * @param workDir - Working directory
 * @returns Array of updated issues (in order of completion)
 */
export async function updateIssuesConcurrently(
	updates: Array<{ id: string; update: Partial<Omit<Issue, "id" | "created_at">> }>,
	workDir = process.cwd(),
): Promise<Array<Issue | null>> {
	const results: Array<Issue | null> = [];

	for (const { id, update } of updates) {
		const result = await updateIssueWithLock(id, update, workDir);
		results.push(result);
	}

	return results;
}

/**
 * Immediately update a single issue after validation completes
 * This is the preferred method for p-limit based parallel processing
 * where each agent's result should be persisted immediately
 *
 * @param id - Issue ID
 * @param validationResult - Validation result containing status, evidence, etc.
 * @param workDir - Working directory
 * @returns Updated issue or null if not found
 */
export async function updateIssueFromValidation(
	id: string,
	validationResult: {
		status: IssueStatus;
		evidence?: Issue["evidence"];
		corrected_description?: string;
		validated_by?: string;
		severity?: Issue["severity"];
		strategy?: string;
	},
	workDir = process.cwd(),
): Promise<Issue | null> {
	return issueMutex.run(() => {
		const update: Partial<Omit<Issue, "id" | "created_at">> = {
			status: validationResult.status,
			validated_by: validationResult.validated_by || "IV",
		};

		if (validationResult.evidence && validationResult.evidence.length > 0) {
			// Read existing evidence inside the lock to prevent TOCTOU race
			const existing = readIssue(id, workDir);
			if (existing) {
				update.evidence = [...existing.evidence, ...validationResult.evidence];
			} else {
				update.evidence = validationResult.evidence;
			}
		}

		if (validationResult.corrected_description) {
			update.corrected_description = validationResult.corrected_description;
		}

		if (validationResult.severity) {
			update.severity = validationResult.severity;
		}

		if (validationResult.strategy) {
			update.strategy = validationResult.strategy;
		}

		// Use updateIssue directly since we already hold the mutex
		// (calling updateIssueWithLock would deadlock as AsyncMutex is non-reentrant)
		return updateIssue(id, update, workDir);
	});
}

// ============================================================================
// ISSUE FILTERING UTILITIES
// ============================================================================

/**
 * Severity order for comparison (higher number = higher severity)
 */
export const SEVERITY_ORDER: Record<Severity, number> = {
	CRITICAL: 4,
	HIGH: 3,
	MEDIUM: 2,
	LOW: 1,
};

/**
 * Filter options for issues
 */
export interface IssueFilterOptions {
	/** Specific issue IDs to include */
	issueIds?: string[];
	/** Issue IDs to exclude */
	excludeIssueIds?: string[];
	/** Minimum severity level */
	minSeverity?: Severity;
	/** Specific severity levels */
	severityFilter?: Severity[];
	/** Status filter (existing) */
	statusFilter?: IssueStatus[];
}

/**
 * Filter issues based on multiple criteria
 *
 * @param issues - Array of issues to filter
 * @param options - Filter options
 * @returns Filtered array of issues
 */
export function filterIssues(issues: Issue[], options: IssueFilterOptions): Issue[] {
	return issues.filter((issue) => {
		// Filter by specific IDs (whitelist)
		if (options.issueIds?.length && !options.issueIds.includes(issue.id)) {
			return false;
		}

		// Exclude by IDs (blacklist)
		if (options.excludeIssueIds?.includes(issue.id)) {
			return false;
		}

		// Filter by minimum severity
		if (options.minSeverity) {
			if (SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[options.minSeverity]) {
				return false;
			}
		}

		// Filter by specific severity levels
		if (options.severityFilter?.length && !options.severityFilter.includes(issue.severity)) {
			return false;
		}

		// Filter by status
		if (options.statusFilter?.length && !options.statusFilter.includes(issue.status)) {
			return false;
		}

		return true;
	});
}

/**
 * Build filter options from RuntimeOptions
 *
 * @param options - Runtime options from CLI
 * @param statusFilter - Optional status filter to apply
 * @returns IssueFilterOptions for use with filterIssues()
 */
export function buildFilterOptionsFromRuntime(
	options: RuntimeOptions,
	statusFilter?: IssueStatus[],
): IssueFilterOptions {
	return {
		issueIds: options.issueIds,
		excludeIssueIds: options.excludeIssueIds,
		minSeverity: options.minSeverity,
		severityFilter: options.severityFilter,
		statusFilter,
	};
}

// ============================================================================
// CROSS-PROCESS SAFE FUNCTIONS (using proper-lockfile)
// ============================================================================

/**
 * Update an issue with cross-process file locking for concurrent safety.
 *
 * This function uses proper-lockfile to ensure atomic read-modify-write
 * operations even when multiple milhouse processes access the same file.
 * Use this in scenarios where multiple processes might update issues
 * simultaneously (e.g., during parallel exec phase).
 *
 * @param runId - The run ID containing the issue
 * @param issueId - The ID of the issue to update
 * @param update - Partial issue data to update
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns The updated issue or null if not found
 *
 * @example
 * ```typescript
 * const updated = await updateIssueForRunSafe(runId, issueId, {
 *   status: 'CONFIRMED',
 *   evidence: [...newEvidence],
 * });
 * ```
 */
export async function updateIssueForRunSafe(
	runId: string,
	issueId: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<Issue | null> {
	const issuesPath = getIssuesPathForRun(runId, workDir);

	return withFileLock(issuesPath, () => {
		return updateIssueForRun(runId, issueId, update, workDir);
	});
}

/**
 * Batch update multiple issues with cross-process file locking.
 *
 * This function acquires a single lock and performs all updates atomically,
 * which is more efficient than calling updateIssueForRunSafe() multiple times.
 * Use this when you need to update multiple issues in a single operation.
 *
 * @param runId - The run ID containing the issues
 * @param updates - Array of issue updates with issueId and update data
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns Array of updated issues (null for issues not found)
 *
 * @example
 * ```typescript
 * const results = await batchUpdateIssuesForRunSafe(runId, [
 *   { issueId: 'P-abc123', update: { status: 'CONFIRMED' } },
 *   { issueId: 'P-def456', update: { status: 'FALSE' } },
 * ]);
 * ```
 */
export async function batchUpdateIssuesForRunSafe(
	runId: string,
	updates: Array<{ issueId: string; update: Partial<Omit<Issue, "id" | "created_at">> }>,
	workDir = process.cwd(),
): Promise<(Issue | null)[]> {
	const issuesPath = getIssuesPathForRun(runId, workDir);

	return withFileLock(issuesPath, () => {
		return updates.map(({ issueId, update }) => updateIssueForRun(runId, issueId, update, workDir));
	});
}
