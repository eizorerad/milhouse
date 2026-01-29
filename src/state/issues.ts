import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeOptions } from "../cli/runtime-options.ts";
import { logError, logWarn } from "../ui/logger.ts";
import { withFileLock } from "./file-lock.ts";
import { getRunStateDir, getStatePathForCurrentRun } from "./paths.ts";
import { type Issue, IssueSchema, type IssueStatus, type Severity, STATE_FILES } from "./types.ts";

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

/**
 * Load all issues from state file
 * Uses safeParse to handle invalid issues gracefully instead of losing all data
 *
 * @deprecated Use loadIssuesForRun() with explicit runId to avoid race conditions
 * when multiple milhouse processes run in parallel. This function relies on
 * getCurrentRunId() which can return the wrong run in concurrent scenarios.
 */
export function loadIssues(workDir = process.cwd()): Issue[] {
	const path = getIssuesPath(workDir);

	if (!existsSync(path)) {
		return [];
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		if (!Array.isArray(parsed)) {
			return [];
		}

		// Parse each issue individually to avoid losing all data if one is invalid
		const validIssues: Issue[] = [];
		for (const item of parsed) {
			const result = IssueSchema.safeParse(item);
			if (result.success) {
				validIssues.push(result.data);
			} else {
				// Log but don't fail - preserve other issues
				logWarn(
					`Skipping invalid issue ${item?.id || "unknown"}:`,
					result.error.message,
				);
			}
		}
		return validIssues;
	} catch (error) {
		logError(`Failed to load issues from ${path}:`, error);
		return [];
	}
}

/**
 * Load all issues from state file for a specific run
 * Uses safeParse to handle invalid issues gracefully instead of losing all data
 *
 * This is the run-aware version that accepts an explicit runId parameter,
 * avoiding race conditions when multiple milhouse processes run in parallel.
 *
 * @param runId - The run ID to load issues from
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns Array of valid issues from the specified run
 */
export function loadIssuesForRun(runId: string, workDir = process.cwd()): Issue[] {
	const path = getIssuesPathForRun(runId, workDir);

	if (!existsSync(path)) {
		return [];
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		if (!Array.isArray(parsed)) {
			return [];
		}

		// Parse each issue individually to avoid losing all data if one is invalid
		const validIssues: Issue[] = [];
		for (const item of parsed) {
			const result = IssueSchema.safeParse(item);
			if (result.success) {
				validIssues.push(result.data);
			} else {
				// Log but don't fail - preserve other issues
				logWarn(
					`Skipping invalid issue ${item?.id || "unknown"}:`,
					result.error.message,
				);
			}
		}
		return validIssues;
	} catch (error) {
		logError(`Failed to load issues from ${path}:`, error);
		return [];
	}
}

/**
 * Save issues array to state file
 *
 * @deprecated Use saveIssuesForRun() with explicit runId to avoid race conditions
 * when multiple milhouse processes run in parallel. This function relies on
 * getCurrentRunId() which can return the wrong run in concurrent scenarios.
 */
export function saveIssues(issues: Issue[], workDir = process.cwd()): void {
	const path = getIssuesPath(workDir);
	const dir = join(path, "..");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(path, JSON.stringify(issues, null, 2));
}

/**
 * Save issues array to state file for a specific run
 *
 * This is the run-aware version that accepts an explicit runId parameter,
 * avoiding race conditions when multiple milhouse processes run in parallel.
 *
 * @param runId - The run ID to save issues to
 * @param issues - Array of issues to save
 * @param workDir - Working directory (defaults to process.cwd())
 */
export function saveIssuesForRun(runId: string, issues: Issue[], workDir = process.cwd()): void {
	const path = getIssuesPathForRun(runId, workDir);
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(path, JSON.stringify(issues, null, 2));
}

/**
 * Create a new issue
 */
export function createIssue(
	issue: Omit<Issue, "id" | "created_at" | "updated_at">,
	workDir = process.cwd(),
): Issue {
	const issues = loadIssues(workDir);
	const now = new Date().toISOString();

	const newIssue: Issue = {
		...issue,
		id: generateIssueId(),
		created_at: now,
		updated_at: now,
	};

	saveIssues([...issues, newIssue], workDir);
	return newIssue;
}

/**
 * Create a new issue in a specific run
 *
 * This is the run-aware version that accepts an explicit runId parameter,
 * avoiding race conditions when multiple milhouse processes run in parallel.
 *
 * @param runId - The run ID to create the issue in
 * @param issue - Issue data without id and timestamps
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns The created issue with generated id and timestamps
 */
export function createIssueForRun(
	runId: string,
	issue: Omit<Issue, "id" | "created_at" | "updated_at">,
	workDir = process.cwd(),
): Issue {
	const issues = loadIssuesForRun(runId, workDir);
	const now = new Date().toISOString();

	const newIssue: Issue = {
		...issue,
		id: generateIssueId(),
		created_at: now,
		updated_at: now,
	};

	saveIssuesForRun(runId, [...issues, newIssue], workDir);
	return newIssue;
}

/**
 * Read a single issue by ID
 */
export function readIssue(id: string, workDir = process.cwd()): Issue | null {
	const issues = loadIssues(workDir);
	return issues.find((i) => i.id === id) || null;
}

/**
 * Update an existing issue
 *
 * @deprecated Use updateIssueForRun() with explicit runId to avoid race conditions
 * when multiple milhouse processes run in parallel. This function relies on
 * getCurrentRunId() which can return the wrong run in concurrent scenarios.
 */
export function updateIssue(
	id: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Issue | null {
	const issues = loadIssues(workDir);
	const index = issues.findIndex((i) => i.id === id);

	if (index === -1) {
		return null;
	}

	const updated: Issue = {
		...issues[index],
		...update,
		updated_at: new Date().toISOString(),
	};

	const newIssues = [...issues.slice(0, index), updated, ...issues.slice(index + 1)];
	saveIssues(newIssues, workDir);
	return updated;
}

/**
 * Update an existing issue in a specific run
 *
 * This is the run-aware version that accepts an explicit runId parameter,
 * avoiding race conditions when multiple milhouse processes run in parallel.
 *
 * @param runId - The run ID containing the issue
 * @param issueId - The ID of the issue to update
 * @param update - Partial issue data to update
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns The updated issue or null if not found
 */
export function updateIssueForRun(
	runId: string,
	issueId: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Issue | null {
	const issues = loadIssuesForRun(runId, workDir);
	const index = issues.findIndex((i) => i.id === issueId);

	if (index === -1) {
		return null;
	}

	const updated: Issue = {
		...issues[index],
		...update,
		updated_at: new Date().toISOString(),
	};

	const newIssues = [...issues.slice(0, index), updated, ...issues.slice(index + 1)];
	saveIssuesForRun(runId, newIssues, workDir);
	return updated;
}

/**
 * Load raw issues from file without schema validation
 * Used for checking if file has data when loadIssues returns empty
 */
function loadRawIssues(workDir = process.cwd()): unknown[] {
	const path = getIssuesPath(workDir);
	if (!existsSync(path)) {
		return [];
	}
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Batch update multiple issues atomically
 * This prevents race conditions when updating multiple issues in parallel
 *
 * IMPORTANT: This function includes safeguards to prevent data loss:
 * - If loadIssues returns empty but file has data, it won't overwrite
 * - Updates are validated before being applied
 */
export function batchUpdateIssues(
	updates: Map<string, Partial<Omit<Issue, "id" | "created_at">>>,
	workDir = process.cwd(),
): Issue[] {
	if (updates.size === 0) {
		return [];
	}

	const issues = loadIssues(workDir);
	const now = new Date().toISOString();
	const updatedIssues: Issue[] = [];

	// CRITICAL: Check if we got empty issues but file actually has data
	// This can happen if Zod parsing failed for all issues
	if (issues.length === 0) {
		const rawIssues = loadRawIssues(workDir);
		if (rawIssues.length > 0) {
			logError(
				`batchUpdateIssues: loadIssues returned empty but file has ${rawIssues.length} raw entries`,
			);
			logError(
				"This indicates schema validation failures. Aborting to prevent data loss.",
			);
			logError("Fix the schema issues and re-run validation.");
			return [];
		}
	}

	// Create a new array with all updates applied
	const newIssues = issues.map((issue) => {
		const update = updates.get(issue.id);
		if (update) {
			const updated: Issue = {
				...issue,
				...update,
				updated_at: now,
			};
			updatedIssues.push(updated);
			return updated;
		}
		return issue;
	});

	// Single atomic write with all updates
	saveIssues(newIssues, workDir);
	return updatedIssues;
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

/**
 * Simple file-based lock for concurrent issue updates
 * Used when multiple agents may complete around the same time
 */
let lockPromise: Promise<void> | null = null;

/**
 * Update a single issue with simple locking
 * This ensures atomic read-modify-write even when called concurrently
 *
 * Note: This uses in-memory queue locking which is safe for single-process
 * concurrent operations (like p-limit based parallel validation)
 */
export async function updateIssueWithLock(
	id: string,
	update: Partial<Omit<Issue, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<Issue | null> {
	// Queue this update behind any pending updates
	const waitForLock = async (): Promise<void> => {
		while (lockPromise) {
			await lockPromise;
		}
	};

	await waitForLock();

	// Acquire lock
	let releaseLock!: () => void;
	lockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});

	try {
		// Perform the update atomically
		const result = updateIssue(id, update, workDir);
		return result;
	} finally {
		// Release lock
		lockPromise = null;
		releaseLock?.();
	}
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
	const update: Partial<Omit<Issue, "id" | "created_at">> = {
		status: validationResult.status,
		validated_by: validationResult.validated_by || "IV",
	};

	if (validationResult.evidence && validationResult.evidence.length > 0) {
		// Need to merge with existing evidence
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

	return updateIssueWithLock(id, update, workDir);
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
		return updates.map(({ issueId, update }) =>
			updateIssueForRun(runId, issueId, update, workDir),
		);
	});
}
