/**
 * Tests for cost tracking with per-phase breakdown.
 */

import { describe, expect, it } from "bun:test";
import { addTokens, createRunCost, formatCost, formatPhaseCosts } from "../src/cost.ts";
import type { Config } from "../src/types.ts";

const mockConfig = {
	cost: { inputPerMillion: 3.0, outputPerMillion: 15.0, budget: 10 },
} as Config;

describe("createRunCost", () => {
	it("initializes with zeros and empty byPhase", () => {
		const cost = createRunCost();
		expect(cost.inputTokens).toBe(0);
		expect(cost.outputTokens).toBe(0);
		expect(cost.totalCost).toBe(0);
		expect(cost.byPhase).toEqual({});
	});
});

describe("addTokens", () => {
	it("accumulates aggregate tokens without phase", () => {
		const cost = createRunCost();
		addTokens(cost, 1000, 500, mockConfig);
		expect(cost.inputTokens).toBe(1000);
		expect(cost.outputTokens).toBe(500);
		expect(cost.byPhase).toEqual({});
	});

	it("accumulates per-phase tokens when phase provided", () => {
		const cost = createRunCost();
		addTokens(cost, 1_000_000, 100_000, mockConfig, "scan");
		expect(cost.byPhase.scan).toBeDefined();
		expect(cost.byPhase.scan!.inputTokens).toBe(1_000_000);
		expect(cost.byPhase.scan!.outputTokens).toBe(100_000);
		expect(cost.byPhase.scan!.cost).toBeCloseTo(3.0 + 1.5, 5);
	});

	it("accumulates multiple calls to the same phase", () => {
		const cost = createRunCost();
		addTokens(cost, 500_000, 50_000, mockConfig, "exec");
		addTokens(cost, 500_000, 50_000, mockConfig, "exec");
		expect(cost.byPhase.exec!.inputTokens).toBe(1_000_000);
		expect(cost.byPhase.exec!.outputTokens).toBe(100_000);
		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(100_000);
	});

	it("tracks multiple phases independently", () => {
		const cost = createRunCost();
		addTokens(cost, 1_000_000, 100_000, mockConfig, "scan");
		addTokens(cost, 2_000_000, 200_000, mockConfig, "exec");
		expect(cost.byPhase.scan!.inputTokens).toBe(1_000_000);
		expect(cost.byPhase.exec!.inputTokens).toBe(2_000_000);
		expect(cost.inputTokens).toBe(3_000_000);
	});
});

describe("formatCost", () => {
	it("formats aggregate cost unchanged", () => {
		const cost = createRunCost();
		addTokens(cost, 1_000_000, 100_000, mockConfig);
		const formatted = formatCost(cost);
		expect(formatted).toContain("$");
		expect(formatted).toContain("in");
		expect(formatted).toContain("out");
	});
});

describe("formatPhaseCosts", () => {
	it("returns empty string when no phases", () => {
		const cost = createRunCost();
		expect(formatPhaseCosts(cost)).toBe("");
	});

	it("formats per-phase breakdown", () => {
		const cost = createRunCost();
		addTokens(cost, 1_000_000, 100_000, mockConfig, "scan");
		addTokens(cost, 2_000_000, 200_000, mockConfig, "exec");
		const formatted = formatPhaseCosts(cost);
		expect(formatted).toContain("scan:");
		expect(formatted).toContain("exec:");
		expect(formatted).toContain("$");
	});
});
