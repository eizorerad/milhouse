import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, RunStore } from "./runs.ts";

describe("RunStore.byId validation", () => {
	const testDir = join(process.cwd(), ".test-runstore");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("byId() throws error with correct message format when run directory doesn't exist", () => {
		const nonExistentRunId = "run-20260305-test-abcd";

		expect(() => {
			RunStore.byId(testDir, nonExistentRunId);
		}).toThrow(`Run ${nonExistentRunId} not found in ${testDir}`);
	});

	test("byId() successfully creates RunStore instance when run directory exists", async () => {
		// Create a run to ensure the directory exists
		const run = await createRun({ workDir: testDir, scope: "test scope" });

		// Should not throw
		const store = RunStore.byId(testDir, run.id);

		expect(store).toBeDefined();
		expect(store.runId).toBe(run.id);
		expect(store.workDir).toBe(testDir);
	});

	test("error message includes both runId and workDir parameters", () => {
		const testRunId = "run-20260305-missing-xyz";
		const testWorkDir = "/custom/work/dir";

		try {
			RunStore.byId(testWorkDir, testRunId);
			expect.unreachable("Should have thrown an error");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain(testRunId);
			expect(message).toContain(testWorkDir);
		}
	});

	test("RunStore provides access to run metadata", async () => {
		const run = await createRun({
			workDir: testDir,
			scope: "test metadata access",
			name: "Test Run"
		});

		const store = RunStore.byId(testDir, run.id);
		const meta = store.getMeta();

		expect(meta).not.toBeNull();
		expect(meta?.id).toBe(run.id);
		expect(meta?.scope).toBe("test metadata access");
		expect(meta?.name).toBe("Test Run");
	});

	test("RunStore provides access to run directories", async () => {
		const run = await createRun({ workDir: testDir, scope: "test dirs" });

		const store = RunStore.byId(testDir, run.id);
		const runDir = store.getRunDir();
		const stateDir = store.getStateDir();

		expect(existsSync(runDir)).toBe(true);
		expect(existsSync(stateDir)).toBe(true);
		expect(runDir).toContain(run.id);
		expect(stateDir).toContain(run.id);
		expect(stateDir).toContain("state");
	});
});
