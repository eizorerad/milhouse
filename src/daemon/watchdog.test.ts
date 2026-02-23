/**
 * Tests for killProcess SIGKILL timer leak in watchdog.ts
 *
 * Verifies that:
 * 1. When a process exits quickly after SIGTERM, the SIGKILL timer is cancelled
 * 2. When a process ignores SIGTERM, SIGKILL is still sent after 10s
 * 3. No SIGKILL timer remains after spawnWithWatchdog resolves
 *
 * Strategy:
 * - Patch Bun.spawn on the global to return mock Subprocess objects
 * - Intercept setTimeout/clearTimeout to control and observe timer behavior
 * - Use AbortSignal to trigger killProcess without waiting for real timeouts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnWithWatchdog } from "./watchdog.ts";

// ─── Test helpers ──────────────────────────────────────────────────────

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Creates a mock ReadableStream that blocks on read() until close() is called. */
function createMockStream() {
	let onClose: (() => void) | null = null;
	let closed = false;
	return {
		getReader: () => ({
			read: () => {
				if (closed) return Promise.resolve({ done: true as const, value: undefined });
				return new Promise<{ done: true; value: undefined }>((resolve) => {
					onClose = () => resolve({ done: true, value: undefined });
				});
			},
		}),
		close() {
			closed = true;
			onClose?.();
		},
	};
}

/** Creates a mock Subprocess with controllable exit and trackable kill calls. */
function createMockProc() {
	const exitDeferred = deferred<number>();
	const killCalls: string[] = [];
	const stdout = createMockStream();
	const stderr = createMockStream();

	const proc = {
		exitCode: null as number | null,
		exited: exitDeferred.promise,
		kill(signal?: number | string) {
			killCalls.push(String(signal ?? "SIGTERM"));
		},
		stdout,
		stderr,
		pid: 99999,
	};

	return {
		proc,
		killCalls,
		resolveExit(code: number) {
			proc.exitCode = code;
			stdout.close();
			stderr.close();
			exitDeferred.resolve(code);
		},
	};
}

// ─── Timer interception ──────────────────────────────────────────────

let intervalCallback: (() => void) | null;
let timeoutCallbacks: Map<number, () => void>;
let clearedTimeouts: Set<number>;
let handleCounter: number;

const origSetInterval = globalThis.setInterval;
const origSetTimeout = globalThis.setTimeout;
const origClearInterval = globalThis.clearInterval;
const origClearTimeout = globalThis.clearTimeout;
const origBunSpawn = Bun.spawn;

function installInterceptors(mockProc: ReturnType<typeof createMockProc>) {
	intervalCallback = null;
	timeoutCallbacks = new Map();
	clearedTimeouts = new Set();
	handleCounter = 1;

	(Bun as any).spawn = () => mockProc.proc;

	globalThis.setInterval = ((fn: Function, _ms?: number) => {
		intervalCallback = fn as () => void;
		return handleCounter++ as unknown as ReturnType<typeof setInterval>;
	}) as unknown as typeof setInterval;

	globalThis.setTimeout = ((fn: Function, _ms?: number) => {
		const handle = handleCounter++;
		timeoutCallbacks.set(handle, fn as () => void);
		return handle as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	globalThis.clearInterval = ((_handle: unknown) => {
		// no-op: we don't need the interval to re-fire
	}) as unknown as typeof clearInterval;

	globalThis.clearTimeout = ((handle: unknown) => {
		const h = handle as number;
		clearedTimeouts.add(h);
		timeoutCallbacks.delete(h);
	}) as unknown as typeof clearTimeout;
}

function restoreInterceptors() {
	(Bun as any).spawn = origBunSpawn;
	globalThis.setInterval = origSetInterval;
	globalThis.setTimeout = origSetTimeout;
	globalThis.clearInterval = origClearInterval;
	globalThis.clearTimeout = origClearTimeout;
}

// ─── Test suite ───────────────────────────────────────────────────────

const defaultConfig = {
	activityTimeout: 30,
	runTimeout: 180,
	onTimeout: "kill-and-retry" as const,
};

describe("killProcess SIGKILL timer", () => {
	let mockProc: ReturnType<typeof createMockProc>;

	beforeEach(() => {
		mockProc = createMockProc();
		installInterceptors(mockProc);
	});

	afterEach(() => {
		restoreInterceptors();
	});

	test("cancels SIGKILL timer when process exits quickly after SIGTERM", async () => {
		// Use a pre-aborted signal to trigger killProcess via the abort path
		const controller = new AbortController();
		controller.abort();

		const resultPromise = spawnWithWatchdog(["--test"], defaultConfig, {
			workDir: "/tmp",
			signal: controller.signal,
		});

		// Manually fire the watchdog interval callback (simulates the 15s tick)
		expect(intervalCallback).not.toBeNull();
		intervalCallback!();

		// killProcess should have sent SIGTERM and scheduled a SIGKILL via setTimeout
		expect(mockProc.killCalls).toContain("SIGTERM");
		expect(timeoutCallbacks.size).toBe(1);

		const sigkillHandle = [...timeoutCallbacks.keys()][0];

		// Process exits quickly after SIGTERM (before the 10s SIGKILL fires)
		mockProc.resolveExit(0);
		await resultPromise;

		// After fix: the SIGKILL timer should have been cleared
		// Before fix: the timer leaks → would fire SIGKILL on a potentially recycled PID
		expect(clearedTimeouts.has(sigkillHandle)).toBe(true);

		// SIGKILL should NOT have been sent
		expect(mockProc.killCalls).not.toContain("SIGKILL");
	});

	test("sends SIGKILL when process does not exit after SIGTERM", async () => {
		const controller = new AbortController();
		controller.abort();

		const resultPromise = spawnWithWatchdog(["--test"], defaultConfig, {
			workDir: "/tmp",
			signal: controller.signal,
		});

		// Fire the watchdog interval → triggers abort path → killProcess
		intervalCallback!();
		expect(mockProc.killCalls).toContain("SIGTERM");

		// Process does NOT exit. Manually fire the SIGKILL timeout callback.
		expect(timeoutCallbacks.size).toBe(1);
		const sigkillCallback = [...timeoutCallbacks.values()][0];
		sigkillCallback();

		// SIGKILL SHOULD have been sent since the process didn't exit
		expect(mockProc.killCalls).toContain("SIGKILL");

		// Clean up: let the process exit so spawnWithWatchdog resolves
		mockProc.resolveExit(137);
		await resultPromise;
	});

	test("clearTimeout is called on SIGKILL timer handle after process exits", async () => {
		const controller = new AbortController();
		controller.abort();

		const resultPromise = spawnWithWatchdog(["--test"], defaultConfig, {
			workDir: "/tmp",
			signal: controller.signal,
		});

		// Fire the watchdog → killProcess schedules SIGKILL timer
		intervalCallback!();
		expect(timeoutCallbacks.size).toBe(1);
		const sigkillHandle = [...timeoutCallbacks.keys()][0];

		// Process exits
		mockProc.resolveExit(0);
		await resultPromise;

		// After fix: clearTimeout should have been called with the SIGKILL timer handle
		// Before fix: clearTimeout is never called → the timer leaks
		expect(clearedTimeouts.has(sigkillHandle)).toBe(true);
	});
});
