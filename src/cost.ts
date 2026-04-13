/**
 * Cost — token counting + budget checking.
 */

import type { Config, Phase, PhaseCost, RunCost } from "./types.ts";

// Inline debug log to avoid circular dependency
const debugLog = (msg: string) => {
	if (process.env.VERBOSE === "1") console.log(`... ${msg}`);
};

const CLAUDE_ENGINES = new Set(["claude"]);
let estimatedTokensWarned = false;

export function isEstimatedTokens(engine: string): boolean {
	return !CLAUDE_ENGINES.has(engine);
}

export function createRunCost(): RunCost {
	return { inputTokens: 0, outputTokens: 0, totalCost: 0, byPhase: {} };
}

export function addTokens(
	cost: RunCost,
	inputTokens: number,
	outputTokens: number,
	config: Config,
	phase?: Phase,
): void {
	if (!estimatedTokensWarned && isEstimatedTokens(config.engine)) {
		debugLog(
			`[cost] Token counts for engine "${config.engine}" are estimated - budget enforcement is approximate`,
		);
		estimatedTokensWarned = true;
	}
	cost.inputTokens += inputTokens;
	cost.outputTokens += outputTokens;
	cost.totalCost =
		(cost.inputTokens / 1_000_000) * config.cost.inputPerMillion +
		(cost.outputTokens / 1_000_000) * config.cost.outputPerMillion;

	if (phase) {
		const pc = cost.byPhase[phase] ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
		pc.inputTokens += inputTokens;
		pc.outputTokens += outputTokens;
		pc.cost =
			(pc.inputTokens / 1_000_000) * config.cost.inputPerMillion +
			(pc.outputTokens / 1_000_000) * config.cost.outputPerMillion;
		cost.byPhase[phase] = pc;
	}
}

export function isBudgetExceeded(cost: RunCost, config: Config): boolean {
	return config.cost.budget > 0 && cost.totalCost >= config.cost.budget;
}

export function formatCost(cost: RunCost): string {
	return `$${cost.totalCost.toFixed(2)} (${formatTokens(cost.inputTokens)} in / ${formatTokens(cost.outputTokens)} out)`;
}

export function formatPhaseCosts(cost: RunCost): string {
	const entries = Object.entries(cost.byPhase) as [Phase, PhaseCost][];
	if (entries.length === 0) return "";
	const lines: string[] = [];
	for (const [phase, pc] of entries) {
		lines.push(
			`  ${phase}: $${pc.cost.toFixed(2)} (${formatTokens(pc.inputTokens)} in / ${formatTokens(pc.outputTokens)} out)`,
		);
	}
	return lines.join("\n");
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
