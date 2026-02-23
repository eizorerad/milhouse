import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { loggers } from "../observability/logger.js";
import { StateLockError } from "./errors.js";
import { withFileLock } from "./file-lock.js";

describe("withFileLock error classification", () => {
	const testDir = join(process.cwd(), ".test-file-lock");
	const testFile = join(testDir, "test.json");
	let lockSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
		writeFileSync(testFile, "[]");
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

	// --- Benign / expected errors: fallback with warning ---

	test("ENOSYS: logs warning and executes operation (expected fallback)", async () => {
		const err = Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
		lockSpy.mockRejectedValueOnce(err);

		const result = await withFileLock(testFile, () => "ok");

		expect(result).toBe("ok");
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("ENOLCK: logs warning and executes operation (benign fallback)", async () => {
		const err = Object.assign(new Error("ENOLCK"), { code: "ENOLCK" });
		lockSpy.mockRejectedValueOnce(err);

		const result = await withFileLock(testFile, () => 42);

		expect(result).toBe(42);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("EROFS: logs warning and executes operation (benign fallback)", async () => {
		const err = Object.assign(new Error("EROFS"), { code: "EROFS" });
		lockSpy.mockRejectedValueOnce(err);

		const result = await withFileLock(testFile, () => "readonly-fs");

		expect(result).toBe("readonly-fs");
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// --- Unexpected / dangerous errors: throw StateLockError ---

	test("EACCES: throws StateLockError, operation is NOT executed", async () => {
		const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
		lockSpy.mockRejectedValueOnce(err);
		let operationCalled = false;

		await expect(
			withFileLock(testFile, () => {
				operationCalled = true;
			}),
		).rejects.toThrow(StateLockError);

		expect(operationCalled).toBe(false);
	});

	test("ENOSPC: throws StateLockError, operation is NOT executed", async () => {
		const err = Object.assign(new Error("no space left"), { code: "ENOSPC" });
		lockSpy.mockRejectedValueOnce(err);
		let operationCalled = false;

		await expect(
			withFileLock(testFile, () => {
				operationCalled = true;
			}),
		).rejects.toThrow(StateLockError);

		expect(operationCalled).toBe(false);
	});

	test("ELOCKED: throws StateLockError (lock contention after retries)", async () => {
		const err = Object.assign(new Error("locked"), { code: "ELOCKED" });
		lockSpy.mockRejectedValueOnce(err);

		await expect(withFileLock(testFile, () => "should not run")).rejects.toThrow(StateLockError);
	});

	test("generic Error with no code: throws StateLockError (unknown errors are unexpected)", async () => {
		lockSpy.mockRejectedValueOnce(new Error("something went wrong"));

		await expect(withFileLock(testFile, () => "should not run")).rejects.toThrow(StateLockError);
	});

	// --- Happy path ---

	test("lock() succeeds: operation runs and lock is released", async () => {
		const releaseFn = mock(() => Promise.resolve());
		lockSpy.mockResolvedValueOnce(releaseFn);

		const result = await withFileLock(testFile, () => "success");

		expect(result).toBe("success");
		expect(releaseFn).toHaveBeenCalledTimes(1);
	});

	test("operation throws while lock is held: lock is still released, error propagates", async () => {
		const releaseFn = mock(() => Promise.resolve());
		lockSpy.mockResolvedValueOnce(releaseFn);

		await expect(
			withFileLock(testFile, () => {
				throw new Error("operation failed");
			}),
		).rejects.toThrow("operation failed");

		expect(releaseFn).toHaveBeenCalledTimes(1);
	});
});
