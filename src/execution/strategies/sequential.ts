/**
 * Sequential Execution Strategy
 *
 * Executes tasks one at a time in order.
 * Best for:
 * - Tasks with strict dependencies
 * - Simple execution flows
 * - Debugging and testing
 */

import { createDefaultExecutor, getPlugin } from "../../engines";
import { bus } from "../../events";
import { loggers } from "../../observability";
import type { Task } from "../../schemas/tasks.schema";
import type {
	ExecutionContext,
	ExecutionOptions,
	IExecutionStrategy,
	TaskExecutionResult,
} from "./types";

/**
 * Sequential execution strategy.
 * Tasks are executed one at a time in the order provided.
 */
export class SequentialStrategy implements IExecutionStrategy {
	readonly name = "sequential";

	/**
	 * Check if this strategy can handle the given tasks.
	 * Sequential strategy handles non-parallel execution.
	 */
	canHandle(tasks: Task[], options: ExecutionOptions): boolean {
		return !options.parallel;
	}

	/**
	 * Estimate execution duration.
	 * Assumes ~5 minutes per task for sequential execution.
	 */
	estimateDuration(tasks: Task[]): number {
		const MINUTES_PER_TASK = 5;
		return tasks.length * MINUTES_PER_TASK * 60 * 1000;
	}

	/**
	 * Execute tasks sequentially.
	 */
	async execute(tasks: Task[], context: ExecutionContext): Promise<TaskExecutionResult[]> {
		const results: TaskExecutionResult[] = [];
		const { options, hooks } = context;

		loggers.task.info(
			{ taskCount: tasks.length, strategy: this.name },
			"Starting sequential execution",
		);

		// Notify execution start
		await hooks.onExecutionStart?.(context, tasks.length);

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const startTime = Date.now();

			// Check for dry run
			if (options.dryRun) {
				loggers.task.info({ taskId: task.id, title: task.title }, "Dry run: skipping task");
				results.push({
					taskId: task.id,
					success: true,
					duration: 0,
				});
				continue;
			}

			// Emit task start event
			bus.emit("task:start", { taskId: task.id, title: task.title });
			await hooks.onTaskStart?.(task, context);

			try {
				loggers.task.info(
					{ taskId: task.id, title: task.title, index: i + 1, total: tasks.length },
					"Starting task",
				);

				// Build prompt for task
				const prompt = this.buildPrompt(task, context);

				// Execute with modern executor API
				const executor = createDefaultExecutor();
				const plugin = getPlugin(context.engine);
				const result = await executor.execute(plugin, {
					prompt,
					workDir: context.workDir,
					taskId: task.id,
				});

				const duration = Date.now() - startTime;
				const taskResult: TaskExecutionResult = {
					taskId: task.id,
					success: result.success,
					result,
					duration,
					inputTokens: 0, // Engine doesn't expose tokens yet
					outputTokens: 0,
				};

				results.push(taskResult);

				// Emit task complete event
				bus.emit("task:complete", {
					taskId: task.id,
					duration,
					success: result.success,
				});
				await hooks.onTaskComplete?.(task, taskResult);

				loggers.task.info({ taskId: task.id, duration, success: result.success }, "Task completed");

				// Check for fail fast
				if (!result.success && options.failFast) {
					loggers.task.warn({ taskId: task.id }, "Stopping execution due to failFast");
					break;
				}
			} catch (error) {
				const duration = Date.now() - startTime;
				const err = error as Error;

				const taskResult: TaskExecutionResult = {
					taskId: task.id,
					success: false,
					duration,
					error: err,
				};

				results.push(taskResult);

				// Emit task error event
				bus.emit("task:error", { taskId: task.id, error: err });
				await hooks.onTaskError?.(task, err);

				loggers.task.error({ taskId: task.id, err, duration }, "Task failed with error");

				// Check for fail fast
				if (options.failFast) {
					loggers.task.warn({ taskId: task.id }, "Stopping execution due to failFast");
					break;
				}
			}
		}

		loggers.task.info(
			{
				completed: results.filter((r) => r.success).length,
				failed: results.filter((r) => !r.success).length,
				total: results.length,
			},
			"Sequential execution complete",
		);

		return results;
	}

	/**
	 * Build execution prompt for a task.
	 */
	private buildPrompt(task: Task, context: ExecutionContext): string {
		const { options } = context;
		const parts: string[] = [];

		parts.push("Execute the following task:");
		parts.push("");
		parts.push(`## Task: ${task.title}`);
		parts.push("");

		if (task.description) {
			parts.push("### Description");
			parts.push(task.description);
			parts.push("");
		}

		// Add metadata if available
		if (task.metadata) {
			if (task.metadata.dependencies && task.metadata.dependencies.length > 0) {
				parts.push("### Dependencies");
				parts.push(task.metadata.dependencies.join(", "));
				parts.push("");
			}

			if (task.metadata.labels && task.metadata.labels.length > 0) {
				parts.push("### Labels");
				parts.push(task.metadata.labels.join(", "));
				parts.push("");
			}
		}

		// Add execution instructions
		parts.push("### Instructions");
		parts.push("- Make minimal, focused changes");
		parts.push("- Commit your changes with a descriptive message");

		if (!options.skipTests) {
			parts.push("- Run tests after making changes");
		}

		if (!options.skipLint) {
			parts.push("- Ensure code passes linting");
		}

		parts.push("- Do not add TODO or placeholder code");
		parts.push("");

		return parts.join("\n");
	}
}

/**
 * Create a new sequential strategy instance.
 */
export function createSequentialStrategy(): SequentialStrategy {
	return new SequentialStrategy();
}
