/**
 * Tests for daemon loop: cost extraction, totalCost accumulation, and budget enforcement
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DaemonState,
	checkSafetyRails,
	createDaemonState,
	extractRunCost,
	processRunCompletion,
	recordRunComplete,
} from "./loop.ts";

describe("extractRunCost", () => {
	const testDir = join(process.cwd(), ".test-cost-extraction");
	const runId = "run-20240115-test-abc1";
	const runsDir = join(testDir, ".milhouse", "runs", runId, "reports");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(runsDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("returns correct cost when report.json exists with valid cost.total", () => {
		const report = {
			version: "0.2.0",
			run_id: runId,
			cost: { total: 1.5, currency: "USD", by_phase: {} },
		};
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBe(1.5);
	});

	test("returns null when report.json does not exist", () => {
		// runsDir exists but no report.json file
		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns null when report.json is corrupt/invalid JSON", () => {
		writeFileSync(join(runsDir, "report.json"), "not valid json {{{");

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns null when report.json has no cost field", () => {
		const report = { version: "0.2.0", run_id: runId };
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns null when cost.total is negative", () => {
		const report = {
			version: "0.2.0",
			run_id: runId,
			cost: { total: -5.0, currency: "USD", by_phase: {} },
		};
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns null when cost.total is not a number", () => {
		const report = {
			version: "0.2.0",
			run_id: runId,
			cost: { total: "free", currency: "USD", by_phase: {} },
		};
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns null when run directory does not exist at all", () => {
		const cost = extractRunCost("run-nonexistent-xyz", testDir);
		expect(cost).toBeNull();
	});

	test("returns null when cost.total is NaN", () => {
		const report = {
			version: "0.2.0",
			run_id: runId,
			cost: { total: Number.NaN, currency: "USD", by_phase: {} },
		};
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBeNull();
	});

	test("returns correct cost for zero total (valid)", () => {
		const report = {
			version: "0.2.0",
			run_id: runId,
			cost: { total: 0, currency: "USD", by_phase: {} },
		};
		writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

		const cost = extractRunCost(runId, testDir);
		expect(cost).toBe(0);
	});
});

describe("totalCost accumulation", () => {
	test("after recordRunComplete with cost=1.50, entry.cost is 1.50", () => {
		const state = createDaemonState();
		const entry = recordRunComplete(state, {
			exitCode: 0,
			killedByWatchdog: false,
			duration: 5000,
			runId: "run-1",
			cost: 1.5,
		});

		expect(entry.cost).toBe(1.5);
		expect(state.runs).toHaveLength(1);
		expect(state.runs[0].cost).toBe(1.5);
	});

	test("state.totalCost accumulates across multiple runs", () => {
		const state = createDaemonState();
		expect(state.totalCost).toBe(0);

		// Simulate processRunCompletion by manually doing what it does
		// (without needing real file system for getCurrentRunId)
		const entry1 = recordRunComplete(state, {
			exitCode: 0,
			killedByWatchdog: false,
			duration: 5000,
			runId: "run-1",
			cost: 2.0,
		});
		state.totalCost += entry1.cost ?? 0;

		expect(state.totalCost).toBe(2.0);

		const entry2 = recordRunComplete(state, {
			exitCode: 0,
			killedByWatchdog: false,
			duration: 3000,
			runId: "run-2",
			cost: 3.0,
		});
		state.totalCost += entry2.cost ?? 0;

		expect(state.totalCost).toBe(5.0);
		expect(state.runs).toHaveLength(2);
	});

	test("state.totalCost stays 0 when cost is undefined and costExtractionFailures is not affected", () => {
		const state = createDaemonState();

		const entry = recordRunComplete(state, {
			exitCode: 1,
			killedByWatchdog: true,
			duration: 60000,
			runId: "run-crashed",
		});
		// Manual accumulation (not via processRunCompletion)
		if (typeof entry.cost === "number") {
			state.totalCost += entry.cost;
		}

		expect(state.totalCost).toBe(0);
		expect(entry.cost).toBeUndefined();
		// costExtractionFailures is only incremented by processRunCompletion
		expect(state.costExtractionFailures).toBe(0);
	});

	test("processRunCompletion accumulates totalCost from report.json", () => {
		const testDir = join(process.cwd(), ".test-accumulation");
		const runId = "run-20240115-accum-xyz1";
		const runsDir = join(testDir, ".milhouse", "runs", runId, "reports");
		const indexDir = join(testDir, ".milhouse");

		try {
			mkdirSync(runsDir, { recursive: true });

			// Write a report.json with cost
			const report = {
				version: "0.2.0",
				run_id: runId,
				cost: { total: 4.25, currency: "USD", by_phase: {} },
			};
			writeFileSync(join(runsDir, "report.json"), JSON.stringify(report));

			// Write a runs-index.json so getCurrentRunId can find the run
			const runsIndex = {
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "completed" }],
			};
			writeFileSync(join(indexDir, "runs-index.json"), JSON.stringify(runsIndex));

			const state = createDaemonState();
			const entry = processRunCompletion(
				state,
				{ exitCode: 0, killedByWatchdog: false, duration: 10000 },
				testDir,
			);

			expect(entry.cost).toBe(4.25);
			expect(entry.runId).toBe(runId);
			expect(state.totalCost).toBe(4.25);
		} finally {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		}
	});
});

describe("costExtractionFailures tracking", () => {
	test("createDaemonState initializes costExtractionFailures to 0", () => {
		const state = createDaemonState();
		expect(state.costExtractionFailures).toBe(0);
	});

	test("processRunCompletion increments costExtractionFailures when extractRunCost returns null", () => {
		const testDir = join(process.cwd(), ".test-cost-failures");
		const runId = "run-20240115-fail-abc1";
		const runsDir = join(testDir, ".milhouse", "runs", runId, "reports");
		const indexDir = join(testDir, ".milhouse");

		try {
			mkdirSync(runsDir, { recursive: true });

			// Write corrupt report.json to trigger null cost
			writeFileSync(join(runsDir, "report.json"), "not valid json {{{");

			// Write a runs-index.json so getCurrentRunId can find the run
			const runsIndex = {
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "completed" }],
			};
			writeFileSync(join(indexDir, "runs-index.json"), JSON.stringify(runsIndex));

			const state = createDaemonState();
			processRunCompletion(
				state,
				{ exitCode: 0, killedByWatchdog: false, duration: 5000 },
				testDir,
			);

			expect(state.costExtractionFailures).toBe(1);
		} finally {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		}
	});

	test("totalCost is NOT incremented when cost extraction fails", () => {
		const testDir = join(process.cwd(), ".test-cost-no-inflate");
		const runId = "run-20240115-noinflate-abc1";
		const runsDir = join(testDir, ".milhouse", "runs", runId, "reports");
		const indexDir = join(testDir, ".milhouse");

		try {
			mkdirSync(runsDir, { recursive: true });

			// Write corrupt report.json
			writeFileSync(join(runsDir, "report.json"), "not valid json {{{");

			const runsIndex = {
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "completed" }],
			};
			writeFileSync(join(indexDir, "runs-index.json"), JSON.stringify(runsIndex));

			const state = createDaemonState();
			processRunCompletion(
				state,
				{ exitCode: 0, killedByWatchdog: false, duration: 5000 },
				testDir,
			);

			expect(state.totalCost).toBe(0);
			expect(state.costExtractionFailures).toBe(1);
		} finally {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		}
	});

	test("costExtractionFailures accumulates across multiple failed extractions", () => {
		const testDir = join(process.cwd(), ".test-cost-accum-fail");
		const indexDir = join(testDir, ".milhouse");

		try {
			mkdirSync(indexDir, { recursive: true });

			const state = createDaemonState();

			// Simulate 3 runs with missing report.json (no run dirs created)
			for (let i = 1; i <= 3; i++) {
				const rid = `run-20240115-accfail-${i}`;
				const ridDir = join(testDir, ".milhouse", "runs", rid, "reports");
				mkdirSync(ridDir, { recursive: true });
				// No report.json — extractRunCost returns null

				const runsIndex = {
					runs: [{ id: rid, created_at: new Date().toISOString(), phase: "completed" }],
				};
				writeFileSync(join(indexDir, "runs-index.json"), JSON.stringify(runsIndex));

				processRunCompletion(
					state,
					{ exitCode: 0, killedByWatchdog: false, duration: 5000 },
					testDir,
				);
			}

			expect(state.costExtractionFailures).toBe(3);
			expect(state.totalCost).toBe(0);
		} finally {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		}
	});
});

describe("budget enforcement (checkSafetyRails)", () => {
	test("returns budget-exceeded when state.totalCost >= budget", () => {
		const state = createDaemonState();
		state.totalCost = 10.0;

		const result = checkSafetyRails(state, 10.0);
		expect(result.violated).toBe("budget-exceeded");
		expect(result.message).toContain("$10.00");
	});

	test("returns budget-exceeded when state.totalCost > budget", () => {
		const state = createDaemonState();
		state.totalCost = 15.5;

		const result = checkSafetyRails(state, 10.0);
		expect(result.violated).toBe("budget-exceeded");
	});

	test("returns null when state.totalCost < budget", () => {
		const state = createDaemonState();
		state.totalCost = 5.0;

		const result = checkSafetyRails(state, 10.0);
		expect(result.violated).toBeNull();
	});

	test("returns null when budget is 0 (unlimited)", () => {
		const state = createDaemonState();
		state.totalCost = 999.99;

		const result = checkSafetyRails(state, 0);
		expect(result.violated).toBeNull();
	});

	test("budget check works with accumulated costs across runs", () => {
		const state = createDaemonState();

		// Simulate 3 runs that accumulate cost
		for (const cost of [3.0, 4.0, 2.5]) {
			const entry = recordRunComplete(state, {
				exitCode: 0,
				killedByWatchdog: false,
				duration: 5000,
				cost,
			});
			state.totalCost += entry.cost ?? 0;
		}

		expect(state.totalCost).toBe(9.5);

		// Budget of $10 — not exceeded yet
		expect(checkSafetyRails(state, 10.0).violated).toBeNull();

		// One more run puts us over
		const finalEntry = recordRunComplete(state, {
			exitCode: 0,
			killedByWatchdog: false,
			duration: 5000,
			cost: 1.0,
		});
		state.totalCost += finalEntry.cost ?? 0;

		expect(state.totalCost).toBe(10.5);
		expect(checkSafetyRails(state, 10.0).violated).toBe("budget-exceeded");
	});

	test("returns null when budget is negative (treated as no limit)", () => {
		const state = createDaemonState();
		state.totalCost = 100.0;

		const result = checkSafetyRails(state, -1);
		expect(result.violated).toBeNull();
	});
});
