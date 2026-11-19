/**
 * Cost tracking. Claude reports real USD per call, so there is no token pricing to maintain. Codex reports
 * tokens only: they are counted and shown, but they are not dollars and the budget cannot stop them.
 */

import type { AgentStep, RunCost } from "./types.ts";

export const emptyCost = (): RunCost => ({ total: 0, byPhase: {} });

export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

const formatTokens = (n: number): string =>
	n >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M`
		: n >= 1_000
			? `${Math.round(n / 1_000)}k`
			: `${n}`;

export function formatCost(cost: RunCost): string {
	const phases = Object.entries(cost.byPhase)
		.map(([phase, usd]) => `${phase} ${formatUsd(usd)}`)
		.join(", ");
	const money = phases ? `${formatUsd(cost.total)} (${phases})` : formatUsd(cost.total);
	const { input = 0, output = 0 } = cost.tokens ?? {};
	if (input + output === 0) return money;
	const tokens = `${formatTokens(input)} in / ${formatTokens(output)} out tokens (Codex reports no dollars)`;
	return cost.total > 0 ? `${money}, ${tokens}` : tokens;
}

/** Single mutable cell for a run's spending, shared by parallel workers. */
export class CostTracker {
	constructor(
		private cost: RunCost,
		private readonly budget: number,
		private readonly persist: (cost: RunCost) => void,
	) {}

	get current(): RunCost {
		return this.cost;
	}

	add(step: AgentStep, usd: number, tokens?: { input: number; output: number }): void {
		const spent = usd > 0 ? usd : 0;
		const used = tokens && tokens.input + tokens.output > 0 ? tokens : undefined;
		if (spent === 0 && !used) return;
		const before = this.cost.tokens ?? { input: 0, output: 0 };
		this.cost = {
			total: this.cost.total + spent,
			byPhase:
				spent > 0
					? { ...this.cost.byPhase, [step]: (this.cost.byPhase[step] ?? 0) + spent }
					: this.cost.byPhase,
			tokens: used
				? { input: before.input + used.input, output: before.output + used.output }
				: this.cost.tokens,
		};
		this.persist(this.cost);
	}

	exceeded(): boolean {
		return this.budget > 0 && this.cost.total >= this.budget;
	}

	private reserved = 0;
	private inFlight = 0;

	/**
	 * Reserve what one agent call may spend, so parallel calls can never add up to more than the budget:
	 * an equal share of what is neither spent nor reserved. Undefined when the budget is unlimited.
	 * Pair every call with `release`.
	 */
	reserve(workers: number): number | undefined {
		if (this.budget <= 0) return undefined;
		const free = Math.max(this.budget - this.cost.total - this.reserved, 0);
		const share = free / Math.max(workers - this.inFlight, 1);
		this.reserved += share;
		this.inFlight++;
		return share;
	}

	release(share: number | undefined): void {
		if (share === undefined) return;
		this.reserved = Math.max(this.reserved - share, 0);
		this.inFlight = Math.max(this.inFlight - 1, 0);
	}
}
