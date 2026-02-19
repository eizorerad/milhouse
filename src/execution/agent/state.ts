/**
 * Execution State Management
 *
 * State machine for tracking execution progress.
 *
 * @module execution/agent/state
 * @since 5.0.0
 */

import type { Task } from "../../state/types.ts";

// ============================================================================
// Execution State Types
// ============================================================================

/**
 * Execution state for tracking progress
 */
export interface ExecutionState {
	/** Current phase of execution */
	phase: "idle" | "preparing" | "executing" | "verifying" | "completed" | "failed";
	/** Current parallel group being executed */
	currentGroup: number;
	/** Tasks currently running */
	runningTaskIds: string[];
	/** Tasks waiting to be executed */
	pendingTaskIds: string[];
	/** Tasks that completed successfully */
	completedTaskIds: string[];
	/** Tasks that failed */
	failedTaskIds: string[];
	/** Tasks that were skipped */
	skippedTaskIds: string[];
	/** Start time of execution */
	startedAt?: string;
	/** End time of execution */
	completedAt?: string;
	/** Error message if execution failed */
	error?: string;
}

// ============================================================================
// State Factory Functions
// ============================================================================

/**
 * Create initial execution state
 */
export function createInitialExecutionState(taskIds: string[]): ExecutionState {
	return {
		phase: "idle",
		currentGroup: 1,
		runningTaskIds: [],
		pendingTaskIds: [...taskIds],
		completedTaskIds: [],
		failedTaskIds: [],
		skippedTaskIds: [],
	};
}

// ============================================================================
// State Transition Functions (Immutable)
// ============================================================================

/**
 * Update execution state when starting execution
 */
export function startExecution(state: ExecutionState): ExecutionState {
	return {
		...state,
		phase: "preparing",
		startedAt: new Date().toISOString(),
	};
}

/**
 * Update execution state when task starts
 */
export function startTask(state: ExecutionState, taskId: string): ExecutionState {
	return {
		...state,
		phase: "executing",
		runningTaskIds: [...state.runningTaskIds, taskId],
		pendingTaskIds: state.pendingTaskIds.filter((id) => id !== taskId),
	};
}

/**
 * Update execution state when task completes
 */
export function completeTask(state: ExecutionState, taskId: string): ExecutionState {
	return {
		...state,
		runningTaskIds: state.runningTaskIds.filter((id) => id !== taskId),
		completedTaskIds: [...state.completedTaskIds, taskId],
	};
}

/**
 * Update execution state when task fails
 */
export function failTask(state: ExecutionState, taskId: string): ExecutionState {
	return {
		...state,
		runningTaskIds: state.runningTaskIds.filter((id) => id !== taskId),
		failedTaskIds: [...state.failedTaskIds, taskId],
	};
}

/**
 * Update execution state when task is skipped
 */
export function skipTask(state: ExecutionState, taskId: string): ExecutionState {
	return {
		...state,
		pendingTaskIds: state.pendingTaskIds.filter((id) => id !== taskId),
		skippedTaskIds: [...state.skippedTaskIds, taskId],
	};
}

/**
 * Update execution state when moving to next group
 */
export function advanceToNextGroup(state: ExecutionState): ExecutionState {
	return {
		...state,
		currentGroup: state.currentGroup + 1,
	};
}

/**
 * Update execution state when execution completes
 */
export function completeExecution(state: ExecutionState): ExecutionState {
	return {
		...state,
		phase: state.failedTaskIds.length > 0 ? "failed" : "completed",
		completedAt: new Date().toISOString(),
	};
}

// ============================================================================
// State Query Functions
// ============================================================================

/**
 * Check if execution is complete
 */
export function isExecutionComplete(state: ExecutionState): boolean {
	return state.pendingTaskIds.length === 0 && state.runningTaskIds.length === 0;
}

/**
 * Check if execution has failures
 */
export function hasExecutionFailures(state: ExecutionState): boolean {
	return state.failedTaskIds.length > 0;
}

/**
 * Get execution progress percentage
 */
export function getExecutionProgress(state: ExecutionState): number {
	const total =
		state.pendingTaskIds.length +
		state.runningTaskIds.length +
		state.completedTaskIds.length +
		state.failedTaskIds.length +
		state.skippedTaskIds.length;

	if (total === 0) {
		return 100;
	}

	const completed =
		state.completedTaskIds.length + state.failedTaskIds.length + state.skippedTaskIds.length;
	return Math.round((completed / total) * 100);
}

// ============================================================================
// Task Readiness Checks
// ============================================================================

/**
 * Check if a task is ready for execution
 */
export function isTaskReady(task: Task, allTasks: Task[], completedTaskIds: string[]): boolean {
	// Task must be pending
	if (task.status !== "pending") {
		return false;
	}

	// All dependencies must be completed
	const completedSet = new Set(completedTaskIds);
	return task.depends_on.every((depId) => completedSet.has(depId));
}

/**
 * Get all tasks ready for execution
 */
export function getReadyTasksForExecution(tasks: Task[], completedTaskIds: string[]): Task[] {
	return tasks.filter((task) => isTaskReady(task, tasks, completedTaskIds));
}

/**
 * Get ready tasks from a specific parallel group
 */
export function getReadyTasksInGroup(
	tasks: Task[],
	group: number,
	completedTaskIds: string[],
): Task[] {
	const groupTasks = tasks.filter((t) => t.parallel_group === group);
	return groupTasks.filter((task) => isTaskReady(task, tasks, completedTaskIds));
}

/**
 * Get blocked tasks (pending but dependencies not met)
 */
export function getBlockedTasksForExecution(tasks: Task[], completedTaskIds: string[]): Task[] {
	const completedSet = new Set(completedTaskIds);
	return tasks.filter(
		(task) =>
			task.status === "pending" &&
			task.depends_on.length > 0 &&
			!task.depends_on.every((depId) => completedSet.has(depId)),
	);
}

/**
 * Get unsatisfied dependencies for a task
 */
export function getUnsatisfiedDependencies(task: Task, completedTaskIds: string[]): string[] {
	const completedSet = new Set(completedTaskIds);
	return task.depends_on.filter((depId) => !completedSet.has(depId));
}

// ============================================================================
// Execution Validation
// ============================================================================

/**
 * Validation result for execution
 */
export interface ExecutionValidation {
	/** Whether execution can proceed */
	valid: boolean;
	/** Warning messages */
	warnings: string[];
	/** Error messages (blocking) */
	errors: string[];
	/** Tasks that can be executed */
	executableTasks: string[];
	/** Tasks that are blocked */
	blockedTasks: string[];
}

/**
 * Validate tasks for execution
 */
export function validateTasksForExecution(tasks: Task[]): ExecutionValidation {
	const warnings: string[] = [];
	const errors: string[] = [];
	const executableTasks: string[] = [];
	const blockedTasks: string[] = [];

	// Check for pending tasks
	const pendingTasks = tasks.filter((t) => t.status === "pending");
	if (pendingTasks.length === 0) {
		errors.push("No pending tasks to execute");
		return { valid: false, warnings, errors, executableTasks, blockedTasks };
	}

	// Check for circular dependencies
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	for (const task of tasks) {
		const visited = new Set<string>();
		const stack = new Set<string>();

		function hasCycle(id: string): boolean {
			if (stack.has(id)) return true;
			if (visited.has(id)) return false;

			visited.add(id);
			stack.add(id);

			const t = taskMap.get(id);
			if (t) {
				for (const depId of t.depends_on) {
					if (hasCycle(depId)) return true;
				}
			}

			stack.delete(id);
			return false;
		}

		if (hasCycle(task.id)) {
			errors.push(`Circular dependency detected involving task ${task.id}`);
		}
	}

	if (errors.length > 0) {
		return { valid: false, warnings, errors, executableTasks, blockedTasks };
	}

	// Check for missing dependencies
	const taskIds = new Set(tasks.map((t) => t.id));
	for (const task of tasks) {
		for (const depId of task.depends_on) {
			if (!taskIds.has(depId)) {
				warnings.push(`Task ${task.id} depends on non-existent task ${depId}`);
			}
		}
	}

	// Categorize tasks
	const completedIds = tasks.filter((t) => t.status === "done").map((t) => t.id);
	for (const task of pendingTasks) {
		if (isTaskReady(task, tasks, completedIds)) {
			executableTasks.push(task.id);
		} else {
			blockedTasks.push(task.id);
		}
	}

	if (executableTasks.length === 0) {
		errors.push("No tasks are ready for execution (all pending tasks are blocked)");
		return { valid: false, warnings, errors, executableTasks, blockedTasks };
	}

	return { valid: true, warnings, errors, executableTasks, blockedTasks };
}
