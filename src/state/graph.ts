import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStatePathForCurrentRun } from "./paths.ts";
import { type GraphNode, GraphNodeSchema, type Task } from "./types.ts";

/**
 * Get path to graph state file
 * Uses run-aware path resolution - returns run-specific path if a run is active
 */
function getGraphPath(workDir = process.cwd()): string {
	return getStatePathForCurrentRun("graph", workDir);
}

// ============================================
// Graph CRUD Operations
// ============================================

/**
 * Load raw graph from file without schema validation
 * Used for checking if file has data when loadGraph returns empty
 */
export function loadRawGraph(workDir = process.cwd()): unknown[] {
	const path = getGraphPath(workDir);
	if (!existsSync(path)) {
		return [];
	}
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Load dependency graph from state file
 * Uses safeParse to handle invalid nodes gracefully instead of losing all data
 */
export function loadGraph(workDir = process.cwd()): GraphNode[] {
	const path = getGraphPath(workDir);

	if (!existsSync(path)) {
		return [];
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		if (!Array.isArray(parsed)) {
			return [];
		}

		// Parse each node individually to avoid losing all data if one is invalid
		const validNodes: GraphNode[] = [];
		for (const item of parsed) {
			const result = GraphNodeSchema.safeParse(item);
			if (result.success) {
				validNodes.push(result.data);
			} else {
				// Log but don't fail - preserve other nodes
				console.error(
					`[WARN] Skipping invalid graph node ${item?.id || "unknown"}:`,
					result.error.message,
				);
			}
		}
		return validNodes;
	} catch (error) {
		console.error(`[ERROR] Failed to load graph from ${path}:`, error);
		return [];
	}
}

/**
 * Save dependency graph to state file
 */
export function saveGraph(nodes: GraphNode[], workDir = process.cwd()): void {
	const path = getGraphPath(workDir);
	const dir = join(path, "..");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(path, JSON.stringify(nodes, null, 2));
}

/**
 * Create a new graph node
 */
export function createGraphNode(
	node: Omit<GraphNode, "parallel_group"> & { parallel_group?: number },
	workDir = process.cwd(),
): GraphNode {
	const nodes = loadGraph(workDir);

	const newNode: GraphNode = {
		id: node.id,
		depends_on: [...node.depends_on],
		parallel_group: node.parallel_group ?? 0,
	};

	saveGraph([...nodes, newNode], workDir);
	return newNode;
}

/**
 * Read a graph node by ID
 */
export function readGraphNode(id: string, workDir = process.cwd()): GraphNode | null {
	const nodes = loadGraph(workDir);
	return nodes.find((n) => n.id === id) || null;
}

/**
 * Update a graph node
 */
export function updateGraphNode(
	id: string,
	update: Partial<Omit<GraphNode, "id">>,
	workDir = process.cwd(),
): GraphNode | null {
	const nodes = loadGraph(workDir);
	const index = nodes.findIndex((n) => n.id === id);

	if (index === -1) {
		return null;
	}

	const updated: GraphNode = {
		...nodes[index],
		...update,
	};

	const newNodes = [...nodes.slice(0, index), updated, ...nodes.slice(index + 1)];
	saveGraph(newNodes, workDir);
	return updated;
}

/**
 * Delete a graph node by ID
 */
export function deleteGraphNode(id: string, workDir = process.cwd()): boolean {
	const nodes = loadGraph(workDir);
	const index = nodes.findIndex((n) => n.id === id);

	if (index === -1) {
		return false;
	}

	const newNodes = [...nodes.slice(0, index), ...nodes.slice(index + 1)];
	saveGraph(newNodes, workDir);
	return true;
}

/**
 * Check if a graph node exists
 */
export function graphNodeExists(id: string, workDir = process.cwd()): boolean {
	return readGraphNode(id, workDir) !== null;
}

/**
 * Get total node count
 */
export function countGraphNodes(workDir = process.cwd()): number {
	return loadGraph(workDir).length;
}

// ============================================
// Graph Building Functions
// ============================================

/**
 * Build dependency graph from tasks array (pure function)
 */
export function buildGraphFromTasksArray(tasks: Task[]): GraphNode[] {
	return tasks.map((t) => ({
		id: t.id,
		depends_on: [...t.depends_on],
		parallel_group: t.parallel_group,
	}));
}

/**
 * Build and save dependency graph from tasks file
 */
export function buildGraphFromTasks(tasks: Task[], workDir = process.cwd()): GraphNode[] {
	const nodes = buildGraphFromTasksArray(tasks);
	saveGraph(nodes, workDir);
	return nodes;
}

// ============================================
// Topological Sort
// ============================================

/**
 * Result of topological sort
 */
export interface TopologicalSortResult {
	sorted: GraphNode[];
	hasCycle: boolean;
	cycleNodes?: string[];
}

/**
 * Perform topological sort on graph nodes (pure function)
 * Uses Kahn's algorithm for cycle detection
 */
export function topologicalSortNodes(nodes: GraphNode[]): TopologicalSortResult {
	const nodeMap = new Map<string, GraphNode>();
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	// Initialize
	for (const node of nodes) {
		nodeMap.set(node.id, node);
		inDegree.set(node.id, 0);
		adjacency.set(node.id, []);
	}

	// Build adjacency list and calculate in-degrees
	for (const node of nodes) {
		for (const depId of node.depends_on) {
			if (nodeMap.has(depId)) {
				const adj = adjacency.get(depId);
				if (adj) {
					adj.push(node.id);
				}
				inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
			}
		}
	}

	// Find all nodes with no incoming edges
	const queue: string[] = [];
	for (const [id, degree] of inDegree.entries()) {
		if (degree === 0) {
			queue.push(id);
		}
	}

	const sorted: GraphNode[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		const node = nodeMap.get(current);
		if (node) {
			sorted.push(node);
		}

		// Decrease in-degree for all dependents
		const neighbors = adjacency.get(current) ?? [];
		for (const neighbor of neighbors) {
			const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	// Check for cycle
	if (sorted.length !== nodes.length) {
		// Find nodes in cycle (those with remaining in-degree)
		const cycleNodes: string[] = [];
		for (const [id, degree] of inDegree.entries()) {
			if (degree > 0) {
				cycleNodes.push(id);
			}
		}
		return { sorted: [], hasCycle: true, cycleNodes };
	}

	return { sorted, hasCycle: false };
}

/**
 * Perform topological sort on graph from file
 */
export function topologicalSortGraph(workDir = process.cwd()): TopologicalSortResult {
	const nodes = loadGraph(workDir);
	return topologicalSortNodes(nodes);
}

// ============================================
// Parallel Group Assignment
// ============================================

/**
 * Assign parallel groups based on dependency depth (pure function)
 * Nodes with no dependencies get group 0
 * Nodes with dependencies get max(dependency groups) + 1
 */
export function assignParallelGroupsToNodes(nodes: GraphNode[]): GraphNode[] {
	const nodeMap = new Map<string, GraphNode>();
	const groupMap = new Map<string, number>();

	for (const node of nodes) {
		nodeMap.set(node.id, node);
		groupMap.set(node.id, 0);
	}

	// Iteratively calculate groups
	let changed = true;
	let iterations = 0;
	const maxIterations = nodes.length;

	while (changed && iterations < maxIterations) {
		changed = false;
		iterations++;

		for (const node of nodes) {
			if (node.depends_on.length === 0) {
				continue;
			}

			const maxDepGroup = Math.max(...node.depends_on.map((depId) => groupMap.get(depId) ?? 0));

			const newGroup = maxDepGroup + 1;
			const currentGroup = groupMap.get(node.id) ?? 0;

			if (newGroup > currentGroup) {
				groupMap.set(node.id, newGroup);
				changed = true;
			}
		}
	}

	return nodes.map((n) => ({
		...n,
		parallel_group: groupMap.get(n.id) ?? n.parallel_group,
	}));
}

/**
 * Assign parallel groups to graph from file and save
 */
export function assignParallelGroups(workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const updated = assignParallelGroupsToNodes(nodes);
	saveGraph(updated, workDir);
	return updated;
}

// ============================================
// Dependency Query Functions
// ============================================

/**
 * Get all dependencies of a node (direct)
 */
export function getNodeDependencies(nodeId: string, workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const node = nodes.find((n) => n.id === nodeId);

	if (!node) {
		return [];
	}

	return node.depends_on
		.map((depId) => nodes.find((n) => n.id === depId))
		.filter((n): n is GraphNode => n !== undefined);
}

/**
 * Get all transitive dependencies of a node (recursive)
 */
export function getTransitiveDependencies(nodeId: string, workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const visited = new Set<string>();
	const result: GraphNode[] = [];

	function collectDeps(id: string): void {
		const node = nodes.find((n) => n.id === id);
		if (!node) return;

		for (const depId of node.depends_on) {
			if (visited.has(depId)) continue;
			visited.add(depId);

			const depNode = nodes.find((n) => n.id === depId);
			if (depNode) {
				result.push(depNode);
				collectDeps(depId);
			}
		}
	}

	collectDeps(nodeId);
	return result;
}

/**
 * Get all nodes that depend on a given node (dependents)
 */
export function getDependentNodes(nodeId: string, workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	return nodes.filter((n) => n.depends_on.includes(nodeId));
}

/**
 * Get all transitive dependents of a node (recursive)
 */
export function getTransitiveDependents(nodeId: string, workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const visited = new Set<string>();
	const result: GraphNode[] = [];

	function collectDependents(id: string): void {
		const dependents = nodes.filter((n) => n.depends_on.includes(id));

		for (const dep of dependents) {
			if (visited.has(dep.id)) continue;
			visited.add(dep.id);

			result.push(dep);
			collectDependents(dep.id);
		}
	}

	collectDependents(nodeId);
	return result;
}

// ============================================
// Cycle Detection
// ============================================

/**
 * Check if the graph has any cycles
 */
export function hasCycle(workDir = process.cwd()): boolean {
	const result = topologicalSortGraph(workDir);
	return result.hasCycle;
}

/**
 * Check if adding a dependency would create a cycle (pure function)
 */
export function wouldCreateCycle(nodes: GraphNode[], fromId: string, toId: string): boolean {
	// Creating a dependency from fromId to toId means fromId depends on toId
	// This would create a cycle if toId already (transitively) depends on fromId

	const visited = new Set<string>();

	function checkPath(current: string, target: string): boolean {
		if (current === target) return true;
		if (visited.has(current)) return false;
		visited.add(current);

		const node = nodes.find((n) => n.id === current);
		if (!node) return false;

		for (const depId of node.depends_on) {
			if (checkPath(depId, target)) {
				return true;
			}
		}

		return false;
	}

	// Check if toId can reach fromId (meaning fromId already depends transitively on toId)
	return checkPath(toId, fromId);
}

/**
 * Find nodes involved in cycles
 */
export function findCycleNodes(workDir = process.cwd()): string[] {
	const result = topologicalSortGraph(workDir);
	return result.cycleNodes ?? [];
}

// ============================================
// Dependency Management
// ============================================

/**
 * Add a dependency to a node
 */
export function addNodeDependency(
	nodeId: string,
	dependencyId: string,
	workDir = process.cwd(),
): GraphNode | null {
	const nodes = loadGraph(workDir);
	const nodeIndex = nodes.findIndex((n) => n.id === nodeId);
	const depExists = nodes.some((n) => n.id === dependencyId);

	if (nodeIndex === -1 || !depExists) {
		return null;
	}

	const node = nodes[nodeIndex];

	// Already has this dependency
	if (node.depends_on.includes(dependencyId)) {
		return node;
	}

	// Check for cycle
	if (wouldCreateCycle(nodes, nodeId, dependencyId)) {
		return null;
	}

	const updated: GraphNode = {
		...node,
		depends_on: [...node.depends_on, dependencyId],
	};

	const newNodes = [...nodes.slice(0, nodeIndex), updated, ...nodes.slice(nodeIndex + 1)];
	saveGraph(newNodes, workDir);
	return updated;
}

/**
 * Remove a dependency from a node
 */
export function removeNodeDependency(
	nodeId: string,
	dependencyId: string,
	workDir = process.cwd(),
): GraphNode | null {
	const nodes = loadGraph(workDir);
	const nodeIndex = nodes.findIndex((n) => n.id === nodeId);

	if (nodeIndex === -1) {
		return null;
	}

	const node = nodes[nodeIndex];
	const newDeps = node.depends_on.filter((id) => id !== dependencyId);

	if (newDeps.length === node.depends_on.length) {
		return node;
	}

	const updated: GraphNode = {
		...node,
		depends_on: newDeps,
	};

	const newNodes = [...nodes.slice(0, nodeIndex), updated, ...nodes.slice(nodeIndex + 1)];
	saveGraph(newNodes, workDir);
	return updated;
}

// ============================================
// Parallel Group Queries
// ============================================

/**
 * Get distinct parallel groups (sorted)
 */
export function getParallelGroups(workDir = process.cwd()): number[] {
	const nodes = loadGraph(workDir);
	const groups = new Set<number>();
	for (const node of nodes) {
		groups.add(node.parallel_group);
	}
	return [...groups].sort((a, b) => a - b);
}

/**
 * Get nodes by parallel group
 */
export function getNodesByParallelGroup(group: number, workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	return nodes.filter((n) => n.parallel_group === group);
}

/**
 * Get execution order as groups of nodes
 */
export function getExecutionOrder(workDir = process.cwd()): GraphNode[][] {
	const groups = getParallelGroups(workDir);
	const result: GraphNode[][] = [];

	for (const group of groups) {
		const groupNodes = getNodesByParallelGroup(group, workDir);
		// Sort by dependency count within group (fewer deps first)
		const sorted = [...groupNodes].sort((a, b) => a.depends_on.length - b.depends_on.length);
		result.push(sorted);
	}

	return result;
}

// ============================================
// Validation
// ============================================

/**
 * Validate all dependencies exist in the graph
 */
export function validateGraphDependencies(workDir = process.cwd()): {
	valid: boolean;
	missingDependencies: Array<{ nodeId: string; missingDepId: string }>;
} {
	const nodes = loadGraph(workDir);
	const nodeIds = new Set(nodes.map((n) => n.id));
	const missing: Array<{ nodeId: string; missingDepId: string }> = [];

	for (const node of nodes) {
		for (const depId of node.depends_on) {
			if (!nodeIds.has(depId)) {
				missing.push({ nodeId: node.id, missingDepId: depId });
			}
		}
	}

	return {
		valid: missing.length === 0,
		missingDependencies: missing,
	};
}

/**
 * Get orphan nodes (nodes with no dependencies and no dependents)
 */
export function getOrphanNodes(workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const hasDependent = new Set<string>();

	for (const node of nodes) {
		for (const depId of node.depends_on) {
			hasDependent.add(depId);
		}
	}

	return nodes.filter((n) => n.depends_on.length === 0 && !hasDependent.has(n.id));
}

/**
 * Get root nodes (nodes with no dependencies)
 */
export function getRootNodes(workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	return nodes.filter((n) => n.depends_on.length === 0);
}

/**
 * Get leaf nodes (nodes with no dependents)
 */
export function getLeafNodes(workDir = process.cwd()): GraphNode[] {
	const nodes = loadGraph(workDir);
	const hasDependent = new Set<string>();

	for (const node of nodes) {
		for (const depId of node.depends_on) {
			hasDependent.add(depId);
		}
	}

	return nodes.filter((n) => !hasDependent.has(n.id));
}

// ============================================
// Graph Statistics
// ============================================

/**
 * Get graph statistics
 */
export function getGraphStats(workDir = process.cwd()): {
	nodeCount: number;
	edgeCount: number;
	parallelGroups: number;
	maxDepth: number;
	rootCount: number;
	leafCount: number;
	orphanCount: number;
	hasCycles: boolean;
} {
	const nodes = loadGraph(workDir);
	const groups = getParallelGroups(workDir);
	const sortResult = topologicalSortNodes(nodes);

	let edgeCount = 0;
	for (const node of nodes) {
		edgeCount += node.depends_on.length;
	}

	const maxDepth = groups.length > 0 ? Math.max(...groups) : 0;
	const rootNodes = nodes.filter((n) => n.depends_on.length === 0);
	const hasDependent = new Set<string>();
	for (const node of nodes) {
		for (const depId of node.depends_on) {
			hasDependent.add(depId);
		}
	}
	const leafNodes = nodes.filter((n) => !hasDependent.has(n.id));
	const orphanNodes = rootNodes.filter((n) => !hasDependent.has(n.id));

	return {
		nodeCount: nodes.length,
		edgeCount,
		parallelGroups: groups.length,
		maxDepth,
		rootCount: rootNodes.length,
		leafCount: leafNodes.length,
		orphanCount: orphanNodes.length,
		hasCycles: sortResult.hasCycle,
	};
}
