/**
 * Cost — token counting + budget checking.
 */

import type { Config, RunCost } from "./types.ts";

export function createRunCost(): RunCost {
	return { inputTokens: 0, outputTokens: 0, totalCost: 0 };
}

export function addTokens(
	cost: RunCost,
	inputTokens: number,
	outputTokens: number,
	config: Config,
): void {
	cost.inputTokens += inputTokens;
	cost.outputTokens += outputTokens;
	cost.totalCost =
		(cost.inputTokens / 1_000_000) * config.cost.inputPerMillion +
		(cost.outputTokens / 1_000_000) * config.cost.outputPerMillion;
}

export function isBudgetExceeded(cost: RunCost, config: Config): boolean {
	return config.cost.budget > 0 && cost.totalCost >= config.cost.budget;
}

export function formatCost(cost: RunCost): string {
	return `$${cost.totalCost.toFixed(2)} (${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out)`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
