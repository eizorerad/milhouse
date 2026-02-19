import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStatePathForCurrentRun } from "./paths.ts";
import { type ExecutionRecord, ExecutionRecordSchema } from "./types.ts";

/**
 * Get path to executions state file
 * Uses run-aware path resolution - returns run-specific path if a run is active
 */
function getExecutionsPath(workDir = process.cwd()): string {
	return getStatePathForCurrentRun("executions", workDir);
}

/**
 * Generate unique execution ID with exec- prefix
 */
export function generateExecutionId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `exec-${timestamp}-${random}`;
}

/**
 * Load raw executions from file without schema validation
 * Used for checking if file has data when loadExecutions returns empty
 */
export function loadRawExecutions(workDir = process.cwd()): unknown[] {
	const path = getExecutionsPath(workDir);
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
 * Load all executions from state file
 * Uses safeParse to handle invalid records gracefully instead of losing all data
 */
export function loadExecutions(workDir = process.cwd()): ExecutionRecord[] {
	const path = getExecutionsPath(workDir);

	if (!existsSync(path)) {
		return [];
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		if (!Array.isArray(parsed)) {
			return [];
		}

		// Parse each record individually to avoid losing all data if one is invalid
		const validRecords: ExecutionRecord[] = [];
		for (const item of parsed) {
			const result = ExecutionRecordSchema.safeParse(item);
			if (result.success) {
				validRecords.push(result.data);
			} else {
				// Log but don't fail - preserve other records
				console.error(
					`[WARN] Skipping invalid execution record ${item?.id || "unknown"}:`,
					result.error.message,
				);
			}
		}
		return validRecords;
	} catch (error) {
		console.error(`[ERROR] Failed to load executions from ${path}:`, error);
		return [];
	}
}

/**
 * Save executions array to state file
 */
export function saveExecutions(executions: ExecutionRecord[], workDir = process.cwd()): void {
	const path = getExecutionsPath(workDir);
	const dir = join(path, "..");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(path, JSON.stringify(executions, null, 2));
}

/**
 * Create a new execution record
 */
export function createExecution(
	execution: Omit<ExecutionRecord, "id">,
	workDir = process.cwd(),
): ExecutionRecord {
	const executions = loadExecutions(workDir);

	const newExecution: ExecutionRecord = {
		...execution,
		id: generateExecutionId(),
	};

	saveExecutions([...executions, newExecution], workDir);
	return newExecution;
}

/**
 * Read a single execution by ID
 */
export function readExecution(id: string, workDir = process.cwd()): ExecutionRecord | null {
	const executions = loadExecutions(workDir);
	return executions.find((e) => e.id === id) || null;
}

/**
 * Update an existing execution
 */
export function updateExecution(
	id: string,
	update: Partial<Omit<ExecutionRecord, "id">>,
	workDir = process.cwd(),
): ExecutionRecord | null {
	const executions = loadExecutions(workDir);
	const index = executions.findIndex((e) => e.id === id);

	if (index === -1) {
		return null;
	}

	const updated: ExecutionRecord = {
		...executions[index],
		...update,
	};

	const newExecutions = [...executions.slice(0, index), updated, ...executions.slice(index + 1)];
	saveExecutions(newExecutions, workDir);
	return updated;
}

/**
 * Delete an execution by ID
 */
export function deleteExecution(id: string, workDir = process.cwd()): boolean {
	const executions = loadExecutions(workDir);
	const index = executions.findIndex((e) => e.id === id);

	if (index === -1) {
		return false;
	}

	const newExecutions = [...executions.slice(0, index), ...executions.slice(index + 1)];
	saveExecutions(newExecutions, workDir);
	return true;
}

/**
 * Check if an execution exists
 */
export function executionExists(id: string, workDir = process.cwd()): boolean {
	return readExecution(id, workDir) !== null;
}

/**
 * Get total execution count
 */
export function countExecutions(workDir = process.cwd()): number {
	return loadExecutions(workDir).length;
}

// ============================================
// Filtering Functions
// ============================================

/**
 * Get executions by task ID
 */
export function getExecutionsByTaskId(taskId: string, workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.task_id === taskId);
}

/**
 * Get executions by agent role
 */
export function getExecutionsByAgentRole(
	agentRole: string,
	workDir = process.cwd(),
): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.agent_role === agentRole);
}

/**
 * Get successful executions
 */
export function getSuccessfulExecutions(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.success === true);
}

/**
 * Get failed executions
 */
export function getFailedExecutions(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.success === false);
}

/**
 * Get pending executions (not yet completed)
 */
export function getPendingExecutions(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.completed_at === undefined);
}

/**
 * Get completed executions (has completed_at timestamp)
 */
export function getCompletedExecutions(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.completed_at !== undefined);
}

/**
 * Get executions with PRs
 */
export function getExecutionsWithPRs(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.pr_url !== undefined && e.pr_url !== "");
}

/**
 * Get executions with follow-up tasks
 */
export function getExecutionsWithFollowUps(workDir = process.cwd()): ExecutionRecord[] {
	const executions = loadExecutions(workDir);
	return executions.filter((e) => e.follow_up_task_ids.length > 0);
}

// ============================================
// Statistics Functions
// ============================================

/**
 * Get execution statistics
 */
export function getExecutionStats(workDir = process.cwd()): {
	total: number;
	successful: number;
	failed: number;
	pending: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	averageInputTokens: number;
	averageOutputTokens: number;
} {
	const executions = loadExecutions(workDir);
	const completed = executions.filter((e) => e.completed_at !== undefined);
	const successful = executions.filter((e) => e.success === true);
	const failed = executions.filter((e) => e.success === false);
	const pending = executions.filter((e) => e.completed_at === undefined);

	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	for (const exec of executions) {
		totalInputTokens += exec.input_tokens;
		totalOutputTokens += exec.output_tokens;
	}

	const completedCount = completed.length;

	return {
		total: executions.length,
		successful: successful.length,
		failed: failed.length,
		pending: pending.length,
		totalInputTokens,
		totalOutputTokens,
		averageInputTokens: completedCount > 0 ? Math.round(totalInputTokens / completedCount) : 0,
		averageOutputTokens: completedCount > 0 ? Math.round(totalOutputTokens / completedCount) : 0,
	};
}

/**
 * Count executions by success status
 */
export function countExecutionsBySuccess(workDir = process.cwd()): {
	successful: number;
	failed: number;
	pending: number;
} {
	const executions = loadExecutions(workDir);

	let successful = 0;
	let failed = 0;
	let pending = 0;

	for (const exec of executions) {
		if (exec.completed_at === undefined) {
			pending++;
		} else if (exec.success === true) {
			successful++;
		} else {
			failed++;
		}
	}

	return { successful, failed, pending };
}

/**
 * Get total token usage across all executions
 */
export function getTotalTokenUsage(workDir = process.cwd()): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
} {
	const executions = loadExecutions(workDir);

	let inputTokens = 0;
	let outputTokens = 0;

	for (const exec of executions) {
		inputTokens += exec.input_tokens;
		outputTokens += exec.output_tokens;
	}

	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
	};
}

// ============================================
// Query Functions
// ============================================

/**
 * Get the latest execution for a task
 */
export function getLatestExecutionForTask(
	taskId: string,
	workDir = process.cwd(),
): ExecutionRecord | null {
	const executions = getExecutionsByTaskId(taskId, workDir);

	if (executions.length === 0) {
		return null;
	}

	// Sort by started_at descending and return the first
	const sorted = [...executions].sort(
		(a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
	);

	return sorted[0] || null;
}

/**
 * Get executions within a time range
 */
export function getExecutionsInTimeRange(
	startTime: Date,
	endTime: Date,
	workDir = process.cwd(),
): ExecutionRecord[] {
	const executions = loadExecutions(workDir);

	return executions.filter((e) => {
		const execTime = new Date(e.started_at).getTime();
		return execTime >= startTime.getTime() && execTime <= endTime.getTime();
	});
}

/**
 * Get executions sorted by start time (newest first)
 */
export function getExecutionsSortedByTime(
	workDir = process.cwd(),
	ascending = false,
): ExecutionRecord[] {
	const executions = loadExecutions(workDir);

	return [...executions].sort((a, b) => {
		const timeA = new Date(a.started_at).getTime();
		const timeB = new Date(b.started_at).getTime();
		return ascending ? timeA - timeB : timeB - timeA;
	});
}

/**
 * Get the most recent N executions
 */
export function getRecentExecutions(count: number, workDir = process.cwd()): ExecutionRecord[] {
	const sorted = getExecutionsSortedByTime(workDir, false);
	return sorted.slice(0, count);
}

// ============================================
// Execution Lifecycle Functions
// ============================================

/**
 * Start a new execution for a task
 */
export function startExecution(
	taskId: string,
	agentRole: string,
	workDir = process.cwd(),
): ExecutionRecord {
	return createExecution(
		{
			task_id: taskId,
			started_at: new Date().toISOString(),
			agent_role: agentRole,
			input_tokens: 0,
			output_tokens: 0,
			follow_up_task_ids: [],
		},
		workDir,
	);
}

/**
 * Complete an execution successfully
 */
export function completeExecution(
	id: string,
	inputTokens: number,
	outputTokens: number,
	commitSha?: string,
	branch?: string,
	prUrl?: string,
	workDir = process.cwd(),
): ExecutionRecord | null {
	return updateExecution(
		id,
		{
			completed_at: new Date().toISOString(),
			success: true,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			commit_sha: commitSha,
			branch,
			pr_url: prUrl,
		},
		workDir,
	);
}

/**
 * Fail an execution
 */
export function failExecution(
	id: string,
	error: string,
	inputTokens: number,
	outputTokens: number,
	workDir = process.cwd(),
): ExecutionRecord | null {
	return updateExecution(
		id,
		{
			completed_at: new Date().toISOString(),
			success: false,
			error,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
		},
		workDir,
	);
}

/**
 * Add follow-up tasks to an execution
 */
export function addFollowUpTasks(
	id: string,
	taskIds: string[],
	workDir = process.cwd(),
): ExecutionRecord | null {
	const execution = readExecution(id, workDir);

	if (!execution) {
		return null;
	}

	const newFollowUps = [...new Set([...execution.follow_up_task_ids, ...taskIds])];

	return updateExecution(id, { follow_up_task_ids: newFollowUps }, workDir);
}

// ============================================
// Cleanup Functions
// ============================================

/**
 * Delete all executions for a task
 */
export function deleteExecutionsForTask(taskId: string, workDir = process.cwd()): number {
	const executions = loadExecutions(workDir);
	const filtered = executions.filter((e) => e.task_id !== taskId);
	const deletedCount = executions.length - filtered.length;

	if (deletedCount > 0) {
		saveExecutions(filtered, workDir);
	}

	return deletedCount;
}

/**
 * Delete failed executions
 */
export function deleteFailedExecutions(workDir = process.cwd()): number {
	const executions = loadExecutions(workDir);
	const filtered = executions.filter((e) => e.success !== false);
	const deletedCount = executions.length - filtered.length;

	if (deletedCount > 0) {
		saveExecutions(filtered, workDir);
	}

	return deletedCount;
}

/**
 * Delete executions older than a certain date
 */
export function deleteExecutionsOlderThan(date: Date, workDir = process.cwd()): number {
	const executions = loadExecutions(workDir);
	const filtered = executions.filter((e) => new Date(e.started_at).getTime() >= date.getTime());
	const deletedCount = executions.length - filtered.length;

	if (deletedCount > 0) {
		saveExecutions(filtered, workDir);
	}

	return deletedCount;
}

/**
 * Clear all executions
 */
export function clearAllExecutions(workDir = process.cwd()): number {
	const executions = loadExecutions(workDir);
	const count = executions.length;

	if (count > 0) {
		saveExecutions([], workDir);
	}

	return count;
}
