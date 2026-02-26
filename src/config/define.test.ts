import { describe, expect, test } from "bun:test";
import { resolveConfig } from "./define.ts";

describe("resolveConfig budgetLimit", () => {
	test("default budgetLimit is 50", () => {
		const config = resolveConfig({});
		expect(config.cost.budgetLimit).toBe(50);
	});

	test("explicit budgetLimit: 0 preserves unlimited", () => {
		const config = resolveConfig({ cost: { budgetLimit: 0 } });
		expect(config.cost.budgetLimit).toBe(0);
	});

	test("explicit budgetLimit overrides default", () => {
		const config = resolveConfig({ cost: { budgetLimit: 10 } });
		expect(config.cost.budgetLimit).toBe(10);
	});
});
