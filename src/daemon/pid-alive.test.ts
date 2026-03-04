/**
 * Unit tests for pid-alive module.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { isPidAlive, parseTasklistImageName } from "./pid-alive.ts";

describe("pid-alive", () => {
	describe("parseTasklistImageName", () => {
		test("extracts image name from valid CSV line", () => {
			expect(parseTasklistImageName('"bun.exe","1234","Console","1","12,345 K"')).toBe("bun.exe");
		});

		test("extracts image name with spaces", () => {
			expect(parseTasklistImageName('"Some App.exe","5678","Console","1","8,000 K"')).toBe("Some App.exe");
		});

		test("returns null for empty line", () => {
			expect(parseTasklistImageName("")).toBeNull();
		});

		test("returns null for INFO line", () => {
			expect(parseTasklistImageName("INFO: No tasks are running which match the specified criteria.")).toBeNull();
		});
	});

	describe("current process detection", () => {
		test("current process PID is detected as alive", () => {
			expect(isPidAlive(process.pid)).toBe(true);
		});
	});

	describe("dead process detection", () => {
		test("certainly-dead PID is detected as dead", () => {
			expect(isPidAlive(999999)).toBe(false);
		});
	});

	describe("Windows tasklist verification", () => {
		const originalPlatform = process.platform;

		afterEach(() => {
			Object.defineProperty(process, "platform", { value: originalPlatform });
		});

		test("Windows: returns true when process name matches expected name (bun.exe)", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			childProcess.execSync = () => '"bun.exe","1234","Console","1","12,345 K"\r\n';

			try {
				// Use process.pid since process.kill(pid, 0) must succeed first
				const result = isPidAlive(process.pid);
				expect(result).toBe(true);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});

		test("Windows: returns true when process name matches node.exe", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			childProcess.execSync = () => '"node.exe","1234","Console","1","12,345 K"\r\n';

			try {
				const result = isPidAlive(process.pid);
				expect(result).toBe(true);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});

		test("Windows: returns true when process name contains milhouse", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			childProcess.execSync = () => '"milhouse-daemon.exe","1234","Console","1","12,345 K"\r\n';

			try {
				const result = isPidAlive(process.pid);
				expect(result).toBe(true);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});

		test("Windows: returns false when process name does not match (PID reuse)", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			childProcess.execSync = () => '"chrome.exe","1234","Console","1","12,345 K"\r\n';

			try {
				const result = isPidAlive(process.pid);
				expect(result).toBe(false);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});

		test("Windows: falls back to process.kill result when tasklist fails", () => {
			Object.defineProperty(process, "platform", { value: "win32" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			childProcess.execSync = () => {
				throw new Error("tasklist permission denied");
			};

			try {
				// process.kill(process.pid, 0) succeeds and tasklist fails,
				// so should fall back to true
				const result = isPidAlive(process.pid);
				expect(result).toBe(true);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});

		test("non-win32 platform: does not call execSync", () => {
			Object.defineProperty(process, "platform", { value: "linux" });

			const childProcess = require("node:child_process");
			const originalExecSync = childProcess.execSync;
			let execSyncCalled = false;
			childProcess.execSync = (...args: unknown[]) => {
				execSyncCalled = true;
				return originalExecSync(...args);
			};

			try {
				isPidAlive(process.pid);
				expect(execSyncCalled).toBe(false);
			} finally {
				childProcess.execSync = originalExecSync;
			}
		});
	});
});
