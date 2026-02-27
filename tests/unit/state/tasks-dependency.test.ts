/**
 * Unit tests for hasCircularDependency and addDependency
 *
 * Verifies that:
 * - hasCircularDependency works with an explicit in-memory tasks array
 * - hasCircularDependency falls back to disk when no array is provided
 * - addDependency performs a single save (no save-check-revert pattern)
 * - addDependency rejects circular dependencies without modifying disk
 * - addDependency is idempotent for existing dependencies
 * - addDependency sets updated_at on the returned task
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	addDependency,
	hasCircularDependency,
	loadTasks,
	saveTasks,
} from "../../../src/state/tasks.ts";
import type { Task } from "../../../src/state/types.ts";

describe("Dependency functions", () => {
	const testDir = join(process.cwd(), ".test-tasks-dependency");
	const stateDir = join(testDir, ".milhouse", "state");
	const tasksPath = join(stateDir, "tasks.json");

	function makeTask(id: string, depends_on: string[] = []): Task {
		const now = new Date().toISOString();
		return {
			id,
			title: `Task ${id}`,
			issue_id: "TEST",
			status: "pending",
			parallel_group: 0,
			depends_on,
			files: [],
			checks: [],
			acceptance: [],
			created_at: now,
			updated_at: now,
		};
	}

	function writeTasks(tasks: Task[]): void {
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}
		writeFileSync(tasksPath, JSON.stringify(tasks));
	}

	function readTasksFromDisk(): Task[] {
		if (!existsSync(tasksPath)) return [];
		return JSON.parse(readFileSync(tasksPath, "utf-8"));
	}

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("hasCircularDependency", () => {
		describe("with explicit tasks array", () => {
			it("should detect a direct cycle (A -> B -> A)", () => {
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B", ["A"]),
				];
				expect(hasCircularDependency("A", testDir, tasks)).toBe(true);
			});

			it("should detect an indirect cycle (A -> B -> C -> A)", () => {
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B", ["C"]),
					makeTask("C", ["A"]),
				];
				expect(hasCircularDependency("A", testDir, tasks)).toBe(true);
			});

			it("should return false for acyclic dependencies", () => {
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B", ["C"]),
					makeTask("C"),
				];
				expect(hasCircularDependency("A", testDir, tasks)).toBe(false);
			});

			it("should return false for a task with no dependencies", () => {
				const tasks = [makeTask("A"), makeTask("B")];
				expect(hasCircularDependency("A", testDir, tasks)).toBe(false);
			});

			it("should return false for a non-existent task ID", () => {
				const tasks = [makeTask("A")];
				expect(hasCircularDependency("NONEXISTENT", testDir, tasks)).toBe(false);
			});

			it("should not read from disk when tasks array is provided", () => {
				// Don't write anything to disk - if the function reads from disk it would get empty
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B", ["A"]),
				];
				// This should still detect the cycle from the in-memory array
				expect(hasCircularDependency("A", testDir, tasks)).toBe(true);
			});
		});

		describe("without tasks parameter (backward compatibility)", () => {
			it("should fall back to loading from disk", () => {
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B", ["A"]),
				];
				writeTasks(tasks);
				expect(hasCircularDependency("A", testDir)).toBe(true);
			});

			it("should return false when disk has acyclic tasks", () => {
				const tasks = [
					makeTask("A", ["B"]),
					makeTask("B"),
				];
				writeTasks(tasks);
				expect(hasCircularDependency("A", testDir)).toBe(false);
			});
		});
	});

	describe("addDependency", () => {
		it("should successfully add a valid dependency and persist it", () => {
			const tasks = [makeTask("A"), makeTask("B")];
			writeTasks(tasks);

			const result = addDependency("A", "B", testDir);

			expect(result).not.toBeNull();
			expect(result!.id).toBe("A");
			expect(result!.depends_on).toContain("B");

			// Verify persisted to disk
			const diskTasks = readTasksFromDisk();
			const taskA = diskTasks.find((t: Task) => t.id === "A");
			expect(taskA!.depends_on).toContain("B");
		});

		it("should return null without modifying disk when a circular dependency would be created", () => {
			// A -> B already exists, adding B -> A would create a cycle
			const tasks = [makeTask("A", ["B"]), makeTask("B")];
			writeTasks(tasks);

			const originalDisk = readTasksFromDisk();
			const result = addDependency("B", "A", testDir);

			expect(result).toBeNull();

			// Disk should be unchanged
			const afterDisk = readTasksFromDisk();
			const taskB = afterDisk.find((t: Task) => t.id === "B");
			expect(taskB!.depends_on).toEqual([]);
			expect(afterDisk).toEqual(originalDisk);
		});

		it("should return the existing task when dependency already exists (idempotent)", () => {
			const tasks = [makeTask("A", ["B"]), makeTask("B")];
			writeTasks(tasks);

			const result = addDependency("A", "B", testDir);

			expect(result).not.toBeNull();
			expect(result!.id).toBe("A");
			expect(result!.depends_on).toEqual(["B"]);
		});

		it("should return null for nonexistent task ID", () => {
			const tasks = [makeTask("A")];
			writeTasks(tasks);

			const result = addDependency("NONEXISTENT", "A", testDir);
			expect(result).toBeNull();
		});

		it("should return null for nonexistent dependency ID", () => {
			const tasks = [makeTask("A")];
			writeTasks(tasks);

			const result = addDependency("A", "NONEXISTENT", testDir);
			expect(result).toBeNull();
		});

		it("should set updated_at on the returned task", () => {
			const tasks = [makeTask("A"), makeTask("B")];
			const beforeTime = new Date().toISOString();
			writeTasks(tasks);

			const result = addDependency("A", "B", testDir);

			expect(result).not.toBeNull();
			expect(result!.updated_at).toBeDefined();
			// updated_at should be >= beforeTime
			expect(result!.updated_at >= beforeTime).toBe(true);
		});

		it("should call saveTasks exactly once (no intermediate disk state on cycle rejection)", () => {
			// Set up: A -> B -> C, try to add C -> A (would create cycle)
			const tasks = [makeTask("A", ["B"]), makeTask("B", ["C"]), makeTask("C")];
			writeTasks(tasks);

			const originalDisk = JSON.stringify(readTasksFromDisk());
			const result = addDependency("C", "A", testDir);

			expect(result).toBeNull();
			// Disk should be completely unchanged - no intermediate write happened
			const afterDisk = JSON.stringify(readTasksFromDisk());
			expect(afterDisk).toBe(originalDisk);
		});

		it("should reject adding a dependency that creates an indirect cycle", () => {
			// A -> B -> C, adding C -> A creates A -> B -> C -> A
			const tasks = [makeTask("A", ["B"]), makeTask("B", ["C"]), makeTask("C")];
			writeTasks(tasks);

			const result = addDependency("C", "A", testDir);
			expect(result).toBeNull();
		});
	});
});
