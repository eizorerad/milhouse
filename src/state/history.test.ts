/**
 * History Module Tests
 *
 * Tests for state versioning and snapshot functionality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getHistoryDir,
	getStateHistoryDir,
	ensureHistoryDir,
	generateSnapshotId,
	parseSnapshotId,
	saveStateSnapshot,
	listSnapshots,
	loadSnapshot,
	getLatestSnapshot,
	rollbackState,
	enforceSnapshotLimit,
	deleteSnapshot,
	clearSnapshots,
	clearAllHistory,
	getHistoryStats,
	DEFAULT_HISTORY_CONFIG,
} from "./history.ts";
import { createRun, getRunStateDir } from "./runs.ts";
import type { Issue } from "./types.ts";

describe("History Module Tests", () => {
	const testDir = join(process.cwd(), ".test-history");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Directory Functions", () => {
		test("getHistoryDir should return correct path", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const historyDir = getHistoryDir(run.id, testDir);

			expect(historyDir).toContain(run.id);
			expect(historyDir).toContain("history");
		});

		test("getStateHistoryDir should return correct path for state type", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const issuesHistoryDir = getStateHistoryDir(run.id, "issues", testDir);
			const tasksHistoryDir = getStateHistoryDir(run.id, "tasks", testDir);

			expect(issuesHistoryDir).toContain("issues");
			expect(tasksHistoryDir).toContain("tasks");
		});

		test("ensureHistoryDir should create directory if not exists", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const dir = ensureHistoryDir(run.id, "issues", testDir);

			expect(existsSync(dir)).toBe(true);
		});
	});

	describe("Snapshot ID Functions", () => {
		test("generateSnapshotId should create filesystem-safe ID", () => {
			const id = generateSnapshotId();

			// Should not contain colons or periods (filesystem-safe)
			expect(id).not.toContain(":");
			expect(id).not.toContain(".");

			// Should contain date components
			expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
		});

		test("generateSnapshotId should use provided timestamp", () => {
			const timestamp = new Date("2024-01-15T10:30:45.123Z");
			const id = generateSnapshotId(timestamp);

			expect(id).toBe("2024-01-15T10-30-45-123Z");
		});

		test("parseSnapshotId should convert back to Date", () => {
			const original = new Date("2024-01-15T10:30:45.123Z");
			const id = generateSnapshotId(original);
			const parsed = parseSnapshotId(id);

			expect(parsed.getTime()).toBe(original.getTime());
		});
	});

	describe("Snapshot Operations", () => {
		test("saveStateSnapshot should create snapshot file", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const data = { test: "data" };

			const meta = saveStateSnapshot(run.id, "issues", data, {
				reason: "Test snapshot",
				workDir: testDir,
			});

			expect(meta.id).toBeDefined();
			expect(meta.state_type).toBe("issues");
			expect(meta.reason).toBe("Test snapshot");

			// Verify file exists
			const historyDir = getStateHistoryDir(run.id, "issues", testDir);
			expect(existsSync(join(historyDir, `${meta.id}.json`))).toBe(true);
		});

		test("saveStateSnapshot should include agent_id when provided", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const meta = saveStateSnapshot(run.id, "tasks", { test: "data" }, {
				agentId: "agent-123",
				workDir: testDir,
			});

			expect(meta.agent_id).toBe("agent-123");
		});

		test("saveStateSnapshot should skip when history is disabled", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const meta = saveStateSnapshot(run.id, "issues", { test: "data" }, {
				workDir: testDir,
				config: { enabled: false, maxSnapshots: 10 },
			});

			// Should return meta but not create file
			expect(meta.id).toBeDefined();

			const historyDir = getStateHistoryDir(run.id, "issues", testDir);
			expect(existsSync(historyDir)).toBe(false);
		});

		test("listSnapshots should return empty array when no snapshots", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const snapshots = listSnapshots(run.id, "issues", testDir);

			expect(snapshots).toEqual([]);
		});

		test("listSnapshots should return snapshots sorted by date (newest first)", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { reason: "First", workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 2 }, { reason: "Second", workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 3 }, { reason: "Third", workDir: testDir });

			const snapshots = listSnapshots(run.id, "issues", testDir);

			expect(snapshots.length).toBe(3);
			expect(snapshots[0].reason).toBe("Third");
			expect(snapshots[2].reason).toBe("First");
		});

		test("loadSnapshot should return snapshot data", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const originalData = { key: "value", nested: { a: 1 } };

			const meta = saveStateSnapshot(run.id, "issues", originalData, { workDir: testDir });
			const snapshot = loadSnapshot(run.id, "issues", meta.id, testDir);

			expect(snapshot).not.toBeNull();
			expect(snapshot!.meta.id).toBe(meta.id);
			expect(snapshot!.data).toEqual(originalData);
		});

		test("loadSnapshot should return null for non-existent snapshot", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const snapshot = loadSnapshot(run.id, "issues", "non-existent", testDir);

			expect(snapshot).toBeNull();
		});

		test("getLatestSnapshot should return most recent snapshot", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { reason: "Old", workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 2 }, { reason: "Latest", workDir: testDir });

			const latest = getLatestSnapshot(run.id, "issues", testDir);

			expect(latest).not.toBeNull();
			expect(latest!.meta.reason).toBe("Latest");
			expect(latest!.data).toEqual({ v: 2 });
		});

		test("getLatestSnapshot should return null when no snapshots", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const latest = getLatestSnapshot(run.id, "issues", testDir);

			expect(latest).toBeNull();
		});
	});

	describe("Rollback Operations", () => {
		test("rollbackState should restore state from snapshot", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const stateDir = getRunStateDir(run.id, testDir);

			// Create initial state
			const initialData = [{ id: "1", value: "initial" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(initialData));

			// Create snapshot
			const meta = saveStateSnapshot(run.id, "issues", initialData, {
				reason: "Before change",
				workDir: testDir,
			});

			// Modify state
			const modifiedData = [{ id: "1", value: "modified" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(modifiedData));

			// Rollback
			const restored = rollbackState(run.id, "issues", meta.id, { workDir: testDir });

			expect(restored).toEqual(initialData);

			// Verify file was updated
			const currentData = JSON.parse(readFileSync(join(stateDir, "issues.json"), "utf-8"));
			expect(currentData).toEqual(initialData);
		});

		test("rollbackState should create backup before rollback", async () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const stateDir = getRunStateDir(run.id, testDir);

			// Create initial state and snapshot
			const initialData = [{ id: "1" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(initialData));
			const meta = saveStateSnapshot(run.id, "issues", initialData, { workDir: testDir });

			// Wait to ensure different timestamp
			await new Promise((r) => setTimeout(r, 10));

			// Modify state
			const modifiedData = [{ id: "2" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(modifiedData));

			// Rollback
			rollbackState(run.id, "issues", meta.id, { workDir: testDir });

			// Should have 2 snapshots now (original + pre-rollback backup)
			const snapshots = listSnapshots(run.id, "issues", testDir);
			expect(snapshots.length).toBe(2);
			expect(snapshots[0].reason).toContain("Pre-rollback backup");
		});

		test("rollbackState should skip backup when requested", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const stateDir = getRunStateDir(run.id, testDir);

			const initialData = [{ id: "1" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(initialData));
			const meta = saveStateSnapshot(run.id, "issues", initialData, { workDir: testDir });

			const modifiedData = [{ id: "2" }];
			writeFileSync(join(stateDir, "issues.json"), JSON.stringify(modifiedData));

			rollbackState(run.id, "issues", meta.id, { workDir: testDir, skipBackup: true });

			// Should still have only 1 snapshot
			const snapshots = listSnapshots(run.id, "issues", testDir);
			expect(snapshots.length).toBe(1);
		});

		test("rollbackState should return null for non-existent snapshot", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const result = rollbackState(run.id, "issues", "non-existent", { workDir: testDir });

			expect(result).toBeNull();
		});
	});

	describe("Snapshot Cleanup", () => {
		test("enforceSnapshotLimit should remove oldest snapshots", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			// Create 5 snapshots
			for (let i = 0; i < 5; i++) {
				saveStateSnapshot(run.id, "issues", { v: i }, { reason: `Snapshot ${i}`, workDir: testDir });
				await new Promise((r) => setTimeout(r, 10));
			}

			// Enforce limit of 3
			const removed = enforceSnapshotLimit(run.id, "issues", 3, testDir);

			expect(removed).toBe(2);

			const remaining = listSnapshots(run.id, "issues", testDir);
			expect(remaining.length).toBe(3);

			// Should keep newest
			expect(remaining[0].reason).toBe("Snapshot 4");
		});

		test("enforceSnapshotLimit should return 0 when under limit", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { workDir: testDir });
			saveStateSnapshot(run.id, "issues", { v: 2 }, { workDir: testDir });

			const removed = enforceSnapshotLimit(run.id, "issues", 5, testDir);

			expect(removed).toBe(0);
		});

		test("deleteSnapshot should remove specific snapshot", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const meta = saveStateSnapshot(run.id, "issues", { v: 1 }, { workDir: testDir });
			const deleted = deleteSnapshot(run.id, "issues", meta.id, testDir);

			expect(deleted).toBe(true);

			const snapshots = listSnapshots(run.id, "issues", testDir);
			expect(snapshots.length).toBe(0);
		});

		test("deleteSnapshot should return false for non-existent snapshot", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const deleted = deleteSnapshot(run.id, "issues", "non-existent", testDir);

			expect(deleted).toBe(false);
		});

		test("clearSnapshots should remove all snapshots for state type", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 2 }, { workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 3 }, { workDir: testDir });

			const removed = clearSnapshots(run.id, "issues", testDir);

			expect(removed).toBe(3);

			const remaining = listSnapshots(run.id, "issues", testDir);
			expect(remaining.length).toBe(0);
		});

		test("clearAllHistory should remove entire history directory", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { workDir: testDir });
			saveStateSnapshot(run.id, "tasks", { v: 1 }, { workDir: testDir });

			clearAllHistory(run.id, testDir);

			const historyDir = getHistoryDir(run.id, testDir);
			expect(existsSync(historyDir)).toBe(false);
		});
	});

	describe("History Statistics", () => {
		test("getHistoryStats should return stats for all state types", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveStateSnapshot(run.id, "issues", { v: 1 }, { workDir: testDir });
			await new Promise((r) => setTimeout(r, 10));
			saveStateSnapshot(run.id, "issues", { v: 2 }, { workDir: testDir });
			saveStateSnapshot(run.id, "tasks", { v: 1 }, { workDir: testDir });

			const stats = getHistoryStats(run.id, testDir);

			expect(stats.length).toBe(5); // issues, tasks, meta, graph, executions

			const issuesStats = stats.find((s) => s.stateType === "issues");
			expect(issuesStats!.snapshotCount).toBe(2);

			const tasksStats = stats.find((s) => s.stateType === "tasks");
			expect(tasksStats!.snapshotCount).toBe(1);

			const metaStats = stats.find((s) => s.stateType === "meta");
			expect(metaStats!.snapshotCount).toBe(0);
		});

		test("getHistoryStats should include size information", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const largeData = { data: "x".repeat(1000) };
			saveStateSnapshot(run.id, "issues", largeData, { workDir: testDir });

			const stats = getHistoryStats(run.id, testDir);
			const issuesStats = stats.find((s) => s.stateType === "issues");

			expect(issuesStats!.totalSizeBytes).toBeGreaterThan(0);
		});
	});

	describe("Default Configuration", () => {
		test("DEFAULT_HISTORY_CONFIG should have sensible defaults", () => {
			expect(DEFAULT_HISTORY_CONFIG.enabled).toBe(true);
			expect(DEFAULT_HISTORY_CONFIG.maxSnapshots).toBe(10);
		});
	});
});
