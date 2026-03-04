/**
 * Cross-runtime compatibility tests for YamlTaskSource after
 * Bun.file/Bun.write → node:fs migration
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YamlTaskSource } from "../../../../src/tasks/sources/yaml";

const TEST_DIR = join(import.meta.dir, ".test-yaml-compat");
const TEST_FILE = join(TEST_DIR, "tasks.yaml");

const SAMPLE_YAML = `metadata:
  version: "1.0"
  project: "Test Project"

tasks:
  - title: "First task"
    priority: high
    labels: [backend]
  - title: "Second task"
    priority: medium
    labels: [frontend]
  - title: "Completed task"
    completed: true
`;

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFileSync(TEST_FILE, SAMPLE_YAML);
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("YamlTaskSource (node:fs compat)", () => {
	it("load() reads and parses YAML correctly", async () => {
		const source = new YamlTaskSource({ type: "yaml", path: TEST_FILE });
		const collection = await source.load({ includeCompleted: true });
		expect(collection.tasks.length).toBe(3);
		expect(collection.tasks[0].title).toBe("First task");
		expect(collection.tasks[0].priority).toBe("high");
		expect(collection.tasks[2].status).toBe("completed");
	});

	it("updateStatus() writes changes back to file", async () => {
		const source = new YamlTaskSource({ type: "yaml", path: TEST_FILE });
		const collection = await source.load({ includeCompleted: true });
		const pendingTask = collection.tasks[0];

		await source.updateStatus(pendingTask.id, "completed");

		const updatedContent = readFileSync(TEST_FILE, "utf-8");
		expect(updatedContent).toContain("completed: true");
	});

	it("isAvailable() returns true for existing files", async () => {
		const source = new YamlTaskSource({ type: "yaml", path: TEST_FILE });
		expect(await source.isAvailable()).toBe(true);
	});

	it("isAvailable() returns false for missing files", async () => {
		const source = new YamlTaskSource({
			type: "yaml",
			path: join(TEST_DIR, "nonexistent.yaml"),
		});
		expect(await source.isAvailable()).toBe(false);
	});

	it("addTask() adds a new task to the file", async () => {
		const source = new YamlTaskSource({ type: "yaml", path: TEST_FILE });
		const newId = await source.addTask({
			title: "New task",
			priority: "low",
			labels: ["test"],
		});

		expect(newId).toContain("yaml-");
		expect(newId).toContain("new-task");

		const updatedContent = readFileSync(TEST_FILE, "utf-8");
		expect(updatedContent).toContain("New task");
	});

	it("removeTask() removes a task from the file", async () => {
		const source = new YamlTaskSource({ type: "yaml", path: TEST_FILE });
		const collection = await source.load({ includeCompleted: true });
		const firstTask = collection.tasks[0];

		await source.removeTask(firstTask.id);

		const updatedContent = readFileSync(TEST_FILE, "utf-8");
		expect(updatedContent).not.toContain("First task");
		expect(updatedContent).toContain("Second task");
	});
});
