/**
 * Pipeline-Aware Execution Strategy
 *
 * Adaptive strategy that selects the best execution approach
 * based on task characteristics and pipeline phase.
 * Best for:
 * - Mixed workloads with varying task types
 * - Automatic optimization
 * - Pipeline integration
 */

import { loggers } from "../../observability";
import type { Task } from "../../schemas/tasks.schema";
import { ParallelWorktreeStrategy } from "./parallel-worktree";
import { SequentialStrategy } from "./sequential";
import type {
	ExecutionContext,
	ExecutionOptions,
	IExecutionStrategy,
	TaskExecutionResult,
} from "./types";

/**
 * Pipeline-aware execution strategy.
 * Automatically selects the best strategy based on task characteristics.
 */
export class PipelineAwareStrategy implements IExecutionStrategy {
	readonly name = "pipeline-aware";

	private readonly sequential: SequentialStrategy;
	private readonly parallel: ParallelWorktreeStrategy;

	constructor() {
		this.sequential = new SequentialStrategy();
		this.parallel = new ParallelWorktreeStrategy();
	}

	/**
	 * Pipeline-aware strategy can handle any tasks.
	 */
	canHandle(): boolean {
		return true;
	}

	/**
	 * Estimate duration based on selected strategy.
	 */
	estimateDuration(tasks: Task[]): number {
		// Use parallel estimate if tasks have groups
		const hasGroups = tasks.some((t) => t.metadata?.parallelGroup !== undefined);
		return hasGroups
			? this.parallel.estimateDuration(tasks)
			: this.sequential.estimateDuration(tasks);
	}

	/**
	 * Execute tasks using the best strategy for the workload.
	 */
	async execute(tasks: Task[], context: ExecutionContext): Promise<TaskExecutionResult[]> {
		// Analyze tasks and select strategy
		const analysis = this.analyzeTasks(tasks, context.options);
		const strategy = this.selectStrategy(analysis, context.options);

		loggers.task.info(
			{
				selectedStrategy: strategy.name,
				taskCount: tasks.length,
				analysis: {
					hasParallelGroups: analysis.hasParallelGroups,
					hasDependencies: analysis.hasDependencies,
					groupCount: analysis.groupCount,
					independentTasks: analysis.independentTasks,
				},
			},
			"Pipeline-aware strategy selected execution approach",
		);

		return strategy.execute(tasks, context);
	}

	/**
	 * Analyze task characteristics.
	 */
	private analyzeTasks(tasks: Task[], options: ExecutionOptions): TaskAnalysis {
		const groupSet = new Set<number>();
		let hasDependencies = false;
		let independentTasks = 0;

		for (const task of tasks) {
			// Check for parallel groups
			if (task.metadata?.parallelGroup !== undefined) {
				groupSet.add(task.metadata.parallelGroup);
			}

			// Check for dependencies
			if (task.metadata?.dependencies && task.metadata.dependencies.length > 0) {
				hasDependencies = true;
			} else {
				independentTasks++;
			}
		}

		return {
			hasParallelGroups: groupSet.size > 0,
			hasDependencies,
			groupCount: groupSet.size,
			independentTasks,
			totalTasks: tasks.length,
			parallelEnabled: options.parallel,
			branchPerTask: options.branchPerTask,
		};
	}

	/**
	 * Select the best strategy based on analysis.
	 */
	private selectStrategy(analysis: TaskAnalysis, options: ExecutionOptions): IExecutionStrategy {
		// If parallel is disabled, use sequential
		if (!analysis.parallelEnabled) {
			loggers.task.debug("Using sequential: parallel disabled");
			return this.sequential;
		}

		// If branch-per-task is disabled, use sequential
		if (!analysis.branchPerTask) {
			loggers.task.debug("Using sequential: branch-per-task disabled");
			return this.sequential;
		}

		// If tasks have parallel groups, use parallel worktree
		if (analysis.hasParallelGroups) {
			loggers.task.debug(
				{ groupCount: analysis.groupCount },
				"Using parallel-worktree: tasks have parallel groups",
			);
			return this.parallel;
		}

		// If multiple independent tasks, use parallel worktree
		if (analysis.independentTasks > 1 && analysis.totalTasks > 1) {
			loggers.task.debug(
				{ independentTasks: analysis.independentTasks },
				"Using parallel-worktree: multiple independent tasks",
			);
			return this.parallel;
		}

		// If all tasks have dependencies, use sequential
		if (analysis.hasDependencies && analysis.independentTasks === 0) {
			loggers.task.debug("Using sequential: all tasks have dependencies");
			return this.sequential;
		}

		// Default to sequential for single tasks
		if (analysis.totalTasks === 1) {
			loggers.task.debug("Using sequential: single task");
			return this.sequential;
		}

		// Default to parallel for multiple tasks
		loggers.task.debug("Using parallel-worktree: default for multiple tasks");
		return this.parallel;
	}
}

/**
 * Task analysis result.
 */
interface TaskAnalysis {
	/** Whether tasks have parallel group assignments */
	hasParallelGroups: boolean;
	/** Whether any tasks have dependencies */
	hasDependencies: boolean;
	/** Number of unique parallel groups */
	groupCount: number;
	/** Number of tasks without dependencies */
	independentTasks: number;
	/** Total number of tasks */
	totalTasks: number;
	/** Whether parallel execution is enabled */
	parallelEnabled: boolean;
	/** Whether branch-per-task is enabled */
	branchPerTask: boolean;
}

/**
 * Create a new pipeline-aware strategy instance.
 */
export function createPipelineAwareStrategy(): PipelineAwareStrategy {
	return new PipelineAwareStrategy();
}
