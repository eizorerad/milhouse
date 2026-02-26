/**
 * Unit tests for per-phase worker resolution
 *
 * Covers resolvePhaseWorkers, getConfigDefaults, and mapToResolvedConfig
 * to verify that per-phase worker counts are correctly mapped and resolved.
 */

import { describe, expect, it } from "bun:test";
import { getConfigDefaults, loadResolvedConfig } from "./config-loader.ts";
import { resolvePhaseWorkers } from "./types.ts";
import type { ResolvedConfig } from "./types.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal ResolvedConfig with custom phases for testing */
function buildConfig(
	overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
	const defaults = getConfigDefaults();
	return { ...defaults, ...overrides };
}

// ============================================================================
// resolvePhaseWorkers
// ============================================================================

describe("resolvePhaseWorkers", () => {
	it("returns per-phase workers when present", () => {
		const config = buildConfig({
			phases: {
				validate: { workers: 10 },
				plan: { workers: 7 },
				exec: { workers: 2 },
			},
		});

		expect(resolvePhaseWorkers(config, "validate")).toBe(10);
		expect(resolvePhaseWorkers(config, "plan")).toBe(7);
		expect(resolvePhaseWorkers(config, "exec")).toBe(2);
	});

	it("returns undefined for a missing phase", () => {
		const config = buildConfig({
			phases: {
				exec: { workers: 3 },
			},
		});

		expect(resolvePhaseWorkers(config, "nonexistent")).toBeUndefined();
		expect(resolvePhaseWorkers(config, "validate")).toBeUndefined();
	});

	it("returns undefined when phase exists but workers is not set", () => {
		const config = buildConfig({
			phases: {
				exec: { model: "sonnet" },
			},
		});

		expect(resolvePhaseWorkers(config, "exec")).toBeUndefined();
	});
});

// ============================================================================
// getConfigDefaults — per-phase workers
// ============================================================================

describe("getConfigDefaults", () => {
	it("includes per-phase workers for all default phases", () => {
		const defaults = getConfigDefaults();

		// Default workers from DEFAULTS in define.ts:
		// scan:1, validate:5, plan:5, consolidate:1, exec:3, verify:1
		expect(defaults.phases.scan?.workers).toBe(1);
		expect(defaults.phases.validate?.workers).toBe(5);
		expect(defaults.phases.plan?.workers).toBe(5);
		expect(defaults.phases.consolidate?.workers).toBe(1);
		expect(defaults.phases.exec?.workers).toBe(3);
		expect(defaults.phases.verify?.workers).toBe(1);
	});

	it("global workers field still reflects exec phase default", () => {
		const defaults = getConfigDefaults();
		expect(defaults.workers).toBe(3);
	});
});

// ============================================================================
// mapToResolvedConfig — per-phase workers mapping
// ============================================================================

describe("mapToResolvedConfig (via loadResolvedConfig)", () => {
	it("maps different workers per phase from config", async () => {
		// loadResolvedConfig reads from disk, but getConfigDefaults
		// exercises mapToResolvedConfig with default config
		const config = getConfigDefaults();

		// Each phase should have its own workers value
		expect(config.phases.scan?.workers).toBe(1);
		expect(config.phases.exec?.workers).toBe(3);
		expect(config.phases.validate?.workers).toBe(5);
		expect(config.phases.plan?.workers).toBe(5);
	});

	it("phases record includes all phases, not just those with non-default models", () => {
		const config = getConfigDefaults();

		// All 6 phases should be present (not filtered by model difference)
		const phaseNames = Object.keys(config.phases);
		expect(phaseNames).toContain("scan");
		expect(phaseNames).toContain("validate");
		expect(phaseNames).toContain("plan");
		expect(phaseNames).toContain("consolidate");
		expect(phaseNames).toContain("exec");
		expect(phaseNames).toContain("verify");
	});
});

// ============================================================================
// CLI --workers override
// ============================================================================

describe("CLI --workers override", () => {
	it("CLI workers sets global workers but per-phase values remain in phases", () => {
		const config = buildConfig({
			workers: 8, // Simulates CLI --workers 8
			phases: {
				validate: { workers: 5 },
				exec: { workers: 3 },
			},
		});

		// Global workers is the CLI override
		expect(config.workers).toBe(8);

		// Per-phase workers are still accessible
		expect(resolvePhaseWorkers(config, "validate")).toBe(5);
		expect(resolvePhaseWorkers(config, "exec")).toBe(3);
	});
});

// ============================================================================
// Resolution order: per-phase > global > defaultParallel
// ============================================================================

describe("phase runner resolution order", () => {
	it("per-phase workers takes precedence over global workers", () => {
		const config = buildConfig({
			workers: 8,
			phases: {
				validate: { workers: 2 },
			},
		});

		const defaultParallel = 5;

		// Simulates: resolvePhaseWorkers(config, phase) ?? config.workers ?? defaultParallel
		const resolved = resolvePhaseWorkers(config, "validate") ?? config.workers ?? defaultParallel;
		expect(resolved).toBe(2);
	});

	it("global workers takes precedence over defaultParallel when no per-phase value", () => {
		const config = buildConfig({
			workers: 8,
			phases: {},
		});

		const defaultParallel = 5;

		const resolved = resolvePhaseWorkers(config, "validate") ?? config.workers ?? defaultParallel;
		expect(resolved).toBe(8);
	});

	it("defaultParallel is used when neither per-phase nor global is set", () => {
		const config = buildConfig({
			workers: undefined as unknown as number,
			phases: {},
		});

		const defaultParallel = 5;

		const resolved = resolvePhaseWorkers(config, "validate") ?? config.workers ?? defaultParallel;
		expect(resolved).toBe(5);
	});

	it("each phase can have independently different worker counts", () => {
		const config = buildConfig({
			workers: 4,
			phases: {
				scan: { workers: 1 },
				validate: { workers: 10 },
				plan: { workers: 7 },
				exec: { workers: 3 },
			},
		});

		const defaultParallel = 5;
		const resolve = (phase: string) =>
			resolvePhaseWorkers(config, phase) ?? config.workers ?? defaultParallel;

		expect(resolve("scan")).toBe(1);
		expect(resolve("validate")).toBe(10);
		expect(resolve("plan")).toBe(7);
		expect(resolve("exec")).toBe(3);
		// consolidate not in phases, falls back to global
		expect(resolve("consolidate")).toBe(4);
	});
});
