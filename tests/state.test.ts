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
		store.saveCost({ inputTokens: 1234, outputTokens: 5678, totalCost: 0.15, byPhase: {} });

		const resumed = RunStore.byId(tmpDir, store.runId);
		expect(resumed.loadCost()).toEqual({
			inputTokens: 1234,
			outputTokens: 5678,
			totalCost: 0.15,
			byPhase: {},
		});
	});

	it("returns zero cost when no cost file exists", () => {
		const store = RunStore.create(tmpDir, "scope");
		expect(store.loadCost()).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			byPhase: {},
		});
	});

	it("tracks phase lifecycle separately from run completion", () => {
		const store = RunStore.create(tmpDir, "scope");

		store.startPhase("scan");
		store.completePhase("scan");
		store.startPhase("plan");
		store.stopRun("plan", "stopped");

		expect(store.loadMeta()).toMatchObject({
			phase: "plan",
			status: "stopped",
			last_completed_phase: "scan",
		});

		store.completeRun();

		expect(store.loadMeta()).toMatchObject({
			phase: "completed",
			status: "completed",
			last_completed_phase: "scan",
		});
	});

	it("rebuilds stats from persisted issues and tasks", () => {
		const store = RunStore.create(tmpDir, "scope");
		const now = "2026-01-01T00:00:00Z";

		store.saveIssues([
			{
				id: "P-1",
				type: "bug",
				title: "A",
				rationale: "",
				severity: "HIGH",
				status: "CONFIRMED",
				evidence: [],
				created_at: now,
				updated_at: now,
			},
			{
				id: "P-2",
				type: "bug",
				title: "B",
				rationale: "",
				severity: "LOW",
				status: "UNVALIDATED",
				evidence: [],
				created_at: now,
				updated_at: now,
			},
		]);
		store.saveTasks([
			{
				id: "T-1",
				issue_id: "P-1",
				title: "done",
				files: [],
				depends_on: [],
				checks: [],
				acceptance: [],
				parallel_group: 0,
				status: "done",
				created_at: now,
				updated_at: now,
			},
			{
				id: "T-2",
				issue_id: "P-1",
				title: "failed",
				files: [],
				depends_on: [],
				checks: [],
				acceptance: [],
				parallel_group: 0,
				status: "failed",
				created_at: now,
				updated_at: now,
			},
		]);

		store.refreshStats();

		expect(store.loadMeta()).toMatchObject({
			issues_found: 2,
			issues_validated: 1,
			tasks_total: 2,
			tasks_completed: 1,
			tasks_failed: 1,
		});
	});
});
