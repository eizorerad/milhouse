import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { loggers } from "../observability/logger.js";
import { StateLockError } from "./errors.js";
import {
	createExecution,
	createExecutionSafe,
	deleteExecution,
	deleteExecutionSafe,
	loadExecutions,
	updateExecution,
	updateExecutionSafe,
	withExecutionsLock,
} from "./executions.js";
import type { ExecutionRecord } from "./types.js";

describe("executions locking", () => {
	const testDir = join(process.cwd(), ".test-executions-lock");
	// Legacy fallback path (no active run): .milhouse/state/executions.json
	const stateDir = join(testDir, ".milhouse", "state");
	const executionsFile = join(stateDir, "executions.json");
	let lockSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(executionsFile, "[]");
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

	// --- withExecutionsLock ---

	describe("withExecutionsLock", () => {
		test("acquires file lock on the executions.json path", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await withExecutionsLock(testDir, () => "locked-result");

			expect(result).toBe("locked-result");
			expect(lockSpy).toHaveBeenCalledTimes(1);
			// Verify lock was acquired on executions.json path
			const lockPath = lockSpy.mock.calls[0][0];
			expect(lockPath).toContain("executions.json");
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("releases lock and propagates error if operation throws", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			await expect(
				withExecutionsLock(testDir, () => {
					throw new Error("operation failed");
				}),
			).rejects.toThrow("operation failed");

			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("throws StateLockError on lock acquisition failure", async () => {
			const err = Object.assign(new Error("locked"), { code: "ELOCKED" });
			lockSpy.mockRejectedValueOnce(err);

			await expect(withExecutionsLock(testDir, () => "should not run")).rejects.toThrow(
				StateLockError,
			);
		});

		test("concurrent calls both acquire the file lock", async () => {
			const release1 = mock(() => Promise.resolve());
			const release2 = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(release1).mockResolvedValueOnce(release2);

			const r1 = await withExecutionsLock(testDir, () => "first");
			const r2 = await withExecutionsLock(testDir, () => "second");

			expect(r1).toBe("first");
			expect(r2).toBe("second");
			expect(lockSpy).toHaveBeenCalledTimes(2);
			expect(release1).toHaveBeenCalledTimes(1);
			expect(release2).toHaveBeenCalledTimes(1);
		});
	});

	// --- *Safe delegation tests ---

	describe("createExecutionSafe", () => {
		test("delegates to createExecution and returns the result", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const execution = await createExecutionSafe(
				{
					task_id: "T1",
					started_at: new Date().toISOString(),
					agent_role: "EX",
					input_tokens: 0,
					output_tokens: 0,
					follow_up_task_ids: [],
				},
				testDir,
			);

			expect(execution.task_id).toBe("T1");
			expect(execution.agent_role).toBe("EX");
			expect(execution.id).toBeDefined();
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("lock is released even when operation throws", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			// Force an error by making the underlying save fail
			// We'll test this by using withExecutionsLock directly with a throwing operation
			await expect(
				withExecutionsLock(testDir, () => {
					throw new Error("save failed");
				}),
			).rejects.toThrow("save failed");

			expect(releaseFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("updateExecutionSafe", () => {
		test("delegates to updateExecution and returns updated record", async () => {
			// Seed with an execution
			const created = createExecution(
				{
					task_id: "T1",
					started_at: new Date().toISOString(),
					agent_role: "EX",
					input_tokens: 0,
					output_tokens: 0,
					follow_up_task_ids: [],
				},
				testDir,
			);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const updated = await updateExecutionSafe(
				created.id,
				{ success: true, completed_at: new Date().toISOString() },
				testDir,
			);

			expect(updated).not.toBeNull();
			expect(updated?.success).toBe(true);
			expect(updated?.completed_at).toBeDefined();
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("returns null for non-existent execution", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await updateExecutionSafe("nonexistent", { success: true }, testDir);

			expect(result).toBeNull();
		});
	});

	describe("deleteExecutionSafe", () => {
		test("delegates to deleteExecution and returns true on success", async () => {
			const created = createExecution(
				{
					task_id: "T1",
					started_at: new Date().toISOString(),
					agent_role: "EX",
					input_tokens: 0,
					output_tokens: 0,
					follow_up_task_ids: [],
				},
				testDir,
			);

			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await deleteExecutionSafe(created.id, testDir);

			expect(result).toBe(true);
			expect(loadExecutions(testDir)).toEqual([]);
			expect(releaseFn).toHaveBeenCalledTimes(1);
		});

		test("returns false for non-existent execution", async () => {
			const releaseFn = mock(() => Promise.resolve());
			lockSpy.mockResolvedValueOnce(releaseFn);

			const result = await deleteExecutionSafe("nonexistent", testDir);

			expect(result).toBe(false);
		});
	});
});
