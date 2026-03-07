/**
 * Tests for engine timeout timer cleanup.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execute } from "../src/engine.ts";
import type { Config } from "../src/types.ts";

function makeFakeProc(stdout: string, stderr: string, exitCode: number) {
	const stdoutBlob = new Blob([stdout]);
	const stderrBlob = new Blob([stderr]);
	return {
		stdin: null,
		stdout: stdoutBlob.stream(),
		stderr: stderrBlob.stream(),
		exited: Promise.resolve(exitCode),
		kill: mock(() => {}),
		pid: 12345,
	};
}

const config: Config = { engine: "gemini", model: "test-model" } as Config;

describe("engine timeout cleanup", () => {
	let spawnMock: ReturnType<typeof mock>;
	let clearTimeoutSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		spawnMock?.mockRestore?.();
		clearTimeoutSpy?.mockRestore();
	});

	it("clears timeout when output resolves first", async () => {
		const fakeProc = makeFakeProc("hello world", "", 0);
		spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as never);
		clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

		const result = await execute("test prompt", "/tmp", config, { timeout: 60_000 });

		expect(result.response).toBe("hello world");
		expect(clearTimeoutSpy).toHaveBeenCalled();
		// Timer ID should have been passed to clearTimeout
		const arg = clearTimeoutSpy.mock.calls[0]?.[0];
		expect(arg).toBeDefined();
	});

	it("logs full stderr via debugLog before throwing truncated error", async () => {
		const longStderr = "E".repeat(800);
		const fakeProc = makeFakeProc("", longStderr, 1);
		spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as never);

		const origVerbose = process.env.VERBOSE;
		process.env.VERBOSE = "1";
		const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(
				execute("test prompt", "/tmp", config, { timeout: 60_000 }),
			).rejects.toThrow(/E{500}/);

			// debugLog should have been called with full stderr
			const fullStderrCall = consoleSpy.mock.calls.find(
				(args) => typeof args[0] === "string" && args[0].includes(longStderr),
			);
			expect(fullStderrCall).toBeDefined();
		} finally {
			consoleSpy.mockRestore();
			if (origVerbose === undefined) delete process.env.VERBOSE;
			else process.env.VERBOSE = origVerbose;
		}
	});

	it("kills process and throws on timeout", async () => {
		// Create a proc whose stdout never resolves
		const neverResolve = new ReadableStream({ start() {} });
		const stderrBlob = new Blob([""]);
		const killMock = mock(() => {});
		const fakeProc = {
			stdin: null,
			stdout: neverResolve,
			stderr: stderrBlob.stream(),
			exited: new Promise<number>(() => {}),
			kill: killMock,
			pid: 99999,
		};
		spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as never);
		clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

		await expect(
			execute("test prompt", "/tmp", config, { timeout: 50 }),
		).rejects.toThrow("timed out");

		expect(killMock).toHaveBeenCalled();
		// clearTimeout should still be called in .finally()
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});
