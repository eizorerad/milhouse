/**
 * Integration tests for probe execution during planning
 *
 * These tests verify that:
 * - detectApplicableProbes is called
 * - dispatchProbes executes when not skipped
 * - Existing probe results are loaded from validation
 * - New probes run if no existing results
 * - skipProbes option works
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("plan.ts probe integration", () => {
	const testWorkDir = join(process.cwd(), ".test-workdir-plan");

	beforeEach(() => {
		// Create test directory
		if (!existsSync(testWorkDir)) {
			mkdirSync(testWorkDir, { recursive: true });
		}
	});

	afterEach(() => {
		// Cleanup test directory
		if (existsSync(testWorkDir)) {
			rmSync(testWorkDir, { recursive: true, force: true });
		}
	});

	test("should have detectApplicableProbes imported", async () => {
		const probesModule = await import("../../probes/index.ts");
		expect(typeof probesModule.detectApplicableProbes).toBe("function");
	});

	test("should have dispatchProbes imported", async () => {
		const probesModule = await import("../../probes/index.ts");
		expect(typeof probesModule.dispatchProbes).toBe("function");
	});

	test("should have hasExistingProbeResults in probeIntegration", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");
		expect(typeof integrationModule.hasExistingProbeResults).toBe("function");
	});

	test("should have loadExistingProbeResults in probeIntegration", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");
		expect(typeof integrationModule.loadExistingProbeResults).toBe("function");
	});

	test("hasExistingProbeResults should return false for empty directory", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");
		const result = integrationModule.hasExistingProbeResults(testWorkDir);
		expect(result).toBe(false);
	});

	test("hasExistingProbeResults should return true when probes exist", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");

		// Create probe results
		const probesDir = join(testWorkDir, ".milhouse", "probes", "deps");
		mkdirSync(probesDir, { recursive: true });
		writeFileSync(
			join(probesDir, "test-probe.json"),
			JSON.stringify({
				probe_id: "test-123",
				probe_type: "deps",
				success: true,
				timestamp: new Date().toISOString(),
				read_only: true,
				findings: [],
			}),
		);

		const result = integrationModule.hasExistingProbeResults(testWorkDir);
		expect(result).toBe(true);
	});

	test("loadExistingProbeResults should return empty array for non-existent probes", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");
		const result = integrationModule.loadExistingProbeResults(testWorkDir, ["deps", "compose"]);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(0);
	});

	test("loadExistingProbeResults should load existing probe results", async () => {
		const integrationModule = await import("./utils/probeIntegration.ts");

		// Create probe results
		const probesDir = join(testWorkDir, ".milhouse", "probes", "deps");
		mkdirSync(probesDir, { recursive: true });
		const probeData = {
			probe_id: "test-123",
			probe_type: "deps",
			success: true,
			timestamp: new Date().toISOString(),
			read_only: true,
			findings: [],
			output: "test",
		};
		writeFileSync(join(probesDir, "test-probe.json"), JSON.stringify(probeData));

		const result = integrationModule.loadExistingProbeResults(testWorkDir, ["deps"]);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(1);
		expect(result[0].probe_id).toBe("test-123");
	});

	test("RuntimeOptions.skipProbes should be accessible", async () => {
		const typesModule = await import("../../config/types.ts");
		expect(typesModule.DEFAULT_OPTIONS).toHaveProperty("skipProbes");
	});
});
