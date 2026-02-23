/**
 * Watchdog process monitor
 *
 * Spawns milhouse as a child process and monitors it:
 *   - Tracks stdout activity (last output timestamp)
 *   - Kills process if no activity for activityTimeout minutes
 *   - Kills process if total run time exceeds runTimeout minutes
 *   - Captures stdout/stderr for logging
 */

import type { Subprocess } from "bun";
import type { DaemonWatchdogConfig, WatchdogResult } from "./types.ts";

const WATCHDOG_CHECK_INTERVAL_MS = 15_000; // check every 15 seconds

/**
 * Spawn milhouse with the given CLI args and monitor via watchdog.
 *
 * The watchdog reads stdout in real-time. If milhouse stops producing output
 * for longer than activityTimeout, or if total wall time exceeds runTimeout,
 * the process is killed.
 *
 * @param args - CLI arguments for milhouse (e.g., ["--run", "--scope", "..."])
 * @param config - Watchdog configuration
 * @param options - Additional options
 * @returns WatchdogResult with exit code, captured output, and kill info
 */
export async function spawnWithWatchdog(
	args: string[],
	config: DaemonWatchdogConfig,
	options: {
		workDir: string;
		/** Path to bun executable (defaults to process.argv[0]) */
		bunPath?: string;
		/** Path to milhouse entry point */
		entryPoint?: string;
		/** Abort signal to cancel externally */
		signal?: AbortSignal;
		/** Callback when stdout activity detected */
		onActivity?: (chunk: string) => void;
	},
): Promise<WatchdogResult> {
	const bunPath = options.bunPath ?? process.argv[0];
	const entryPoint = options.entryPoint ?? "src/index.ts";

	const startedAt = Date.now();
	let lastActivityAt = Date.now();
	let killedByWatchdog = false;
	let killReason: "activity-timeout" | "run-timeout" | undefined;

	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	// Spawn milhouse as child process
	const proc = Bun.spawn([bunPath, "run", entryPoint, ...args], {
		cwd: options.workDir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			// Signal to milhouse that it's running under daemon
			MILHOUSE_DAEMON: "1",
		},
	});

	// Read stdout asynchronously — track activity
	const readStdout = (async () => {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				lastActivityAt = Date.now();
				stdoutChunks.push(text);
				options.onActivity?.(text);
			}
		} catch {
			// Stream closed
		}
	})();

	// Read stderr asynchronously
	const readStderr = (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrChunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Stream closed
		}
	})();

	// Track the SIGKILL escalation timer so it can be cleared if the process exits
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

	// Watchdog check loop
	const watchdogInterval = setInterval(() => {
		// Already exited?
		if (proc.exitCode !== null) {
			clearInterval(watchdogInterval);
			return;
		}

		// External abort?
		if (options.signal?.aborted) {
			sigkillTimer = killProcess(proc, "external abort");
			clearInterval(watchdogInterval);
			killedByWatchdog = true;
			killReason = "activity-timeout";
			return;
		}

		const now = Date.now();
		const silentMinutes = (now - lastActivityAt) / 60_000;
		const totalMinutes = (now - startedAt) / 60_000;

		// Activity timeout: no stdout for too long
		if (config.activityTimeout > 0 && silentMinutes > config.activityTimeout) {
			sigkillTimer = killProcess(proc, `no output for ${Math.round(silentMinutes)} minutes`);
			clearInterval(watchdogInterval);
			killedByWatchdog = true;
			killReason = "activity-timeout";
			return;
		}

		// Total run timeout
		if (config.runTimeout > 0 && totalMinutes > config.runTimeout) {
			sigkillTimer = killProcess(proc, `total run time exceeded ${config.runTimeout} minutes`);
			clearInterval(watchdogInterval);
			killedByWatchdog = true;
			killReason = "run-timeout";
			return;
		}
	}, WATCHDOG_CHECK_INTERVAL_MS);

	// Wait for process to exit
	const exitCode = await proc.exited;
	clearInterval(watchdogInterval);
	if (sigkillTimer) {
		clearTimeout(sigkillTimer);
		sigkillTimer = undefined;
	}

	// Wait for streams to finish reading
	await Promise.all([readStdout, readStderr]);

	return {
		exitCode,
		stdout: stdoutChunks.join(""),
		stderr: stderrChunks.join(""),
		duration: Date.now() - startedAt,
		killedByWatchdog,
		killReason,
	};
}

function killProcess(proc: Subprocess, reason: string): ReturnType<typeof setTimeout> | undefined {
	try {
		proc.kill("SIGTERM");
		// Give it 10 seconds to clean up, then force kill
		return setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already dead
			}
		}, 10_000);
	} catch {
		// Already dead
		return undefined;
	}
}
