import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateEvents } from "./events.ts";
import { getStatePathForCurrentRun } from "./paths.ts";
import { type Task, TaskSchema, type TaskStatus } from "./types.ts";

/**
 * Get path to tasks state file
 * Uses run-aware path resolution - returns run-specific path if a run is active
 */
function getTasksPath(workDir = process.cwd()): string {
	return getStatePathForCurrentRun("tasks", workDir);
}

/**
 * Generate unique task ID with optional issue prefix
 * Format: {issue_id}-T{n} or FIX-T{n}
 *
 * Uses the highest existing task number + 1 to avoid collisions when
 * tasks are deleted or when non-sequential task IDs exist.
 */
export function generateTaskId(issueId?: string, existingTasks: Task[] = []): string {
	const prefix = issueId || "FIX";

	// Filter tasks that belong to this issue (or have no issue_id for FIX tasks)
	const relevantTasks = existingTasks.filter((t) =>
		issueId ? t.issue_id === issueId : !t.issue_id,
	);

	// Extract task numbers from IDs matching the pattern {prefix}-T{n}
	const pattern = new RegExp(`^${escapeRegExp(prefix)}-T(\\d+)$`);
	let highestNumber = 0;

	for (const task of relevantTasks) {
		const match = task.id.match(pattern);
		if (match) {
			const num = Number.parseInt(match[1], 10);
			if (num > highestNumber) {
				highestNumber = num;
			}
		}
	}

	return `${prefix}-T${highestNumber + 1}`;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Load raw tasks from file without schema validation
 * Used for checking if file has data when loadTasks returns empty
 */
export function loadRawTasks(workDir = process.cwd()): unknown[] {
	const path = getTasksPath(workDir);
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
 * Load tasks from a specific file path with schema validation
 * Used by gates/dod.ts which needs to load from custom paths
 * Also handles object with tasks array format for compat
 */
export function loadTasksFromPath(fullPath: string): Task[] {
	if (!existsSync(fullPath)) {
		return [];
	}

	try {
		const content = readFileSync(fullPath, "utf-8");
		const data = JSON.parse(content);

		// Handle both array format and object with tasks array
		// Guard against null/undefined data from JSON.parse
		const rawTasks = Array.isArray(data)
			? data
			: data !== null && typeof data === "object" && Array.isArray(data.tasks)
				? data.tasks
				: [];

		// Parse each task individually to avoid losing all data if one is invalid
		const validTasks: Task[] = [];
		for (const item of rawTasks) {
			const result = TaskSchema.safeParse(item);
			if (result.success) {
				validTasks.push(result.data);
			} else {
				// Log but don't fail - preserve other tasks
				console.error(
					`[WARN] Skipping invalid task ${item?.id || "unknown"}:`,
					result.error.message,
				);
			}
		}
		return validTasks;
	} catch (error) {
		console.error(`[ERROR] Failed to load tasks from ${fullPath}:`, error);
		return [];
	}
}

/**
 * Load all tasks from state file
 * Uses safeParse to handle invalid tasks gracefully instead of losing all data
 */
export function loadTasks(workDir = process.cwd()): Task[] {
	const filePath = getTasksPath(workDir);
	return loadTasksFromPath(filePath);
}

/**
 * Save tasks array to state file
 *
 * Note: Warns if saving empty array when file has existing data.
 * This provides defense-in-depth for bulk operations but allows
 * intentional clearing (callers may want to reset tasks).
 */
export function saveTasks(tasks: Task[], workDir = process.cwd()): void {
	const filePath = getTasksPath(workDir);
	const dir = join(filePath, "..");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Warn on suspicious empty write (but allow it - callers may intentionally clear)
	if (tasks.length === 0 && existsSync(filePath)) {
		const rawTasks = loadRawTasks(workDir);
		if (rawTasks.length > 0) {
			console.error(
				`[WARN] saveTasks: Saving empty array but file has ${rawTasks.length} raw entries`,
			);
			console.error("[WARN] This may indicate unintended data loss. Check callers.");
		}
	}

	writeFileSync(filePath, JSON.stringify(tasks, null, 2));
}

/**
 * Create a new task
 */
export function createTask(
	task: Omit<Task, "id" | "created_at" | "updated_at">,
	workDir = process.cwd(),
): Task {
	const tasks = loadTasks(workDir);
	const now = new Date().toISOString();

	const newTask: Task = {
		...task,
		id: generateTaskId(task.issue_id, tasks),
		created_at: now,
		updated_at: now,
	};

	saveTasks([...tasks, newTask], workDir);
	return newTask;
}

/**
 * Read a single task by ID
 */
export function readTask(id: string, workDir = process.cwd()): Task | null {
	const tasks = loadTasks(workDir);
	return tasks.find((t) => t.id === id) || null;
}

/**
 * Update an existing task
 *
 * IMPORTANT: This function includes safeguards to prevent data loss:
 * - If loadTasks returns empty but file has data, it won't overwrite
 */
export function updateTask(
	id: string,
	update: Partial<Omit<Task, "id" | "created_at">>,
	workDir = process.cwd(),
): Task | null {
	const tasks = loadTasks(workDir);

	// CRITICAL: Check if we got empty tasks but file actually has data
	// This can happen if Zod parsing failed for all tasks
	if (tasks.length === 0) {
		const rawTasks = loadRawTasks(workDir);
		if (rawTasks.length > 0) {
			console.error(
				`[ERROR] updateTask: loadTasks returned empty but file has ${rawTasks.length} raw entries`,
			);
			console.error(
				"[ERROR] This indicates schema validation failures. Aborting to prevent data loss.",
			);
			return null;
		}
	}

	const index = tasks.findIndex((t) => t.id === id);

	if (index === -1) {
		return null;
	}

	const updated: Task = {
		...tasks[index],
		...update,
		updated_at: new Date().toISOString(),
	};

	const newTasks = [...tasks.slice(0, index), updated, ...tasks.slice(index + 1)];
	saveTasks(newTasks, workDir);
	return updated;
}

/**
 * Delete a task by ID
 */
export function deleteTask(id: string, workDir = process.cwd()): boolean {
	const tasks = loadTasks(workDir);
	const index = tasks.findIndex((t) => t.id === id);

	if (index === -1) {
		return false;
	}

	const newTasks = [...tasks.slice(0, index), ...tasks.slice(index + 1)];
	saveTasks(newTasks, workDir);
	return true;
}

/**
 * Filter tasks by status
 */
export function filterTasksByStatus(status: TaskStatus, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	return tasks.filter((t) => t.status === status);
}

/**
 * Filter tasks by multiple statuses
 */
export function filterTasksByStatuses(statuses: TaskStatus[], workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	return tasks.filter((t) => statuses.includes(t.status));
}

/**
 * Get pending tasks
 */
export function getPendingTasks(workDir = process.cwd()): Task[] {
	return filterTasksByStatus("pending", workDir);
}

/**
 * Get completed tasks (done status)
 */
export function getCompletedTasks(workDir = process.cwd()): Task[] {
	return filterTasksByStatus("done", workDir);
}

/**
 * Get failed tasks
 */
export function getFailedTasks(workDir = process.cwd()): Task[] {
	return filterTasksByStatus("failed", workDir);
}

/**
 * Get blocked tasks
 */
export function getBlockedTasks(workDir = process.cwd()): Task[] {
	return filterTasksByStatus("blocked", workDir);
}

/**
 * Get tasks count by status
 */
export function countTasksByStatus(workDir = process.cwd()): Record<TaskStatus, number> {
	const tasks = loadTasks(workDir);

	const counts: Record<TaskStatus, number> = {
		pending: 0,
		blocked: 0,
		running: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		merge_error: 0,
	};

	for (const task of tasks) {
		counts[task.status]++;
	}

	return counts;
}

/**
 * Check if a task exists
 */
export function taskExists(id: string, workDir = process.cwd()): boolean {
	return readTask(id, workDir) !== null;
}

/**
 * Get total task count
 */
export function countTasks(workDir = process.cwd()): number {
	return loadTasks(workDir).length;
}

/**
 * Get tasks by issue ID
 */
export function getTasksByIssueId(issueId: string, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	return tasks.filter((t) => t.issue_id === issueId);
}

/**
 * Get tasks by parallel group
 */
export function getTasksByParallelGroup(group: number, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	return tasks.filter((t) => t.parallel_group === group);
}

/**
 * Get distinct parallel groups
 */
export function getParallelGroups(workDir = process.cwd()): number[] {
	const tasks = loadTasks(workDir);
	const groups = new Set<number>();
	for (const task of tasks) {
		groups.add(task.parallel_group);
	}
	return [...groups].sort((a, b) => a - b);
}

// ============================================
// Dependency Resolution Functions
// ============================================

/**
 * Check if all dependencies of a task are satisfied (completed)
 */
export function areDependenciesSatisfied(taskId: string, workDir = process.cwd()): boolean {
	const tasks = loadTasks(workDir);
	const task = tasks.find((t) => t.id === taskId);

	if (!task) {
		return false;
	}

	if (task.depends_on.length === 0) {
		return true;
	}

	return task.depends_on.every((depId) => {
		const dep = tasks.find((t) => t.id === depId);
		return dep?.status === "done";
	});
}

/**
 * Get tasks that are ready to execute (pending with satisfied dependencies)
 */
export function getReadyTasks(workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	const pending = tasks.filter((t) => t.status === "pending");

	return pending.filter((task) => {
		if (task.depends_on.length === 0) {
			return true;
		}

		return task.depends_on.every((depId) => {
			const dep = tasks.find((t) => t.id === depId);
			return dep?.status === "done";
		});
	});
}

/**
 * Get the next pending task respecting dependencies and parallel groups
 */
export function getNextPendingTask(workDir = process.cwd()): Task | null {
	const readyTasks = getReadyTasks(workDir);

	if (readyTasks.length === 0) {
		return null;
	}

	// Sort by parallel group, then by dependency count
	const sorted = [...readyTasks].sort((a, b) => {
		if (a.parallel_group !== b.parallel_group) {
			return a.parallel_group - b.parallel_group;
		}
		return a.depends_on.length - b.depends_on.length;
	});

	return sorted[0] || null;
}

/**
 * Get tasks that depend on a specific task
 */
export function getDependentTasks(taskId: string, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	return tasks.filter((t) => t.depends_on.includes(taskId));
}

/**
 * Get all dependencies of a task (direct dependencies)
 */
export function getTaskDependencies(taskId: string, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	const task = tasks.find((t) => t.id === taskId);

	if (!task) {
		return [];
	}

	return task.depends_on
		.map((depId) => tasks.find((t) => t.id === depId))
		.filter((t): t is Task => t !== undefined);
}

/**
 * Get all transitive dependencies of a task (recursive)
 */
export function getTransitiveDependencies(taskId: string, workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	const visited = new Set<string>();
	const result: Task[] = [];

	function collectDeps(id: string): void {
		const task = tasks.find((t) => t.id === id);
		if (!task) return;

		for (const depId of task.depends_on) {
			if (visited.has(depId)) continue;
			visited.add(depId);

			const depTask = tasks.find((t) => t.id === depId);
			if (depTask) {
				result.push(depTask);
				collectDeps(depId);
			}
		}
	}

	collectDeps(taskId);
	return result;
}

/**
 * Check for circular dependencies starting from a task
 */
export function hasCircularDependency(taskId: string, workDir = process.cwd()): boolean {
	const tasks = loadTasks(workDir);
	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function dfs(id: string): boolean {
		visited.add(id);
		recursionStack.add(id);

		const task = tasks.find((t) => t.id === id);
		if (!task) return false;

		for (const depId of task.depends_on) {
			if (!visited.has(depId)) {
				if (dfs(depId)) {
					return true;
				}
			} else if (recursionStack.has(depId)) {
				return true;
			}
		}

		recursionStack.delete(id);
		return false;
	}

	return dfs(taskId);
}

/**
 * Validate dependencies (check all referenced tasks exist)
 */
export function validateDependencies(
	taskId: string,
	workDir = process.cwd(),
): { valid: boolean; missing: string[] } {
	const tasks = loadTasks(workDir);
	const task = tasks.find((t) => t.id === taskId);

	if (!task) {
		return { valid: false, missing: [] };
	}

	const missing: string[] = [];
	for (const depId of task.depends_on) {
		if (!tasks.find((t) => t.id === depId)) {
			missing.push(depId);
		}
	}

	return { valid: missing.length === 0, missing };
}

/**
 * Add a dependency to a task
 */
export function addDependency(
	taskId: string,
	dependencyId: string,
	workDir = process.cwd(),
): Task | null {
	const tasks = loadTasks(workDir);
	const task = tasks.find((t) => t.id === taskId);
	const dependency = tasks.find((t) => t.id === dependencyId);

	if (!task || !dependency) {
		return null;
	}

	if (task.depends_on.includes(dependencyId)) {
		return task;
	}

	// Check if adding this dependency would create a cycle
	const newDeps = [...task.depends_on, dependencyId];
	const tempTask = { ...task, depends_on: newDeps };
	const index = tasks.findIndex((t) => t.id === taskId);
	const tempTasks = [...tasks.slice(0, index), tempTask, ...tasks.slice(index + 1)];
	saveTasks(tempTasks, workDir);

	if (hasCircularDependency(taskId, workDir)) {
		// Revert the change
		saveTasks(tasks, workDir);
		return null;
	}

	return updateTask(taskId, { depends_on: newDeps }, workDir);
}

/**
 * Remove a dependency from a task
 */
export function removeDependency(
	taskId: string,
	dependencyId: string,
	workDir = process.cwd(),
): Task | null {
	const task = readTask(taskId, workDir);

	if (!task) {
		return null;
	}

	const newDeps = task.depends_on.filter((id) => id !== dependencyId);

	if (newDeps.length === task.depends_on.length) {
		return task;
	}

	return updateTask(taskId, { depends_on: newDeps }, workDir);
}

/**
 * Topological sort of tasks respecting dependencies
 */
export function topologicalSort(workDir = process.cwd()): Task[] {
	const tasks = loadTasks(workDir);
	const visited = new Set<string>();
	const result: Task[] = [];

	function visit(id: string): void {
		if (visited.has(id)) return;
		visited.add(id);

		const task = tasks.find((t) => t.id === id);
		if (!task) return;

		for (const depId of task.depends_on) {
			visit(depId);
		}

		result.push(task);
	}

	for (const task of tasks) {
		visit(task.id);
	}

	return result;
}

/**
 * Update task status and handle dependent task blocking
 */
export function updateTaskStatus(
	taskId: string,
	status: TaskStatus,
	error?: string,
	workDir = process.cwd(),
): Task | null {
	const task = readTask(taskId, workDir);
	const previousStatus = task?.status;

	const update: Partial<Task> = { status };

	if (status === "done") {
		update.completed_at = new Date().toISOString();
	}

	if (status === "failed" && error) {
		update.error = error;
	}

	const updated = updateTask(taskId, update, workDir);

	if (!updated) {
		return null;
	}

	// Emit task:status:changed event
	stateEvents.emitTaskStatusChanged(taskId, status, previousStatus, updated.issue_id);

	// If task failed, mark dependent tasks as blocked
	if (status === "failed") {
		const dependents = getDependentTasks(taskId, workDir);
		for (const dependent of dependents) {
			if (dependent.status === "pending") {
				updateTask(dependent.id, { status: "blocked" }, workDir);
				stateEvents.emitTaskStatusChanged(dependent.id, "blocked", dependent.status, dependent.issue_id);
			}
		}
	}

	return updated;
}

/**
 * Get execution order based on parallel groups and dependencies
 */
export function getExecutionOrder(workDir = process.cwd()): Task[][] {
	const groups = getParallelGroups(workDir);
	const result: Task[][] = [];

	for (const group of groups) {
		const groupTasks = getTasksByParallelGroup(group, workDir);
		const sortedGroup = groupTasks.sort((a, b) => {
			// Tasks with fewer dependencies first within a group
			return a.depends_on.length - b.depends_on.length;
		});
		result.push(sortedGroup);
	}

	return result;
}

// ============================================================================
// CONCURRENT-SAFE UPDATE WITH SIMPLE QUEUE LOCKING
// ============================================================================

/**
 * Simple queue-based lock for concurrent task updates
 * Used when multiple agents may complete around the same time
 */
let lockPromise: Promise<void> | null = null;

/**
 * Update a single task with simple locking
 * This ensures atomic read-modify-write even when called concurrently
 *
 * Note: This uses in-memory queue locking which is safe for single-process
 * concurrent operations (like p-limit based parallel execution)
 */
export async function updateTaskWithLock(
	id: string,
	update: Partial<Omit<Task, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<Task | null> {
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
		const result = updateTask(id, update, workDir);
		return result;
	} finally {
		// Release lock
		lockPromise = null;
		releaseLock?.();
	}
}

/**
 * Update task status with locking and handle dependent task blocking
 * This is the concurrent-safe version of updateTaskStatus()
 *
 * Note: This uses in-memory queue locking which is safe for single-process
 * concurrent operations (like p-limit based parallel execution)
 */
export async function updateTaskStatusWithLock(
	taskId: string,
	status: TaskStatus,
	error?: string,
	workDir = process.cwd(),
): Promise<Task | null> {
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
		const update: Partial<Task> = { status };

		if (status === "done") {
			update.completed_at = new Date().toISOString();
		}

		if (status === "failed" && error) {
			update.error = error;
		}

		const updated = updateTask(taskId, update, workDir);

		if (!updated) {
			return null;
		}

		// If task failed, mark dependent tasks as blocked (atomically within the same lock)
		if (status === "failed") {
			const dependents = getDependentTasks(taskId, workDir);
			for (const dependent of dependents) {
				if (dependent.status === "pending") {
					updateTask(dependent.id, { status: "blocked" }, workDir);
				}
			}
		}

		return updated;
	} finally {
		// Release lock
		lockPromise = null;
		releaseLock?.();
	}
}
