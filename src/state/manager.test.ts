import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProbeResults, saveProbeResult } from "./probes.ts";
import type { ProbeFinding, ProbeResult } from "./types.ts";

describe("Probe Result Persistence", () => {
	const testDir = join(process.cwd(), ".test-milhouse");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse", "probes", "validation"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("should preserve findings array when saving and loading probe results", () => {
		const findings: ProbeFinding[] = [
			{
				id: "finding-1",
				title: "Test Finding",
				description: "A test finding description",
				severity: "HIGH",
				file: "test.ts",
				line: 42,
				evidence: ["evidence-1"],
				metadata: { key: "value" },
			},
			{
				id: "finding-2",
				title: "Another Finding",
				description: "Another test finding",
				severity: "MEDIUM",
				evidence: [],
				metadata: {},
			},
		];

		const probeResult: ProbeResult = {
			probe_id: "probe-test-123",
			probe_type: "validation",
			success: true,
			output: "Test output",
			timestamp: new Date().toISOString(),
			read_only: true,
			duration_ms: 100,
			findings,
			raw_output: "Raw output from command",
			exit_code: 0,
		};

		saveProbeResult(probeResult, testDir);
		const loadedResults = loadProbeResults("validation", testDir);

		expect(loadedResults).toHaveLength(1);
		const loaded = loadedResults[0];

		expect(loaded.probe_id).toBe(probeResult.probe_id);
		expect(loaded.probe_type).toBe(probeResult.probe_type);
		expect(loaded.success).toBe(probeResult.success);
		expect(loaded.output).toBe(probeResult.output);
		expect(loaded.raw_output).toBe(probeResult.raw_output);
		expect(loaded.exit_code).toBe(probeResult.exit_code);
		expect(loaded.duration_ms).toBe(probeResult.duration_ms);

		// Critical: verify findings are preserved
		expect(loaded.findings).toHaveLength(2);
		expect(loaded.findings[0].id).toBe("finding-1");
		expect(loaded.findings[0].title).toBe("Test Finding");
		expect(loaded.findings[0].severity).toBe("HIGH");
		expect(loaded.findings[0].file).toBe("test.ts");
		expect(loaded.findings[0].line).toBe(42);
		expect(loaded.findings[0].evidence).toEqual(["evidence-1"]);
		expect(loaded.findings[0].metadata).toEqual({ key: "value" });

		expect(loaded.findings[1].id).toBe("finding-2");
		expect(loaded.findings[1].severity).toBe("MEDIUM");
	});

	test("should handle probe results without findings (backward compatibility)", () => {
		const probeResult: ProbeResult = {
			probe_id: "probe-no-findings",
			probe_type: "validation",
			success: true,
			output: "Test output",
			timestamp: new Date().toISOString(),
			read_only: true,
			findings: [],
		};

		saveProbeResult(probeResult, testDir);
		const loadedResults = loadProbeResults("validation", testDir);

		expect(loadedResults).toHaveLength(1);
		expect(loadedResults[0].findings).toEqual([]);
	});

	test("should preserve empty findings array (not undefined)", () => {
		const probeResult: ProbeResult = {
			probe_id: "probe-empty-findings",
			probe_type: "validation",
			success: false,
			error: "Test error",
			timestamp: new Date().toISOString(),
			read_only: true,
			findings: [],
		};

		saveProbeResult(probeResult, testDir);
		const loadedResults = loadProbeResults("validation", testDir);

		expect(loadedResults).toHaveLength(1);
		expect(loadedResults[0].findings).toBeDefined();
		expect(Array.isArray(loadedResults[0].findings)).toBe(true);
		expect(loadedResults[0].findings).toHaveLength(0);
	});

	test("should preserve raw_output and exit_code fields", () => {
		const probeResult: ProbeResult = {
			probe_id: "probe-with-raw",
			probe_type: "validation",
			success: true,
			output: "Summary output",
			timestamp: new Date().toISOString(),
			read_only: true,
			findings: [],
			raw_output: "Full command output with\nmultiple lines\nand details",
			exit_code: 0,
		};

		saveProbeResult(probeResult, testDir);
		const loadedResults = loadProbeResults("validation", testDir);

		expect(loadedResults).toHaveLength(1);
		expect(loadedResults[0].raw_output).toBe(probeResult.raw_output);
		expect(loadedResults[0].exit_code).toBe(0);
	});

	test("should handle all probe types correctly", () => {
		const probeTypes = ["compose", "postgres", "redis", "storage", "deps", "repro"] as const;

		for (const probeType of probeTypes) {
			// Create directory for probe type
			mkdirSync(join(testDir, ".milhouse", "probes", probeType), { recursive: true });

			const probeResult: ProbeResult = {
				probe_id: `probe-${probeType}-test`,
				probe_type: probeType,
				success: true,
				output: `Output for ${probeType}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				findings: [
					{
						id: `finding-${probeType}`,
						title: `Finding for ${probeType}`,
						description: `Test finding for ${probeType} probe`,
						severity: "INFO",
						evidence: [],
						metadata: {},
					},
				],
			};

			saveProbeResult(probeResult, testDir);
			const loadedResults = loadProbeResults(probeType, testDir);

			expect(loadedResults).toHaveLength(1);
			expect(loadedResults[0].probe_type).toBe(probeType);
			expect(loadedResults[0].findings).toHaveLength(1);
			expect(loadedResults[0].findings[0].title).toBe(`Finding for ${probeType}`);
		}
	});
});
