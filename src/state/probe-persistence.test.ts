import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProbeFinding, createProbeResult } from "../probes/types.ts";
import { loadProbeResults, saveProbeResult } from "./probes.ts";

describe("Probe Save/Load Integration", () => {
	const testDir = join(process.cwd(), ".test-probe-integration");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		// Create directory structure for all probe types
		const probeTypes = ["compose", "postgres", "redis", "storage", "deps", "repro", "validation"];
		for (const probeType of probeTypes) {
			mkdirSync(join(testDir, ".milhouse", "probes", probeType), { recursive: true });
		}
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("createProbeResult with findings saves and loads correctly via manager", () => {
		// Create probe result using the helper from probes/types.ts
		const findings = [
			createProbeFinding(
				"integration-finding-1",
				"Integration Test Finding",
				"This finding was created using createProbeFinding helper",
				"HIGH",
				{
					file: "src/integration/test.ts",
					line: 50,
					line_end: 75,
					suggestion: "Refactor this code for better performance",
					evidence: ["evidence-1", "evidence-2"],
					metadata: { category: "performance", source: "integration-test" },
				},
			),
		];

		const probeResult = createProbeResult("integration-probe-1", "compose", true, {
			output: "Integration test output",
			findings,
			duration_ms: 250,
			raw_output: "Raw integration test output",
			exit_code: 0,
		});

		// Save using state manager
		saveProbeResult(probeResult, testDir);

		// Load using state manager
		const loadedResults = loadProbeResults("compose", testDir);

		expect(loadedResults).toHaveLength(1);
		const loaded = loadedResults[0];

		// Verify the probe result
		expect(loaded.probe_id).toBe("integration-probe-1");
		expect(loaded.probe_type).toBe("compose");
		expect(loaded.success).toBe(true);
		expect(loaded.output).toBe("Integration test output");
		expect(loaded.duration_ms).toBe(250);
		expect(loaded.raw_output).toBe("Raw integration test output");
		expect(loaded.exit_code).toBe(0);

		// Verify findings were preserved
		expect(loaded.findings).toHaveLength(1);
		expect(loaded.findings[0].id).toBe("integration-finding-1");
		expect(loaded.findings[0].title).toBe("Integration Test Finding");
		expect(loaded.findings[0].severity).toBe("HIGH");
		expect(loaded.findings[0].file).toBe("src/integration/test.ts");
		expect(loaded.findings[0].line).toBe(50);
		expect(loaded.findings[0].line_end).toBe(75);
		expect(loaded.findings[0].suggestion).toBe("Refactor this code for better performance");
		expect(loaded.findings[0].evidence).toEqual(["evidence-1", "evidence-2"]);
		expect(loaded.findings[0].metadata).toEqual({
			category: "performance",
			source: "integration-test",
		});
	});

	test("multiple probe results with findings can be saved and loaded", () => {
		// Create multiple probe results with various findings
		const probeResults = [
			createProbeResult("multi-probe-1", "postgres", true, {
				output: "Database schema check",
				findings: [
					createProbeFinding("pg-finding-1", "Missing index", "Table users lacks index", "MEDIUM"),
					createProbeFinding(
						"pg-finding-2",
						"Unused column",
						"Column deprecated_field unused",
						"LOW",
					),
				],
			}),
			createProbeResult("multi-probe-2", "postgres", true, {
				output: "Migration check",
				findings: [
					createProbeFinding(
						"pg-finding-3",
						"Missing migration",
						"No migration for schema change",
						"HIGH",
					),
				],
			}),
		];

		// Save all probe results
		for (const result of probeResults) {
			saveProbeResult(result, testDir);
		}

		// Load all results
		const loadedResults = loadProbeResults("postgres", testDir);

		expect(loadedResults).toHaveLength(2);

		// Verify all findings were preserved
		const allFindings = loadedResults.flatMap((r) => r.findings);
		expect(allFindings).toHaveLength(3);

		const findingIds = allFindings.map((f) => f.id);
		expect(findingIds).toContain("pg-finding-1");
		expect(findingIds).toContain("pg-finding-2");
		expect(findingIds).toContain("pg-finding-3");
	});

	test("all severity levels are preserved correctly", () => {
		const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
		const findings = severities.map((severity, i) =>
			createProbeFinding(
				`severity-finding-${i}`,
				`${severity} Finding`,
				`A ${severity} level finding`,
				severity,
			),
		);

		const probeResult = createProbeResult("severity-test-probe", "redis", true, {
			findings,
		});

		saveProbeResult(probeResult, testDir);
		const loadedResults = loadProbeResults("redis", testDir);

		expect(loadedResults).toHaveLength(1);
		expect(loadedResults[0].findings).toHaveLength(5);

		// Verify each severity was preserved
		for (let i = 0; i < severities.length; i++) {
			expect(loadedResults[0].findings[i].severity).toBe(severities[i]);
		}
	});

	test("probe result with error and no findings loads correctly", () => {
		const errorResult = createProbeResult("error-probe", "deps", false, {
			error: "Failed to connect to npm registry",
			raw_output: "Error: ENOTFOUND registry.npmjs.org",
			exit_code: 1,
		});

		saveProbeResult(errorResult, testDir);
		const loadedResults = loadProbeResults("deps", testDir);

		expect(loadedResults).toHaveLength(1);
		expect(loadedResults[0].success).toBe(false);
		expect(loadedResults[0].error).toBe("Failed to connect to npm registry");
		expect(loadedResults[0].exit_code).toBe(1);
		expect(loadedResults[0].findings).toEqual([]);
	});
});
