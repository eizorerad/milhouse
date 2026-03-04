/**
 * Unit tests for detectTaskSource() after Bun.file → existsSync migration
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectTaskSource } from "../../../src/tasks/runtime/factory";

const TEST_DIR = join(import.meta.dir, ".test-factory-detect");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectTaskSource", () => {
	it("returns markdown config when PRD.md exists", async () => {
		writeFileSync(join(TEST_DIR, "PRD.md"), "# PRD\n- [ ] Task 1");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("markdown");
		expect(result!.path).toBe(`${TEST_DIR}/PRD.md`);
	});

	it("returns markdown config when tasks.md exists", async () => {
		writeFileSync(join(TEST_DIR, "tasks.md"), "- [ ] Task 1");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("markdown");
		expect(result!.path).toBe(`${TEST_DIR}/tasks.md`);
	});

	it("returns yaml config when tasks.yaml exists", async () => {
		writeFileSync(join(TEST_DIR, "tasks.yaml"), "tasks:\n  - title: Test");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("yaml");
		expect(result!.path).toBe(`${TEST_DIR}/tasks.yaml`);
	});

	it("returns yaml config when tasks.yml exists", async () => {
		writeFileSync(join(TEST_DIR, "tasks.yml"), "tasks:\n  - title: Test");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("yaml");
		expect(result!.path).toBe(`${TEST_DIR}/tasks.yml`);
	});

	it("returns yaml config when .milhouse/tasks.yaml exists", async () => {
		mkdirSync(join(TEST_DIR, ".milhouse"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".milhouse", "tasks.yaml"), "tasks:\n  - title: Test");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("yaml");
		expect(result!.path).toBe(`${TEST_DIR}/.milhouse/tasks.yaml`);
	});

	it("returns markdown-folder config when docs/ directory exists", async () => {
		mkdirSync(join(TEST_DIR, "docs"), { recursive: true });
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("markdown-folder");
		expect(result!.path).toBe(`${TEST_DIR}/docs`);
	});

	it("returns null when no task files exist", async () => {
		const result = await detectTaskSource(TEST_DIR);
		expect(result).toBeNull();
	});

	it("prefers PRD.md over tasks.md (checked first)", async () => {
		writeFileSync(join(TEST_DIR, "PRD.md"), "# PRD");
		writeFileSync(join(TEST_DIR, "tasks.md"), "# Tasks");
		const result = await detectTaskSource(TEST_DIR);
		expect(result).not.toBeNull();
		expect(result!.path).toBe(`${TEST_DIR}/PRD.md`);
	});
});
