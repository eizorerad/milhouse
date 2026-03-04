/**
 * Cross-runtime compatibility tests for MarkdownTaskSource after
 * Bun.file/Bun.write → node:fs migration
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MarkdownTaskSource } from "../../../../src/tasks/sources/markdown";

const TEST_DIR = join(import.meta.dir, ".test-md-compat");
const TEST_FILE = join(TEST_DIR, "tasks.md");

const SAMPLE_MD = `# Tasks

- [ ] First task @priority(high)
- [ ] Second task @priority(medium)
- [x] Completed task
`;

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFileSync(TEST_FILE, SAMPLE_MD);
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("MarkdownTaskSource (node:fs compat)", () => {
	it("load() reads file content correctly", async () => {
		const source = new MarkdownTaskSource({ type: "markdown", path: TEST_FILE });
		const collection = await source.load({ includeCompleted: true });
		expect(collection.tasks.length).toBe(3);
		expect(collection.tasks[0].title).toContain("First task");
		expect(collection.tasks[0].status).toBe("pending");
		expect(collection.tasks[2].status).toBe("completed");
	});

	it("updateStatus() writes changes back to file", async () => {
		const source = new MarkdownTaskSource({ type: "markdown", path: TEST_FILE });
		const collection = await source.load({ includeCompleted: true });
		const pendingTask = collection.tasks[0];

		await source.updateStatus(pendingTask.id, "completed");

		const updatedContent = readFileSync(TEST_FILE, "utf-8");
		// The first checkbox should now be checked
		expect(updatedContent).toContain("- [x] First task");
	});

	it("isAvailable() returns true for existing files", async () => {
		const source = new MarkdownTaskSource({ type: "markdown", path: TEST_FILE });
		expect(await source.isAvailable()).toBe(true);
	});

	it("isAvailable() returns false for missing files", async () => {
		const source = new MarkdownTaskSource({
			type: "markdown",
			path: join(TEST_DIR, "nonexistent.md"),
		});
		expect(await source.isAvailable()).toBe(false);
	});
});
