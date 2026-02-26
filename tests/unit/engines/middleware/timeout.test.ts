import { describe, expect, it } from "bun:test";
import type { ExecutionResult } from "../../../../src/schemas/engine.schema";
import {
	TimeoutError,
	createTimeoutMiddleware,
	createTimeoutWithCleanup,
} from "../../../../src/engines/middleware/timeout";

/** Helper to build a minimal valid ExecutionRequest for testing. */
function makeRequest(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "test",
		workDir: "/tmp",
		timeout: 4000000,
		maxRetries: 3,
		streamOutput: true,
		...overrides,
	};
}

/** Helper to build a minimal valid ExecutionResult. */
function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
	return {
		success: true,
		output: "ok",
		steps: [],
		duration: 10,
		...overrides,
	};
}

describe("createTimeoutMiddleware", () => {
	describe("signal propagation", () => {
		it("sets request.abortSignal to an AbortSignal when useAbortController is true (default)", async () => {
			const middleware = createTimeoutMiddleware({ defaultTimeout: 5000 });
			const request = makeRequest() as any;
			let capturedSignal: unknown = undefined;

			await middleware(request, async () => {
				capturedSignal = request.abortSignal;
				return makeResult();
			});

			expect(capturedSignal).toBeInstanceOf(AbortSignal);
		});

		it("does not set request.abortSignal when useAbortController is false", async () => {
			const middleware = createTimeoutMiddleware({
				defaultTimeout: 5000,
				useAbortController: false,
			});
			const request = makeRequest() as any;
			let capturedSignal: unknown = "UNSET";

			await middleware(request, async () => {
				capturedSignal = request.abortSignal;
				return makeResult();
			});

			expect(capturedSignal).toBeUndefined();
		});
	});

	describe("abort behavior", () => {
		it("aborts the signal when timeout fires", async () => {
			const middleware = createTimeoutMiddleware({ defaultTimeout: 50 });
			const request = makeRequest({ timeout: 50 }) as any;
			let capturedSignal: AbortSignal | undefined;

			try {
				await middleware(request, async () => {
					capturedSignal = request.abortSignal as AbortSignal;
					// Simulate slow execution that exceeds timeout
					await new Promise((resolve) => setTimeout(resolve, 200));
					return makeResult();
				});
			} catch (error) {
				expect(error).toBeInstanceOf(TimeoutError);
			}

			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			expect(capturedSignal!.aborted).toBe(true);
		});

		it("does not abort the signal when execution completes before timeout", async () => {
			const middleware = createTimeoutMiddleware({ defaultTimeout: 5000 });
			const request = makeRequest({ timeout: 5000 }) as any;
			let capturedSignal: AbortSignal | undefined;

			await middleware(request, async () => {
				capturedSignal = request.abortSignal as AbortSignal;
				return makeResult();
			});

			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			expect(capturedSignal!.aborted).toBe(false);
		});
	});

	describe("timeout rejection", () => {
		it("rejects with TimeoutError when execution exceeds timeout", async () => {
			const middleware = createTimeoutMiddleware({ defaultTimeout: 50 });
			const request = makeRequest({ timeout: 50 }) as any;

			await expect(
				middleware(request, async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return makeResult();
				}),
			).rejects.toBeInstanceOf(TimeoutError);
		});

		it("calls onTimeout callback when timeout fires", async () => {
			let callbackTimeout: number | undefined;
			let callbackTaskId: string | undefined;

			const middleware = createTimeoutMiddleware({
				defaultTimeout: 50,
				onTimeout: (timeout, taskId) => {
					callbackTimeout = timeout;
					callbackTaskId = taskId;
				},
			});
			const request = makeRequest({ timeout: 50, taskId: "test-task" }) as any;

			try {
				await middleware(request, async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return makeResult();
				});
			} catch {
				// expected
			}

			expect(callbackTimeout).toBe(50);
			expect(callbackTaskId).toBe("test-task");
		});
	});
});

describe("executor process kill on abort", () => {
	it("kills a long-running process when abort signal fires", async () => {
		// Use a platform-appropriate long-running command
		const isWindows = process.platform === "win32";
		const spawnArgs = isWindows
			? ["cmd.exe", "/c", "ping -n 60 127.0.0.1"]
			: ["sleep", "60"];

		const abortController = new AbortController();
		const proc = Bun.spawn(spawnArgs, {
			stdout: "pipe",
			stderr: "pipe",
		});

		// Set up abort-based kill (mirrors executor logic)
		let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// already dead
			}
			forceKillTimer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, 5000);
		};

		abortController.signal.addEventListener("abort", onAbort, { once: true });

		// Fire abort after a short delay
		setTimeout(() => abortController.abort(), 100);

		// Wait for the process to exit
		const exitCode = await proc.exited;

		// Clean up
		if (forceKillTimer) clearTimeout(forceKillTimer);

		// On Unix, SIGTERM produces a non-zero exit code (usually 143 = 128 + 15).
		// On Windows, killed processes return 1.
		expect(exitCode).not.toBe(0);
	});

	it("does not kill the process when it completes before abort", async () => {
		const isWindows = process.platform === "win32";
		const spawnArgs = isWindows
			? ["cmd.exe", "/c", "echo hello"]
			: ["echo", "hello"];

		const abortController = new AbortController();
		const proc = Bun.spawn(spawnArgs, {
			stdout: "pipe",
			stderr: "pipe",
		});

		let killCalled = false;
		const originalKill = proc.kill.bind(proc);
		proc.kill = ((signal?: string) => {
			killCalled = true;
			return originalKill(signal);
		}) as typeof proc.kill;

		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// already dead
			}
		};

		abortController.signal.addEventListener("abort", onAbort, { once: true });

		// Wait for normal completion
		const exitCode = await proc.exited;

		// Clean up listener since signal was never aborted
		abortController.signal.removeEventListener("abort", onAbort);

		expect(exitCode).toBe(0);
		expect(killCalled).toBe(false);
	});
});

describe("createTimeoutWithCleanup", () => {
	it("calls cleanup callback when timeout fires", async () => {
		let cleanupCalled = false;

		const { promise } = createTimeoutWithCleanup(50, () => {
			cleanupCalled = true;
		});

		try {
			await promise;
		} catch (error) {
			expect(error).toBeInstanceOf(TimeoutError);
		}

		expect(cleanupCalled).toBe(true);
	});

	it("cancel() prevents the timeout from firing", async () => {
		let cleanupCalled = false;

		const { promise, cancel } = createTimeoutWithCleanup(50, () => {
			cleanupCalled = true;
		});

		// Cancel before timeout fires
		cancel();

		// Wait long enough for the timeout to have fired if not cancelled
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(cleanupCalled).toBe(false);

		// The promise should never resolve/reject, but we need to verify cancel
		// didn't throw. We can't meaningfully await the promise since it will
		// never settle after cancel.
	});

	it("handles async cleanup that throws", async () => {
		const { promise } = createTimeoutWithCleanup(50, () => {
			throw new Error("cleanup failed");
		});

		// Should still reject with TimeoutError despite cleanup throwing
		try {
			await promise;
		} catch (error) {
			expect(error).toBeInstanceOf(TimeoutError);
		}
	});
});
