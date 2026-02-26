import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { loggers } from "../observability/logger.js";
import { StateLockError } from "./errors.js";
import {
	addNodeDependencySafe,
	assignParallelGroupsSafe,
	buildGraphFromTasksSafe,
	createGraphNode,
	createGraphNodeSafe,
	deleteGraphNodeSafe,
	loadGraph,
	removeNodeDependencySafe,
	saveGraphForRunSafe,
	updateGraphNodeSafe,
	withGraphLock,
} from "./graph.js";
import type { GraphNode, Task } from "./types.js";

describe("graph locking", () => {
	const testDir = join(process.cwd(), ".test-graph-lock");
	// Legacy fallback path (no active run): .milhouse/state/graph.json
	const stateDir = join(testDir, ".milhouse", "state");
	const graphFile = join(stateDir, "graph.json");
	let lockSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(graphFile, "[]");
		lockSpy = spyOn(lockfile, "lock");
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		lockSpy.mockRestore();
		warnSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// --- withGraphLock ---

	describe("withGraphLock", () => {
		test("acquires file lock on the graph.json path", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await withGraphLock(testDir, () => "locked-result");

			expect(result).toBe("locked-result");
			expect(lockSpy).toHaveBeenCalledTimes(1);
			// Verify lock was acquired on graph.json path
			const lockPath = lockSpy.mock.calls[0][0];
			expect(lockPath).toContain("graph.json");
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("releases lock and propagates error if operation throws", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			await expect(
				withGraphLock(testDir, () => {
					throw new Error("operation failed");
				}),
			).rejects.toThrow("operation failed");

			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("throws StateLockError on lock acquisition failure", async () => {
			const err = Object.assign(new Error("locked"), { code: "ELOCKED" });
			lockSpy.mockRejectedValueOnce(err);

			await expect(withGraphLock(testDir, () => "should not run")).rejects.toThrow(
				StateLockError,
			);
		});

		test("concurrent calls both acquire the file lock", async () => {
			const release1 = mock(() => Promise.resolve());
			const release2 = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(release1).mockResolvedValueOnce(release2);

			const r1 = await withGraphLock(testDir, () => "first");
			const r2 = await withGraphLock(testDir, () => "second");

			expect(r1).toBe("first");
			expect(r2).toBe("second");
			// Both calls acquired the lock
			expect(lockSpy).toHaveBeenCalledTimes(2);
			expect(release1).toHaveBeenCalledTimes(1);
			expect(release2).toHaveBeenCalledTimes(1);
		});
	});

	// --- *Safe delegation tests ---

	describe("createGraphNodeSafe", () => {
		test("delegates to createGraphNode and returns the result", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const node = await createGraphNodeSafe(
				{ id: "T1", depends_on: [] },
				testDir,
			);

			expect(node).toEqual({ id: "T1", depends_on: [], parallel_group: 0 });
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("updateGraphNodeSafe", () => {
		test("delegates to updateGraphNode and returns updated node", async () => {
			// Seed graph with a node
			createGraphNode({ id: "T1", depends_on: [] }, testDir);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const updated = await updateGraphNodeSafe(
				"T1",
				{ parallel_group: 2 },
				testDir,
			);

			expect(updated).toEqual({ id: "T1", depends_on: [], parallel_group: 2 });
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("returns null for non-existent node", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await updateGraphNodeSafe("nonexistent", { parallel_group: 1 }, testDir);

			expect(result).toBeNull();
		});
	});

	describe("deleteGraphNodeSafe", () => {
		test("delegates to deleteGraphNode and returns true on success", async () => {
			createGraphNode({ id: "T1", depends_on: [] }, testDir);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await deleteGraphNodeSafe("T1", testDir);

			expect(result).toBe(true);
			expect(loadGraph(testDir)).toEqual([]);
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("returns false for non-existent node", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await deleteGraphNodeSafe("nonexistent", testDir);

			expect(result).toBe(false);
		});
	});

	describe("addNodeDependencySafe", () => {
		test("delegates to addNodeDependency and returns updated node", async () => {
			createGraphNode({ id: "T1", depends_on: [] }, testDir);
			createGraphNode({ id: "T2", depends_on: [] }, testDir);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await addNodeDependencySafe("T2", "T1", testDir);

			expect(result?.depends_on).toEqual(["T1"]);
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("removeNodeDependencySafe", () => {
		test("delegates to removeNodeDependency and returns updated node", async () => {
			createGraphNode({ id: "T1", depends_on: [] }, testDir);
			createGraphNode({ id: "T2", depends_on: ["T1"] }, testDir);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await removeNodeDependencySafe("T2", "T1", testDir);

			expect(result?.depends_on).toEqual([]);
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("assignParallelGroupsSafe", () => {
		test("delegates to assignParallelGroups and returns updated nodes", async () => {
			createGraphNode({ id: "T1", depends_on: [] }, testDir);
			createGraphNode({ id: "T2", depends_on: ["T1"] }, testDir);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const nodes = await assignParallelGroupsSafe(testDir);

			expect(nodes).toHaveLength(2);
			const t1 = nodes.find((n: GraphNode) => n.id === "T1");
			const t2 = nodes.find((n: GraphNode) => n.id === "T2");
			expect(t1?.parallel_group).toBe(0);
			expect(t2?.parallel_group).toBe(1);
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("buildGraphFromTasksSafe", () => {
		test("delegates to buildGraphFromTasks and returns nodes", async () => {
			const now = new Date().toISOString();
			const tasks: Task[] = [
				{
					id: "T1",
					issue_id: "I1",
					title: "Task 1",
					description: "desc",
					depends_on: [],
					files: [],
					checks: [],
					acceptance: [],
					risk: "low",
					rollback: "revert",
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
			];

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const nodes = await buildGraphFromTasksSafe(tasks, testDir);

			expect(nodes).toHaveLength(1);
			expect(nodes[0].id).toBe("T1");
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	// --- saveGraphForRunSafe ---

	describe("saveGraphForRunSafe", () => {
		test("locks the correct run-specific path", async () => {
			const runId = "run-001";
			const runStateDir = join(testDir, ".milhouse", "runs", runId, "state");
			mkdirSync(runStateDir, { recursive: true });
			writeFileSync(join(runStateDir, "graph.json"), "[]");

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const nodes: GraphNode[] = [
				{ id: "T1", depends_on: [], parallel_group: 0 },
			];

			await saveGraphForRunSafe(runId, nodes, testDir);

			expect(lockSpy).toHaveBeenCalledTimes(1);
			const lockPath = lockSpy.mock.calls[0][0];
			expect(lockPath).toContain(runId);
			expect(lockPath).toContain("graph.json");
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("delegates to saveGraphForRun", async () => {
			const runId = "run-002";
			const runStateDir = join(testDir, ".milhouse", "runs", runId, "state");
			mkdirSync(runStateDir, { recursive: true });

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const nodes: GraphNode[] = [
				{ id: "T1", depends_on: [], parallel_group: 0 },
				{ id: "T2", depends_on: ["T1"], parallel_group: 1 },
			];

			await saveGraphForRunSafe(runId, nodes, testDir);

			// Verify the data was actually saved
			const saved = JSON.parse(
				require("node:fs").readFileSync(join(runStateDir, "graph.json"), "utf-8"),
			);
			expect(saved).toHaveLength(2);
			expect(saved[0].id).toBe("T1");
			expect(saved[1].id).toBe("T2");
		});
	});
});
