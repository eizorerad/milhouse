import { describe, expect, test } from "bun:test";
import type { CostConfig } from "./types.ts";
import { BudgetExceededError, checkBudget, createRunCost } from "./cost.ts";

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
