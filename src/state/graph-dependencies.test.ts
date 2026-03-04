import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { loggers } from "../observability/logger.js";
import { topologicalSortNodes, getNodeDependencies, deleteGraphNode, deleteGraphNodeSafe, loadGraph, createGraphNode } from "./graph.js";
import { topologicalSort, getTaskDependencies } from "./tasks.js";
import type { GraphNode, Task } from "./types.js";

// ============================================
// graph.ts — topologicalSortNodes
// ============================================

describe("topologicalSortNodes missing dependency warnings", () => {
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	test("warns when a node references a non-existent dependency ID", () => {
		const nodes: GraphNode[] = [
			{ id: "A", depends_on: ["non-existent"], parallel_group: 0 },
		];

		topologicalSortNodes(nodes);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toEqual({
			nodeId: "A",
			missingDepId: "non-existent",
		});
		expect(warnSpy.mock.calls[0][1]).toBe("Dependency not found in graph, skipping");
	});

	test("still returns correct sorted order when some deps are missing", () => {
		const nodes: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A", "missing-dep"], parallel_group: 0 },
			{ id: "C", depends_on: ["B"], parallel_group: 0 },
		];

		const result = topologicalSortNodes(nodes);

		expect(result.hasCycle).toBe(false);
		expect(result.sorted.map((n) => n.id)).toEqual(["A", "B", "C"]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("does not warn when all dependencies exist", () => {
		const nodes: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A"], parallel_group: 0 },
		];

		const result = topologicalSortNodes(nodes);

		expect(result.hasCycle).toBe(false);
		expect(result.sorted.map((n) => n.id)).toEqual(["A", "B"]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("warns multiple times for multiple missing deps", () => {
		const nodes: GraphNode[] = [
			{ id: "A", depends_on: ["x", "y"], parallel_group: 0 },
		];

		topologicalSortNodes(nodes);

		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});

// ============================================
// graph.ts — getNodeDependencies
// ============================================

describe("getNodeDependencies missing dependency warnings", () => {
	const testDir = join(process.cwd(), ".test-graph-deps");
	const stateDir = join(testDir, ".milhouse", "state");
	const graphFile = join(stateDir, "graph.json");
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("warns when a dependency ID is not found in the graph", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: ["missing-node"], parallel_group: 0 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = getNodeDependencies("A", testDir);

		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toEqual({
			nodeId: "A",
			missingDepId: "missing-node",
		});
		expect(warnSpy.mock.calls[0][1]).toBe(
			"Dependency not found in graph during getNodeDependencies",
		);
	});

	test("returns found deps and warns for missing ones", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A", "ghost"], parallel_group: 0 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = getNodeDependencies("B", testDir);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("A");
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});

// ============================================
// tasks.ts — topologicalSort
// ============================================

describe("tasks.ts topologicalSort missing dependency warnings", () => {
	const testDir = join(process.cwd(), ".test-tasks-topo");
	const stateDir = join(testDir, ".milhouse", "state");
	const tasksFile = join(stateDir, "tasks.json");
	let warnSpy: ReturnType<typeof spyOn>;

	const makeTask = (id: string, depends_on: string[]): Task => ({
		id,
		issue_id: "I1",
		title: `Task ${id}`,
		description: "desc",
		depends_on,
		files: [],
		checks: [],
		acceptance: [],
		risk: "low",
		rollback: "revert",
		parallel_group: 0,
		status: "pending",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	});

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("warns when visit encounters a non-existent dependency task ID", () => {
		const tasks = [
			makeTask("T1", []),
			makeTask("T2", ["T1", "nonexistent-task"]),
		];
		writeFileSync(tasksFile, JSON.stringify(tasks));

		const sorted = topologicalSort(testDir);

		// visit("nonexistent-task") is called because T2.depends_on includes it.
		// visit adds it to visited, tasks.find returns undefined, so it warns and
		// returns early — the missing task is NOT included in the sorted result.
		expect(sorted.map((t) => t.id)).toEqual(["T1", "T2"]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toEqual({
			missingTaskId: "nonexistent-task",
		});
		expect(warnSpy.mock.calls[0][1]).toBe(
			"Task not found during topological sort, skipping",
		);
	});

	test("does not warn when all dependency tasks exist", () => {
		const tasks = [makeTask("T1", []), makeTask("T2", ["T1"])];
		writeFileSync(tasksFile, JSON.stringify(tasks));

		const sorted = topologicalSort(testDir);

		expect(sorted.map((t) => t.id)).toEqual(["T1", "T2"]);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

// ============================================
// tasks.ts — getTaskDependencies
// ============================================

describe("tasks.ts getTaskDependencies missing dependency warnings", () => {
	const testDir = join(process.cwd(), ".test-tasks-deps");
	const stateDir = join(testDir, ".milhouse", "state");
	const tasksFile = join(stateDir, "tasks.json");
	let warnSpy: ReturnType<typeof spyOn>;

	const makeTask = (id: string, depends_on: string[]): Task => ({
		id,
		issue_id: "I1",
		title: `Task ${id}`,
		description: "desc",
		depends_on,
		files: [],
		checks: [],
		acceptance: [],
		risk: "low",
		rollback: "revert",
		parallel_group: 0,
		status: "pending",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	});

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		warnSpy = spyOn(loggers.state, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("warns when a dependency task ID is not found", () => {
		const tasks = [makeTask("T1", ["missing-task"])];
		writeFileSync(tasksFile, JSON.stringify(tasks));

		const result = getTaskDependencies("T1", testDir);

		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toEqual({
			taskId: "T1",
			missingDepId: "missing-task",
		});
		expect(warnSpy.mock.calls[0][1]).toBe(
			"Dependency not found in task list during getTaskDependencies",
		);
	});

	test("returns found deps and warns for missing ones", () => {
		const tasks = [
			makeTask("T1", []),
			makeTask("T2", ["T1", "phantom"]),
		];
		writeFileSync(tasksFile, JSON.stringify(tasks));

		const result = getTaskDependencies("T2", testDir);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("T1");
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});

// ============================================
// graph.ts — deleteGraphNode dangling dependency cleanup
// ============================================

describe("deleteGraphNode dangling dependency cleanup", () => {
	const testDir = join(process.cwd(), ".test-graph-delete-deps");
	const stateDir = join(testDir, ".milhouse", "state");
	const graphFile = join(stateDir, "graph.json");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(graphFile, "[]");
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("removes deleted node ID from one other node's depends_on", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A"], parallel_group: 1 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = deleteGraphNode("A", testDir);

		expect(result).toBe(true);
		const remaining = loadGraph(testDir);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("B");
		expect(remaining[0].depends_on).toEqual([]);
	});

	test("removes deleted node ID from multiple other nodes' depends_on", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A"], parallel_group: 1 },
			{ id: "C", depends_on: ["A"], parallel_group: 1 },
			{ id: "D", depends_on: ["A"], parallel_group: 1 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = deleteGraphNode("A", testDir);

		expect(result).toBe(true);
		const remaining = loadGraph(testDir);
		expect(remaining).toHaveLength(3);
		for (const node of remaining) {
			expect(node.depends_on).not.toContain("A");
		}
	});

	test("graph is unchanged (except for removed node) when deleted node is not referenced", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: [], parallel_group: 0 },
			{ id: "C", depends_on: ["B"], parallel_group: 1 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = deleteGraphNode("A", testDir);

		expect(result).toBe(true);
		const remaining = loadGraph(testDir);
		expect(remaining).toHaveLength(2);
		expect(remaining[0]).toEqual({ id: "B", depends_on: [], parallel_group: 0 });
		expect(remaining[1]).toEqual({ id: "C", depends_on: ["B"], parallel_group: 1 });
	});

	test("removes only the deleted ID from depends_on, keeping other valid deps", () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: [], parallel_group: 0 },
			{ id: "C", depends_on: ["A", "B"], parallel_group: 1 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const result = deleteGraphNode("A", testDir);

		expect(result).toBe(true);
		const remaining = loadGraph(testDir);
		expect(remaining).toHaveLength(2);
		const nodeC = remaining.find((n) => n.id === "C");
		expect(nodeC).toBeDefined();
		expect(nodeC!.depends_on).toEqual(["B"]);
	});

	test("deleteGraphNodeSafe also cleans up dangling dependencies", async () => {
		const graph: GraphNode[] = [
			{ id: "A", depends_on: [], parallel_group: 0 },
			{ id: "B", depends_on: ["A"], parallel_group: 1 },
		];
		writeFileSync(graphFile, JSON.stringify(graph));

		const lockSpy = spyOn(lockfile, "lock");
		const releaseFn = mock(() => Promise.resolve());
		lockSpy.mockResolvedValueOnce(releaseFn);

		const result = await deleteGraphNodeSafe("A", testDir);

		expect(result).toBe(true);
		const remaining = loadGraph(testDir);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("B");
		expect(remaining[0].depends_on).toEqual([]);

		lockSpy.mockRestore();
	});
});
