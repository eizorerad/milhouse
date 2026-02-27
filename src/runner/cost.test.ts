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
