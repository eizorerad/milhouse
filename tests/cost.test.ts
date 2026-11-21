import { describe, expect, it } from "bun:test";
import { CostTracker, emptyCost, formatCost, formatUsd } from "../src/cost.ts";
import { sleep } from "../src/util.ts";

describe("CostTracker", () => {
	it("adds real USD per step and persists every change", () => {
		const saved: number[] = [];
		const tracker = new CostTracker(emptyCost(), 0, (c) => saved.push(c.total));
		tracker.add("exec", 0.5);
		tracker.add("verify", 0.25);
		tracker.add("exec", 0.25);
		expect(tracker.current.total).toBeCloseTo(1);
		expect(tracker.current.byPhase.exec).toBeCloseTo(0.75);
		expect(saved).toHaveLength(3);
	});

	it("has no time limit unless one is given", () => {
		const tracker = new CostTracker(emptyCost(), 0, () => {});
		expect(tracker.remainingMs()).toBe(Number.POSITIVE_INFINITY);
		expect(tracker.limitReached()).toBeNull();
	});

	it("stops new work once the time limit of the command has passed", async () => {
		const tracker = new CostTracker(emptyCost(), 0, () => {}, 40);
		expect(tracker.exceeded()).toBe(false);
		expect(tracker.remainingMs()).toBeGreaterThan(0);
		await sleep(60);
		expect(tracker.exceeded()).toBe(true);
		expect(tracker.limitReached()).toBe("time");
	});

	it("names the budget when the money is used up", () => {
		const tracker = new CostTracker(emptyCost(), 1, () => {}, 60_000);
		tracker.add("scan", 2);
		expect(tracker.limitReached()).toBe("budget");
	});

	it("ignores zero, negative and NaN amounts", () => {
		const tracker = new CostTracker(emptyCost(), 0, () => {});
		tracker.add("scan", 0);
		tracker.add("scan", -1);
		tracker.add("scan", Number.NaN);
		expect(tracker.current.total).toBe(0);
	});

	it("never mutates the object it was given", () => {
		const start = emptyCost();
		new CostTracker(start, 0, () => {}).add("scan", 1);
		expect(start.total).toBe(0);
	});

	it("budget 0 means unlimited", () => {
		const tracker = new CostTracker(emptyCost(), 0, () => {});
		tracker.add("exec", 1000);
		expect(tracker.exceeded()).toBe(false);
	});

	it("knows when the budget is gone", () => {
		const tracker = new CostTracker(emptyCost(), 10, () => {});
		tracker.add("exec", 4);
		expect(tracker.exceeded()).toBe(false);
		tracker.add("exec", 6.5);
		expect(tracker.exceeded()).toBe(true);
	});
});

describe("tokens of harnesses that report no dollars", () => {
	it("counts them next to the dollars and never into the budget", () => {
		const saved: unknown[] = [];
		const tracker = new CostTracker(emptyCost(), 1, (c) => saved.push(c.tokens));
		tracker.add("exec", 0.4);
		tracker.add("verify", 0, { input: 5_000, output: 200 });
		tracker.add("verify", 0, { input: 1_000, output: 50 });
		expect(tracker.current.total).toBeCloseTo(0.4);
		expect(tracker.current.byPhase).toEqual({ exec: 0.4 });
		expect(tracker.current.tokens).toEqual({ input: 6_000, output: 250 });
		expect(tracker.exceeded()).toBe(false);
		expect(saved).toHaveLength(3);
	});

	it("ignores an empty usage, and carries on from a record made before tokens were counted", () => {
		const tracker = new CostTracker({ total: 2, byPhase: { scan: 2 } }, 0, () => {});
		tracker.add("scan", 0, { input: 0, output: 0 });
		expect(tracker.current).toEqual({ total: 2, byPhase: { scan: 2 } });
		tracker.add("scan", 0, { input: 10, output: 5 });
		expect(tracker.current.tokens).toEqual({ input: 10, output: 5 });
	});
});

describe("formatting", () => {
	it("stops new work once the token limit is used up, and has none unless one is given", () => {
		const unlimited = new CostTracker(emptyCost(), 0, () => {});
		unlimited.add("scan", 0, { input: 9_000_000, output: 1_000_000 });
		expect(unlimited.limitReached()).toBeNull();

		const tracker = new CostTracker(emptyCost(), 0, () => {}, 0, 1_000);
		tracker.add("scan", 0, { input: 900, output: 50 });
		expect(tracker.limitReached()).toBeNull();
		tracker.add("validate", 0, { input: 40, output: 10 }); // input and output count together
		expect(tracker.limitReached()).toBe("tokens");
		expect(tracker.tokensUsedUp()).toBe(true);
	});

	it("shows tokens where there are no dollars, and both when a run used both", () => {
		const tokens = { input: 1_234_567, output: 40_000 };
		expect(formatCost({ total: 0, byPhase: {}, tokens })).toBe(
			"1.2M in / 40k out tokens (Codex reports no dollars)",
		);
		expect(
			formatCost({ total: 1.5, byPhase: { exec: 1.5 }, tokens: { input: 900, output: 50 } }),
		).toBe("$1.50 (exec $1.50), 900 in / 50 out tokens (Codex reports no dollars)");
		expect(formatCost({ total: 0, byPhase: {}, tokens: { input: 0, output: 0 } })).toBe("$0.00");
	});

	it("formats USD and a per-step breakdown", () => {
		expect(formatUsd(1.234)).toBe("$1.23");
		expect(formatCost({ total: 1.5, byPhase: { scan: 0.5, exec: 1 } })).toBe(
			"$1.50 (scan $0.50, exec $1.00)",
		);
		expect(formatCost(emptyCost())).toBe("$0.00");
	});
});

describe("reservations", () => {
	it("splits what is free between parallel calls, so they can never add up to more than the budget", () => {
		const tracker = new CostTracker(emptyCost(), 10, () => {});
		const first = tracker.reserve(2);
		const second = tracker.reserve(2);
		expect([first, second]).toEqual([5, 5]);
		expect(tracker.reserve(2)).toBe(0); // nothing is left to hand out while both are running

		tracker.add("exec", 1); // the first call finishes and costs 1
		tracker.release(first);
		// 10 - 1 spent - 5 still reserved for the second call, one slot free
		expect(tracker.reserve(2)).toBeCloseTo(4);
	});

	it("is unlimited when there is no budget, and release is a no-op then", () => {
		const tracker = new CostTracker(emptyCost(), 0, () => {});
		expect(tracker.reserve(3)).toBeUndefined();
		tracker.release(undefined);
		expect(tracker.reserve(3)).toBeUndefined();
	});

	it("gives a sequential caller everything that is left", () => {
		const tracker = new CostTracker(emptyCost(), 10, () => {});
		const share = tracker.reserve(1);
		expect(share).toBe(10);
		tracker.add("exec", 3);
		tracker.release(share);
		expect(tracker.reserve(1)).toBe(7);
	});
});
