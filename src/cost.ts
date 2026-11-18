/** Cost tracking. The agent reports real USD per call, so there is no token pricing to maintain. */

import type { AgentStep, RunCost } from "./types.ts";

export const emptyCost = (): RunCost => ({ total: 0, byPhase: {} });

export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

export function formatCost(cost: RunCost): string {
	const phases = Object.entries(cost.byPhase)
		.map(([phase, usd]) => `${phase} ${formatUsd(usd)}`)
		.join(", ");
	return phases ? `${formatUsd(cost.total)} (${phases})` : formatUsd(cost.total);
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

	add(step: AgentStep, usd: number): void {
		if (!(usd > 0)) return;
		this.cost = {
			total: this.cost.total + usd,
			byPhase: { ...this.cost.byPhase, [step]: (this.cost.byPhase[step] ?? 0) + usd },
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
