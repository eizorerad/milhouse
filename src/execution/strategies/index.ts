/**
 * Execution Strategies Module
 *
 * Provides a strategy pattern for task execution with a registry
 * for managing and selecting strategies.
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
	ExecutionContext,
	ExecutionOptions,
	TaskExecutionResult,
	BatchExecutionResult,
	ExecutionHooks,
	IExecutionStrategy,
	StrategyFactory,
	StrategyRegistration,
} from "./types";

export {
	DEFAULT_EXECUTION_OPTIONS,
	createEmptyTaskResult,
	createEmptyBatchResult,
	aggregateResults,
	mergeOptions,
} from "./types";

// ============================================================================
// Strategy Exports
// ============================================================================

export { SequentialStrategy, createSequentialStrategy } from "./sequential";
export { ParallelWorktreeStrategy, createParallelWorktreeStrategy } from "./parallel-worktree";
export { PipelineAwareStrategy, createPipelineAwareStrategy } from "./pipeline-aware";

// ============================================================================
// Strategy Registry
// ============================================================================

import { ParallelWorktreeStrategy } from "./parallel-worktree";
import { PipelineAwareStrategy } from "./pipeline-aware";
import { SequentialStrategy } from "./sequential";
import type { ExecutionOptions, IExecutionStrategy, StrategyRegistration } from "./types";

/**
 * Registry of available execution strategies.
 */
const strategyRegistry = new Map<string, StrategyRegistration>([
	[
		"sequential",
		{
			name: "sequential",
			factory: () => new SequentialStrategy(),
			priority: 10,
			description: "Execute tasks one at a time in order",
		},
	],
	[
		"parallel-worktree",
		{
			name: "parallel-worktree",
			factory: () => new ParallelWorktreeStrategy(),
			priority: 20,
			description: "Execute tasks in parallel using git worktrees",
		},
	],
	[
		"pipeline-aware",
		{
			name: "pipeline-aware",
			factory: () => new PipelineAwareStrategy(),
			priority: 30,
			description: "Automatically select best strategy based on task characteristics",
		},
	],
]);

/**
 * Get a strategy by name.
 * @param name - Strategy name
 * @returns Strategy instance
 * @throws Error if strategy not found
 */
export function getStrategy(name: string): IExecutionStrategy {
	const registration = strategyRegistry.get(name);
	if (!registration) {
		const available = listStrategies().join(", ");
		throw new Error(`Unknown execution strategy: ${name}. Available: ${available}`);
	}
	return registration.factory();
}

/**
 * Select the best strategy based on execution options.
 * @param options - Execution options
 * @returns Best strategy for the given options
 */
export function selectBestStrategy(options: ExecutionOptions): IExecutionStrategy {
	// If parallel with branch-per-task, use parallel worktree
	if (options.parallel && options.branchPerTask) {
		return new ParallelWorktreeStrategy();
	}

	// If parallel without branch-per-task, use pipeline-aware
	if (options.parallel) {
		return new PipelineAwareStrategy();
	}

	// Default to sequential
	return new SequentialStrategy();
}

/**
 * Register a new strategy.
 * @param name - Strategy name
 * @param factory - Factory function to create strategy
 * @param priority - Priority for auto-selection (higher = preferred)
 * @param description - Optional description
 */
export function registerStrategy(
	name: string,
	factory: () => IExecutionStrategy,
	priority = 0,
	description?: string,
): void {
	strategyRegistry.set(name, {
		name,
		factory,
		priority,
		description,
	});
}

/**
 * Unregister a strategy.
 * @param name - Strategy name to remove
 * @returns True if strategy was removed
 */
export function unregisterStrategy(name: string): boolean {
	return strategyRegistry.delete(name);
}

/**
 * List all registered strategy names.
 * @returns Array of strategy names
 */
export function listStrategies(): string[] {
	return Array.from(strategyRegistry.keys());
}

/**
 * Get all strategy registrations.
 * @returns Array of strategy registrations
 */
export function getStrategyRegistrations(): StrategyRegistration[] {
	return Array.from(strategyRegistry.values());
}

/**
 * Check if a strategy is registered.
 * @param name - Strategy name
 * @returns True if strategy exists
 */
export function hasStrategy(name: string): boolean {
	return strategyRegistry.has(name);
}

/**
 * Get strategy registration details.
 * @param name - Strategy name
 * @returns Registration details or undefined
 */
export function getStrategyRegistration(name: string): StrategyRegistration | undefined {
	return strategyRegistry.get(name);
}

/**
 * Get strategies sorted by priority (highest first).
 * @returns Array of strategy registrations sorted by priority
 */
export function getStrategiesByPriority(): StrategyRegistration[] {
	return Array.from(strategyRegistry.values()).sort((a, b) => b.priority - a.priority);
}
