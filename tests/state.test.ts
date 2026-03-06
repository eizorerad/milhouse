/**
 * Tests for run state persistence helpers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RunStore } from "../src/state.ts";

describe("RunStore cost persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-state-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("persists cost for later resume", () => {
		const store = RunStore.create(tmpDir, "scope");
		store.saveCost({ inputTokens: 1234, outputTokens: 5678, totalCost: 0.15 });

		const resumed = RunStore.byId(tmpDir, store.runId);
		expect(resumed.loadCost()).toEqual({
			inputTokens: 1234,
			outputTokens: 5678,
			totalCost: 0.15,
		});
	});

	it("returns zero cost when no cost file exists", () => {
		const store = RunStore.create(tmpDir, "scope");
		expect(store.loadCost()).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
		});
	});
});
