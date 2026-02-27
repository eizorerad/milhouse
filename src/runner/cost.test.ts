import { describe, expect, test } from "bun:test";
import type { CostConfig } from "./types.ts";
import { BudgetExceededError, BudgetGuard, checkBudget, createRunCost } from "./cost.ts";

describe("checkBudget", () => {
	const costConfig: CostConfig = {
		inputPerMillion: 5,
		outputPerMillion: 25,
		budgetLimit: 10,
	};

	test("throws BudgetExceededError when totalCost >= budgetLimit", () => {
		const runCost = createRunCost();
		runCost.totalCost = 10;
		expect(() => checkBudget(runCost, costConfig)).toThrow(BudgetExceededError);
	});

	test("throws BudgetExceededError when totalCost exceeds budgetLimit", () => {
		const runCost = createRunCost();
		runCost.totalCost = 15;
		expect(() => checkBudget(runCost, costConfig)).toThrow(BudgetExceededError);
	});

	test("does not throw when totalCost < budgetLimit", () => {
		const runCost = createRunCost();
		runCost.totalCost = 5;
		expect(() => checkBudget(runCost, costConfig)).not.toThrow();
	});

	test("does not throw when budgetLimit is 0 (unlimited)", () => {
		const unlimited: CostConfig = { ...costConfig, budgetLimit: 0 };
		const runCost = createRunCost();
		runCost.totalCost = 999;
		expect(() => checkBudget(runCost, unlimited)).not.toThrow();
	});

	test("does not throw when totalCost is 0", () => {
		const runCost = createRunCost();
		expect(() => checkBudget(runCost, costConfig)).not.toThrow();
	});
});

describe("BudgetGuard", () => {
	const costConfig: CostConfig = {
		inputPerMillion: 5,
		outputPerMillion: 25,
		budgetLimit: 10,
	};

	describe("reserve", () => {
		test("passes when totalCost + reservedCost < budgetLimit and increments reservedCost", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.totalCost = 3;

			await guard.reserve(runCost, costConfig, 2);

			expect(runCost.reservedCost).toBe(2);
		});

		test("throws BudgetExceededError when totalCost + reservedCost >= budgetLimit", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.totalCost = 8;
			runCost.reservedCost = 2;

			await expect(guard.reserve(runCost, costConfig, 1)).rejects.toThrow(BudgetExceededError);
		});

		test("is a no-op when budgetLimit <= 0 (unlimited mode)", async () => {
			const guard = new BudgetGuard();
			const unlimited: CostConfig = { ...costConfig, budgetLimit: 0 };
			const runCost = createRunCost();
			runCost.totalCost = 999;

			await guard.reserve(runCost, unlimited, 100);

			expect(runCost.reservedCost).toBe(0);
		});
	});

	describe("settle", () => {
		test("correctly decrements reservedCost and increments totalCost and token counters", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.reservedCost = 5;

			await guard.settle(runCost, 5, 3.5, 1000, 500);

			expect(runCost.reservedCost).toBe(0);
			expect(runCost.totalCost).toBe(3.5);
			expect(runCost.inputTokens).toBe(1000);
			expect(runCost.outputTokens).toBe(500);
			expect(runCost.totalTokens).toBe(1500);
		});

		test("handles actual cost less than reserved amount", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.reservedCost = 5;

			await guard.settle(runCost, 5, 1, 100, 50);

			expect(runCost.reservedCost).toBe(0);
			expect(runCost.totalCost).toBe(1);
		});

		test("handles actual cost greater than reserved amount", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.reservedCost = 2;

			await guard.settle(runCost, 2, 8, 5000, 2000);

			expect(runCost.reservedCost).toBe(0);
			expect(runCost.totalCost).toBe(8);
			expect(runCost.inputTokens).toBe(5000);
			expect(runCost.outputTokens).toBe(2000);
		});
	});

	describe("concurrent reservation", () => {
		test("mutex serializes reserves and prevents double-booking beyond budget", async () => {
			const guard = new BudgetGuard();
			const runCost = createRunCost();
			runCost.totalCost = 8;
			// Budget is 10, so only $2 of headroom

			const results = await Promise.allSettled([
				guard.reserve(runCost, costConfig, 1),
				guard.reserve(runCost, costConfig, 1),
				guard.reserve(runCost, costConfig, 1),
				guard.reserve(runCost, costConfig, 1),
				guard.reserve(runCost, costConfig, 1),
			]);

			const succeeded = results.filter((r) => r.status === "fulfilled").length;
			const failed = results.filter((r) => r.status === "rejected").length;

			// With $2 headroom and $1 reserves, exactly 2 should succeed
			// The first 2 that acquire the mutex reserve $1 each (totaling $10),
			// then the remaining 3 see totalCost(8) + reservedCost(2) >= 10 and fail
			expect(succeeded).toBe(2);
			expect(failed).toBe(3);
			expect(runCost.reservedCost).toBe(2);
		});
	});
});

describe("BudgetGuard integration", () => {
	const costConfig: CostConfig = {
		inputPerMillion: 5,
		outputPerMillion: 25,
		budgetLimit: 10,
	};

	test("concurrent tasks cannot collectively exceed the budget", async () => {
		const guard = new BudgetGuard();
		const runCost = createRunCost();
		runCost.totalCost = 8; // $2 headroom

		// Simulate 5 concurrent tasks each trying to reserve $1 then settle
		const taskResults = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				(async () => {
					await guard.reserve(runCost, costConfig, 1);
					// Simulate work with a small delay
					await new Promise((r) => setTimeout(r, 5));
					// Settle with actual cost of $0.50
					await guard.settle(runCost, 1, 0.5, 200, 100);
					return true;
				})(),
			),
		);

		const succeeded = taskResults.filter((r) => r.status === "fulfilled").length;
		const failed = taskResults.filter((r) => r.status === "rejected").length;

		// Only 2 tasks should succeed (budget allows $2 of reservations)
		expect(succeeded).toBe(2);
		expect(failed).toBe(3);

		// totalCost should reflect 2 tasks settling at $0.50 each
		expect(runCost.totalCost).toBeCloseTo(8 + 2 * 0.5, 10);
	});

	test("reservedCost returns to 0 after all tasks complete — no leaked reservations", async () => {
		const guard = new BudgetGuard();
		const runCost = createRunCost();
		// Budget $10, starting at $0 — all 5 tasks should fit with $1 reserves
		const taskConfig: CostConfig = { ...costConfig, budgetLimit: 10 };

		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				(async () => {
					await guard.reserve(runCost, taskConfig, 1);
					await new Promise((r) => setTimeout(r, 2 + i));
					await guard.settle(runCost, 1, 0.8, 100, 50);
				})(),
			),
		);

		expect(runCost.reservedCost).toBe(0);
		expect(runCost.totalCost).toBeCloseTo(5 * 0.8, 10);
		expect(runCost.inputTokens).toBe(5 * 100);
		expect(runCost.outputTokens).toBe(5 * 50);
		expect(runCost.totalTokens).toBe(5 * 150);
	});

	test("totalCost reflects correct accumulated actual costs", async () => {
		const guard = new BudgetGuard();
		const runCost = createRunCost();
		const bigBudget: CostConfig = { ...costConfig, budgetLimit: 100 };

		// 3 tasks with varying actual costs
		const costs = [1.5, 2.3, 0.7];

		await Promise.all(
			costs.map((actualCost) =>
				(async () => {
					await guard.reserve(runCost, bigBudget, 5);
					await new Promise((r) => setTimeout(r, 3));
					await guard.settle(runCost, 5, actualCost, 500, 200);
				})(),
			),
		);

		expect(runCost.reservedCost).toBe(0);
		expect(runCost.totalCost).toBeCloseTo(1.5 + 2.3 + 0.7, 10);
	});

	test("without guard, bare checkBudget allows race condition overshoot", async () => {
		// This test demonstrates the bug: without BudgetGuard, concurrent tasks
		// all pass the budget check before any cost is accumulated
		const runCost = createRunCost();
		runCost.totalCost = 9; // $1 headroom

		// All 5 concurrent tasks read totalCost=9 < budgetLimit=10 simultaneously
		// and all pass. This is the race condition the BudgetGuard fixes.
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				(async () => {
					// Without mutex, all see the same stale totalCost
					checkBudget(runCost, costConfig);
					await new Promise((r) => setTimeout(r, 5));
					runCost.totalCost += 0.5;
				})(),
			),
		);

		const succeeded = results.filter((r) => r.status === "fulfilled").length;

		// Without the guard, ALL 5 tasks pass budget check (the bug)
		expect(succeeded).toBe(5);
		// Total cost overshoots: 9 + 5*0.5 = 11.5, exceeding the $10 limit
		expect(runCost.totalCost).toBeGreaterThan(costConfig.budgetLimit);
	});
});
