/**
 * Lifecycle Hooks
 *
 * Provides default hook implementations and utilities for
 * composing and managing execution hooks.
 */

import { bus } from "../../events";
import { loggers } from "../../observability";
import type { Task } from "../../schemas/tasks.schema";
import type {
	BatchExecutionResult,
	ExecutionContext,
	ExecutionHooks,
	TaskExecutionResult,
} from "../strategies/types";
import type { HookConfig, IHookBuilder } from "./types";
import { DEFAULT_HOOK_CONFIG } from "./types";

// ============================================================================
// Default Hooks
// ============================================================================

/**
 * Create default lifecycle hooks with logging.
 */
export function createDefaultHooks(): ExecutionHooks {
	return {
		onTaskStart: async (task: Task, _context: ExecutionContext) => {
			loggers.task.debug({ taskId: task.id, title: task.title }, "Hook: onTaskStart");
		},

		onTaskComplete: async (task: Task, result: TaskExecutionResult) => {
			loggers.task.debug(
				{ taskId: task.id, success: result.success, duration: result.duration },
				"Hook: onTaskComplete",
			);
		},

		onTaskError: async (task: Task, error: Error) => {
			loggers.task.debug({ taskId: task.id, error: error.message }, "Hook: onTaskError");
		},

		onMergeStart: async (branch: string, target: string) => {
			loggers.git.debug({ branch, target }, "Hook: onMergeStart");
		},

		onMergeComplete: async (branch: string, target: string) => {
			loggers.git.debug({ branch, target }, "Hook: onMergeComplete");
		},

		onMergeConflict: async (branch: string, target: string, files: string[]) => {
			loggers.git.warn({ branch, target, files }, "Hook: onMergeConflict");
		},

		onWorktreeCreate: async (path: string, branch: string) => {
			loggers.git.debug({ path, branch }, "Hook: onWorktreeCreate");
		},

		onWorktreeCleanup: async (path: string) => {
			loggers.git.debug({ path }, "Hook: onWorktreeCleanup");
		},

		onGroupStart: async (group: number, taskCount: number) => {
			loggers.task.debug({ group, taskCount }, "Hook: onGroupStart");
		},

		onGroupComplete: async (group: number, results: TaskExecutionResult[]) => {
			const succeeded = results.filter((r) => r.success).length;
			const failed = results.filter((r) => !r.success).length;
			loggers.task.debug({ group, succeeded, failed }, "Hook: onGroupComplete");
		},

		onExecutionStart: async (_context: ExecutionContext, taskCount: number) => {
			loggers.task.debug({ taskCount }, "Hook: onExecutionStart");
		},

		onExecutionComplete: async (_context: ExecutionContext, results: BatchExecutionResult) => {
			loggers.task.debug(
				{
					completed: results.tasksCompleted,
					failed: results.tasksFailed,
					duration: results.totalDuration,
				},
				"Hook: onExecutionComplete",
			);
		},
	};
}

/**
 * Create hooks that emit events to the event bus.
 */
export function createEventEmittingHooks(): ExecutionHooks {
	return {
		onTaskStart: async (task: Task, context: ExecutionContext) => {
			bus.emit("task:start", {
				taskId: task.id,
				title: task.title,
				worktree: undefined,
			});
		},

		onTaskComplete: async (task: Task, result: TaskExecutionResult) => {
			bus.emit("task:complete", {
				taskId: task.id,
				duration: result.duration,
				success: result.success,
			});
		},

		onTaskError: async (task: Task, error: Error) => {
			bus.emit("task:error", { taskId: task.id, error });
		},

		onMergeStart: async (source: string, target: string) => {
			bus.emit("git:merge:start", { source, target });
		},

		onMergeComplete: async (source: string, target: string) => {
			bus.emit("git:merge:complete", { source, target });
		},

		onMergeConflict: async (source: string, target: string, files: string[]) => {
			bus.emit("git:merge:conflict", { source, target, files });
		},

		onWorktreeCreate: async (path: string, branch: string) => {
			bus.emit("git:worktree:create", { path, branch });
		},

		onWorktreeCleanup: async (path: string) => {
			bus.emit("git:worktree:cleanup", { path });
		},
	};
}

/**
 * Create empty hooks (no-op).
 */
export function createEmptyHooks(): ExecutionHooks {
	return {};
}

// ============================================================================
// Hook Composition
// ============================================================================

/**
 * Compose multiple hook sets into a single set.
 * Hooks are executed in order for each event.
 */
export function composeHooks(...hookSets: Partial<ExecutionHooks>[]): ExecutionHooks {
	const composed: ExecutionHooks = {};

	const hookNames: (keyof ExecutionHooks)[] = [
		"onTaskStart",
		"onTaskComplete",
		"onTaskError",
		"onMergeStart",
		"onMergeComplete",
		"onMergeConflict",
		"onWorktreeCreate",
		"onWorktreeCleanup",
		"onGroupStart",
		"onGroupComplete",
		"onExecutionStart",
		"onExecutionComplete",
	];

	for (const name of hookNames) {
		const hooks = hookSets
			.map((set) => set[name])
			.filter((h): h is NonNullable<typeof h> => h !== undefined);

		if (hooks.length > 0) {
			// Create a composed hook that calls all hooks in sequence
			(composed as any)[name] = async (...args: any[]) => {
				for (const hook of hooks) {
					await (hook as Function)(...args);
				}
			};
		}
	}

	return composed;
}

/**
 * Create hooks with error handling wrapper.
 */
export function withErrorHandling(
	hooks: ExecutionHooks,
	config: Partial<HookConfig> = {},
): ExecutionHooks {
	const fullConfig = { ...DEFAULT_HOOK_CONFIG, ...config };
	const wrapped: ExecutionHooks = {};

	for (const [name, hook] of Object.entries(hooks)) {
		if (typeof hook === "function") {
			(wrapped as any)[name] = async (...args: any[]) => {
				try {
					await (hook as Function)(...args);
				} catch (error) {
					if (fullConfig.debug) {
						loggers.task.error({ hook: name, err: error }, "Hook error");
					}
					if (!fullConfig.continueOnError) {
						throw error;
					}
				}
			};
		}
	}

	return wrapped;
}

/**
 * Create hooks with timeout wrapper.
 */
export function withTimeout(
	hooks: ExecutionHooks,
	timeoutMs: number = DEFAULT_HOOK_CONFIG.timeout,
): ExecutionHooks {
	const wrapped: ExecutionHooks = {};

	for (const [name, hook] of Object.entries(hooks)) {
		if (typeof hook === "function") {
			(wrapped as any)[name] = async (...args: any[]) => {
				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(
						() => reject(new Error(`Hook ${name} timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				});

				await Promise.race([(hook as Function)(...args), timeoutPromise]);
			};
		}
	}

	return wrapped;
}

// ============================================================================
// Hook Builder
// ============================================================================

/**
 * Builder for creating hook sets fluently.
 */
export class HookBuilder implements IHookBuilder {
	private hooks: Partial<ExecutionHooks> = {};

	onTaskStart(handler: (task: Task, context: ExecutionContext) => Promise<void>): this {
		this.hooks.onTaskStart = handler;
		return this;
	}

	onTaskComplete(handler: (task: Task, result: TaskExecutionResult) => Promise<void>): this {
		this.hooks.onTaskComplete = handler;
		return this;
	}

	onTaskError(handler: (task: Task, error: Error) => Promise<void>): this {
		this.hooks.onTaskError = handler;
		return this;
	}

	onMergeStart(handler: (branch: string, target: string) => Promise<void>): this {
		this.hooks.onMergeStart = handler;
		return this;
	}

	onMergeComplete(handler: (branch: string, target: string) => Promise<void>): this {
		this.hooks.onMergeComplete = handler;
		return this;
	}

	onMergeConflict(
		handler: (branch: string, target: string, files: string[]) => Promise<void>,
	): this {
		this.hooks.onMergeConflict = handler;
		return this;
	}

	onWorktreeCreate(handler: (path: string, branch: string) => Promise<void>): this {
		this.hooks.onWorktreeCreate = handler;
		return this;
	}

	onWorktreeCleanup(handler: (path: string) => Promise<void>): this {
		this.hooks.onWorktreeCleanup = handler;
		return this;
	}

	onGroupStart(handler: (group: number, taskCount: number) => Promise<void>): this {
		this.hooks.onGroupStart = handler;
		return this;
	}

	onGroupComplete(handler: (group: number, results: TaskExecutionResult[]) => Promise<void>): this {
		this.hooks.onGroupComplete = handler;
		return this;
	}

	onExecutionStart(handler: (context: ExecutionContext, taskCount: number) => Promise<void>): this {
		this.hooks.onExecutionStart = handler;
		return this;
	}

	onExecutionComplete(
		handler: (context: ExecutionContext, results: BatchExecutionResult) => Promise<void>,
	): this {
		this.hooks.onExecutionComplete = handler;
		return this;
	}

	build(): ExecutionHooks {
		return { ...this.hooks };
	}
}

/**
 * Create a new hook builder.
 */
export function createHookBuilder(): HookBuilder {
	return new HookBuilder();
}

// ============================================================================
// Preset Hook Configurations
// ============================================================================

/**
 * Create production-ready hooks with logging and events.
 */
export function createProductionHooks(): ExecutionHooks {
	return withErrorHandling(composeHooks(createDefaultHooks(), createEventEmittingHooks()), {
		continueOnError: true,
		debug: false,
	});
}

/**
 * Create development hooks with verbose logging.
 */
export function createDevelopmentHooks(): ExecutionHooks {
	return withErrorHandling(composeHooks(createDefaultHooks(), createEventEmittingHooks()), {
		continueOnError: true,
		debug: true,
	});
}

/**
 * Create minimal hooks for testing.
 */
export function createTestHooks(): ExecutionHooks {
	return createEmptyHooks();
}
