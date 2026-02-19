/**
 * Cost calculator — tracks token usage and dollar cost per phase and total
 */

import type { CostConfig } from "./types.ts";

/** Per-phase cost breakdown */
export interface PhaseCost {
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

/** Accumulated cost across all phases */
export interface RunCost {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	inputCost: number;
	outputCost: number;
	totalCost: number;
	byPhase: Record<string, PhaseCost>;
}

/**
 * Calculate dollar cost from token counts
 */
export function calculateCost(
	tokens: { input: number; output: number },
	config: CostConfig,
): number {
	return (
		(tokens.input / 1_000_000) * config.inputPerMillion +
		(tokens.output / 1_000_000) * config.outputPerMillion
	);
}

/**
 * Create an empty RunCost tracker
 */
export function createRunCost(): RunCost {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		inputCost: 0,
		outputCost: 0,
		totalCost: 0,
		byPhase: {},
	};
}

/**
 * Add phase cost to the run total
 */
export function addPhaseCost(
	runCost: RunCost,
	phase: string,
	inputTokens: number,
	outputTokens: number,
	config: CostConfig,
): void {
	const cost = calculateCost({ input: inputTokens, output: outputTokens }, config);

	// Update phase breakdown
	const existing = runCost.byPhase[phase];
	if (existing) {
		existing.inputTokens += inputTokens;
		existing.outputTokens += outputTokens;
		existing.cost += cost;
	} else {
		runCost.byPhase[phase] = { inputTokens, outputTokens, cost };
	}

	// Update totals
	runCost.inputTokens += inputTokens;
	runCost.outputTokens += outputTokens;
	runCost.totalTokens += inputTokens + outputTokens;

	const inputCost = (inputTokens / 1_000_000) * config.inputPerMillion;
	const outputCost = (outputTokens / 1_000_000) * config.outputPerMillion;
	runCost.inputCost += inputCost;
	runCost.outputCost += outputCost;
	runCost.totalCost += cost;
}

/**
 * Error thrown when budget is exceeded
 */
export class BudgetExceededError extends Error {
	constructor(
		public readonly spent: number,
		public readonly limit: number,
	) {
		super(`Budget exceeded: spent $${spent.toFixed(2)} of $${limit.toFixed(2)} limit`);
		this.name = "BudgetExceededError";
	}
}

/**
 * Check budget and throw if exceeded
 */
export function checkBudget(runCost: RunCost, config: CostConfig): void {
	if (config.budgetLimit > 0 && runCost.totalCost >= config.budgetLimit) {
		throw new BudgetExceededError(runCost.totalCost, config.budgetLimit);
	}
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Format token count for display (e.g., "6,254" or "19K")
 */
export function formatTokens(count: number): string {
	if (count >= 1000) return `${Math.round(count / 1000)}K`;
	return count.toLocaleString();
}
