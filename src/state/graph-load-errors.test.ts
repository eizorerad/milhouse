import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loggers } from "../observability/logger.js";
import { StateParseError } from "./errors.js";
import { loadGraph, loadGraphForRun, loadRawGraph } from "./graph.js";

describe("graph load error discrimination", () => {
	const testDir = join(process.cwd(), ".test-graph-load-errors");
	// ForRun variant paths: .milhouse/runs/{runId}/state/graph.json
	const runId = "test-run-001";
	const runStateDir = join(testDir, ".milhouse", "runs", runId, "state");
	const runGraphFile = join(runStateDir, "graph.json");
	// Legacy (non-run) paths: .milhouse/state/graph.json
	const legacyStateDir = join(testDir, ".milhouse", "state");
	const legacyGraphFile = join(legacyStateDir, "graph.json");

	let errorSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(runStateDir, { recursive: true });
		mkdirSync(legacyStateDir, { recursive: true });
		errorSpy = spyOn(loggers.state, "error").mockImplementation(() => {});
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
		warnSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// ============================================
	// loadGraphForRun
	// ============================================

	describe("loadGraphForRun", () => {
		test("returns empty array when file does not exist", () => {
			// Don't create the file — it shouldn't exist
			if (existsSync(runGraphFile)) rmSync(runGraphFile);
			const result = loadGraphForRun(runId, testDir);
			expect(result).toEqual([]);
		});

		test("returns valid nodes when file contains valid JSON graph data", () => {
			const nodes = [
				{ id: "T1", depends_on: [], parallel_group: 0 },
				{ id: "T2", depends_on: ["T1"], parallel_group: 1 },
			];
			writeFileSync(runGraphFile, JSON.stringify(nodes));
			const result = loadGraphForRun(runId, testDir);
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe("T1");
			expect(result[1].id).toBe("T2");
			expect(result[1].depends_on).toEqual(["T1"]);
		});

		test("throws StateParseError when file contains invalid JSON", () => {
			writeFileSync(runGraphFile, "{corrupted");
			expect(() => loadGraphForRun(runId, testDir)).toThrow(StateParseError);
		});

		test("returns empty array for valid JSON that is not an array", () => {
			// Non-array JSON is intentional schema validation — returns []
			writeFileSync(runGraphFile, '{"key":"val"}');
			const result = loadGraphForRun(runId, testDir);
			expect(result).toEqual([]);
		});

		test("thrown StateParseError has correct filePath and cause", () => {
			writeFileSync(runGraphFile, "not-json!!!");
			try {
				loadGraphForRun(runId, testDir);
				expect.unreachable("should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(StateParseError);
				const spe = error as StateParseError;
				expect(spe.filePath).toBe(runGraphFile);
				expect(spe.cause).toBeInstanceOf(Error);
			}
		});

		test("logs via loggers.state.error before throwing", () => {
			writeFileSync(runGraphFile, "{bad-json");
			try {
				loadGraphForRun(runId, testDir);
			} catch {
				// expected
			}
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});
	});

	// ============================================
	// loadRawGraph
	// ============================================

	describe("loadRawGraph", () => {
		test("returns empty array when file does not exist", () => {
			// Remove the legacy graph file if it exists
			if (existsSync(legacyGraphFile)) rmSync(legacyGraphFile);
			const result = loadRawGraph(testDir);
			expect(result).toEqual([]);
		});

		test("throws StateParseError on invalid JSON", () => {
			writeFileSync(legacyGraphFile, "{{invalid");
			expect(() => loadRawGraph(testDir)).toThrow(StateParseError);
		});

		test("returns empty array for valid JSON that is not an array", () => {
			writeFileSync(legacyGraphFile, '{"not":"array"}');
			const result = loadRawGraph(testDir);
			expect(result).toEqual([]);
		});
	});

	// ============================================
	// loadGraph
	// ============================================

	describe("loadGraph", () => {
		test("returns empty array when file does not exist", () => {
			if (existsSync(legacyGraphFile)) rmSync(legacyGraphFile);
			const result = loadGraph(testDir);
			expect(result).toEqual([]);
		});

		test("throws StateParseError on invalid JSON", () => {
			writeFileSync(legacyGraphFile, "corrupted-data");
			expect(() => loadGraph(testDir)).toThrow(StateParseError);
		});

		test("logs via loggers.state.error when throwing", () => {
			writeFileSync(legacyGraphFile, "{bad");
			try {
				loadGraph(testDir);
			} catch {
				// expected
			}
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});

		test("skips individual invalid nodes with warnings (preserved safeParse behavior)", () => {
			// Mix of valid and invalid nodes — invalid ones are skipped, valid ones preserved
			const data = [
				{ id: "T1", depends_on: [], parallel_group: 0 },
				{ invalid: "node" }, // missing required fields
				{ id: "T3", depends_on: [], parallel_group: 0 },
			];
			writeFileSync(legacyGraphFile, JSON.stringify(data));
			const result = loadGraph(testDir);
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe("T1");
			expect(result[1].id).toBe("T3");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});
	});
});
