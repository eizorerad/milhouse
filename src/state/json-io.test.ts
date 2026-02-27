/**
 * Unit tests for saveJsonFile atomic write and fallback behavior.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { StateWriteError } from "./errors.ts";
import { saveJsonFile } from "./json-io.ts";

describe("saveJsonFile", () => {
	const testDir = join(process.cwd(), ".test-json-io");

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

	describe("atomic write", () => {
		test("atomic write succeeds via tmp+rename with no .tmp left behind", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "value" };

			saveJsonFile(filePath, data);

			// File should exist with correct content
			expect(existsSync(filePath)).toBe(true);
			const content = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(content).toEqual(data);

			// .tmp file should not exist after successful rename
			expect(existsSync(`${filePath}.tmp`)).toBe(false);
		});

		test("logs warning when renameSync fails (EPERM)", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "value" };

			const warnSpy = spyOn(console, "warn");

			// Mock renameSync to throw EPERM (simulating Windows file lock)
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
				const err = new Error("EPERM: operation not permitted");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			});

			try {
				saveJsonFile(filePath, data);
			} catch {
				// expected to throw after retries exhausted
			}

			// Should have logged a warning via logStateError at 'warn' level
			expect(warnSpy).toHaveBeenCalled();
			expect(warnSpy.mock.calls[0][0]).toContain("[STATE WARN]");

			renameSpy.mockRestore();
			warnSpy.mockRestore();
		});

		test("cleans up .tmp file when renameSync fails before throwing", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "value" };

			// Mock renameSync to throw EPERM (simulating Windows file lock)
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
				const err = new Error("EPERM: operation not permitted");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			});

			const warnSpy = spyOn(console, "warn");

			try {
				saveJsonFile(filePath, data);
			} catch {
				// expected to throw
			}

			// .tmp file should be cleaned up, not orphaned
			expect(existsSync(`${filePath}.tmp`)).toBe(false);

			renameSpy.mockRestore();
			warnSpy.mockRestore();
		});

		test("throws StateWriteError when renameSync fails after all retries", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "fallback-value" };

			// Mock renameSync to throw EPERM (simulating Windows file lock)
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
				const err = new Error("EPERM: operation not permitted");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			});

			const warnSpy = spyOn(console, "warn");

			try {
				expect(() => saveJsonFile(filePath, data)).toThrow(StateWriteError);
			} finally {
				renameSpy.mockRestore();
				warnSpy.mockRestore();
			}
		});

		test("thrown error contains original rename error as cause", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "cause-value" };

			const originalError = new Error("EPERM: operation not permitted");
			(originalError as NodeJS.ErrnoException).code = "EPERM";

			// Mock renameSync to throw EPERM
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
				throw originalError;
			});

			const warnSpy = spyOn(console, "warn");

			try {
				let caughtError: unknown;
				try {
					saveJsonFile(filePath, data);
				} catch (error) {
					caughtError = error;
				}

				expect(caughtError).toBeInstanceOf(StateWriteError);
				expect((caughtError as StateWriteError).cause).toBe(originalError);
			} finally {
				renameSpy.mockRestore();
				warnSpy.mockRestore();
			}
		});
	});

	describe("retry logic", () => {
		test("retry succeeds after transient rename failure", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "retry-value" };

			let callCount = 0;
			const originalRename = fs.renameSync;

			// Mock renameSync to fail twice then succeed on third attempt
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(
				(...args: Parameters<typeof fs.renameSync>) => {
					callCount++;
					if (callCount <= 2) {
						const err = new Error("EPERM: operation not permitted");
						(err as NodeJS.ErrnoException).code = "EPERM";
						throw err;
					}
					return originalRename(...args);
				},
			);

			const warnSpy = spyOn(console, "warn");

			saveJsonFile(filePath, data);

			// Rename should have been called 3 times (2 failures + 1 success)
			expect(renameSpy).toHaveBeenCalledTimes(3);

			// File should exist with correct content (via successful rename)
			expect(existsSync(filePath)).toBe(true);
			const content = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(content).toEqual(data);

			// No warning should be logged since retry succeeded
			expect(warnSpy).not.toHaveBeenCalled();

			// .tmp file should not exist
			expect(existsSync(`${filePath}.tmp`)).toBe(false);

			renameSpy.mockRestore();
			warnSpy.mockRestore();
		});

		test("all retries exhausted throws StateWriteError", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "exhausted-value" };

			// Mock renameSync to always fail
			const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
				const err = new Error("EPERM: operation not permitted");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			});

			const warnSpy = spyOn(console, "warn");

			try {
				expect(() => saveJsonFile(filePath, data)).toThrow(StateWriteError);

				// Rename should have been called 3 times (all retries)
				expect(renameSpy).toHaveBeenCalledTimes(3);

				// Warning should be logged after all retries exhausted
				expect(warnSpy).toHaveBeenCalled();
				expect(warnSpy.mock.calls[0][0]).toContain("[STATE WARN]");

				// File should NOT be written (no fallback)
				expect(existsSync(filePath)).toBe(false);
			} finally {
				renameSpy.mockRestore();
				warnSpy.mockRestore();
			}
		});
	});

	describe("non-atomic write", () => {
		test("when atomic=false, no tmp file is created at all", () => {
			const filePath = join(testDir, "test.json");
			const data = { key: "direct" };

			// Spy on renameSync to verify it's never called
			const renameSpy = spyOn(fs, "renameSync");

			saveJsonFile(filePath, data, false);

			// File should exist with correct content
			expect(existsSync(filePath)).toBe(true);
			const content = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(content).toEqual(data);

			// renameSync should not have been called (no atomic path)
			expect(renameSpy).not.toHaveBeenCalled();

			// .tmp file should not exist
			expect(existsSync(`${filePath}.tmp`)).toBe(false);

			renameSpy.mockRestore();
		});

		test("non-atomic direct write works correctly", () => {
			const filePath = join(testDir, "test-direct.json");
			const data = { mode: "direct" };

			saveJsonFile(filePath, data, false);

			expect(existsSync(filePath)).toBe(true);
			const content = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(content).toEqual(data);
		});
	});
});
