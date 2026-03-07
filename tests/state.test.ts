/**
 * Tests for run state persistence helpers.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RunStore } from "../src/state.ts";
import type { RunsIndex } from "../src/state.ts";

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

describe("RunStore.listRuns", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-list-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when no runs exist", () => {
		const runs = RunStore.listRuns(tmpDir);
		expect(runs).toEqual([]);
	});

	it("returns all runs with correct fields after creating multiple runs", () => {
		RunStore.create(tmpDir, "scope-a");
		RunStore.create(tmpDir, "scope-b");

		const runs = RunStore.listRuns(tmpDir);
		expect(runs).toHaveLength(2);
		expect(runs[0].scope).toBe("scope-a");
		expect(runs[0].status).toBe("running");
		expect(runs[0].phase).toBe("scan");
		expect(runs[0].created_at).toBeTruthy();
		expect(runs[1].scope).toBe("scope-b");
	});
});

describe("RunStore.cleanRuns", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-clean-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function setRunCreatedAt(workDir: string, runId: string, dateIso: string): void {
		const indexPath = join(workDir, ".milhouse", "runs-index.json");
		const index = JSON.parse(readFileSync(indexPath, "utf-8")) as RunsIndex;
		const entry = index.runs.find((r) => r.id === runId);
		if (entry) entry.created_at = dateIso;
		writeFileSync(indexPath, JSON.stringify(index, null, 2));
	}

	it("removes completed runs older than N days and keeps recent ones", () => {
		const old = RunStore.create(tmpDir, "old");
		old.completeRun();
		setRunCreatedAt(tmpDir, old.runId, "2020-01-01T00:00:00Z");

		const recent = RunStore.create(tmpDir, "recent");
		recent.completeRun();

		const result = RunStore.cleanRuns(tmpDir, 30);
		expect(result.removed).toEqual([old.runId]);
		expect(result.kept).toBe(1);
	});

	it("keeps running runs regardless of age", () => {
		const running = RunStore.create(tmpDir, "running");
		setRunCreatedAt(tmpDir, running.runId, "2020-01-01T00:00:00Z");

		const result = RunStore.cleanRuns(tmpDir, 0);
		expect(result.removed).toEqual([]);
		expect(result.kept).toBe(1);
	});

	it("returns correct removed/kept counts", () => {
		const a = RunStore.create(tmpDir, "a");
		a.completeRun();
		setRunCreatedAt(tmpDir, a.runId, "2020-01-01T00:00:00Z");

		const b = RunStore.create(tmpDir, "b");
		b.stopRun("exec", "failed");
		setRunCreatedAt(tmpDir, b.runId, "2020-02-01T00:00:00Z");

		const c = RunStore.create(tmpDir, "c"); // running, recent

		const result = RunStore.cleanRuns(tmpDir, 30);
		expect(result.removed).toHaveLength(2);
		expect(result.kept).toBe(1);
	});

	it("deletes cleaned run directories from disk", () => {
		const store = RunStore.create(tmpDir, "deleteme");
		store.completeRun();
		setRunCreatedAt(tmpDir, store.runId, "2020-01-01T00:00:00Z");

		const runDir = join(tmpDir, ".milhouse", "runs", store.runId);
		expect(existsSync(runDir)).toBe(true);

		RunStore.cleanRuns(tmpDir, 30);
		expect(existsSync(runDir)).toBe(false);
	});
});

describe("listRuns and cleanRuns edge cases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-edge-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function setRunCreatedAt(workDir: string, runId: string, dateIso: string): void {
		const indexPath = join(workDir, ".milhouse", "runs-index.json");
		const index = JSON.parse(readFileSync(indexPath, "utf-8")) as RunsIndex;
		const entry = index.runs.find((r) => r.id === runId);
		if (entry) entry.created_at = dateIso;
		writeFileSync(indexPath, JSON.stringify(index, null, 2));
	}

	it("clean with 0 days removes all eligible completed/failed runs", () => {
		const a = RunStore.create(tmpDir, "a");
		a.completeRun();
		const b = RunStore.create(tmpDir, "b");
		b.stopRun("exec", "failed");

		const result = RunStore.cleanRuns(tmpDir, 0);
		expect(result.removed).toHaveLength(2);
		expect(result.kept).toBe(0);
	});

	it("clean with very large days removes none", () => {
		const a = RunStore.create(tmpDir, "a");
		a.completeRun();
		setRunCreatedAt(tmpDir, a.runId, "2020-01-01T00:00:00Z");

		const result = RunStore.cleanRuns(tmpDir, 999999);
		expect(result.removed).toHaveLength(0);
		expect(result.kept).toBe(1);
	});

	it("list-runs with mixed statuses shows all", () => {
		const a = RunStore.create(tmpDir, "running-scope");
		const b = RunStore.create(tmpDir, "completed-scope");
		b.completeRun();
		const c = RunStore.create(tmpDir, "failed-scope");
		c.stopRun("exec", "failed");

		const runs = RunStore.listRuns(tmpDir);
		expect(runs).toHaveLength(3);

		const statuses = runs.map((r) => r.status);
		expect(statuses).toContain("running");
		expect(statuses).toContain("completed");
		expect(statuses).toContain("failed");
	});

	it("clean does not affect runs-index.json when no runs to clean", () => {
		const a = RunStore.create(tmpDir, "active");

		const result = RunStore.cleanRuns(tmpDir, 30);
		expect(result.removed).toHaveLength(0);
		expect(result.kept).toBe(1);

		const runs = RunStore.listRuns(tmpDir);
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe(a.runId);
	});
});
