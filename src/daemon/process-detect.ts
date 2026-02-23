/**
 * Cross-platform process detection
 *
 * Detects running milhouse, claude, aider, gemini, etc. processes.
 * Uses `ps aux` on Unix and `tasklist` on Windows.
 * Filters out the daemon's own process to avoid false positives.
 */

import { execSync } from "node:child_process";

export interface DetectedProcess {
	/** Process ID */
	pid: number;
	/** Matched process name */
	matchedName: string;
	/** Full command line (if available) */
	commandLine: string;
}

/**
 * Detect running processes matching any of the given names.
 * Excludes the current process (daemon itself) and any process
 * whose command line contains "--daemon" to avoid self-detection.
 */
export function detectRunningProcesses(
	names: string[],
	excludePid?: number,
): DetectedProcess[] {
	const myPid = excludePid ?? process.pid;

	try {
		if (process.platform === "win32") {
			return detectWindows(names, myPid);
		}
		return detectUnix(names, myPid);
	} catch {
		// If process detection fails, assume nothing is running
		// (safer to proceed than to block forever)
		return [];
	}
}

/**
 * Check if any matching process is currently running.
 */
export function isAnyProcessRunning(
	names: string[],
	excludePid?: number,
): boolean {
	return detectRunningProcesses(names, excludePid).length > 0;
}

/**
 * Wait until no matching processes are running.
 * Polls at the given interval. Returns when clear or when timeout is reached.
 *
 * @returns true if processes cleared, false if timed out
 */
export async function waitForProcesses(
	names: string[],
	options: {
		pollIntervalMs: number;
		timeoutMs: number;
		excludePid?: number;
		onDetected?: (processes: DetectedProcess[]) => void;
		onCleared?: () => void;
		signal?: AbortSignal;
	},
): Promise<boolean> {
	const start = Date.now();

	while (Date.now() - start < options.timeoutMs) {
		if (options.signal?.aborted) return false;

		const running = detectRunningProcesses(names, options.excludePid);

		if (running.length === 0) {
			options.onCleared?.();
			return true;
		}

		options.onDetected?.(running);
		await sleep(options.pollIntervalMs, options.signal);
	}

	return false;
}

// ─── Platform implementations ───────────────────────────────────────────────

function detectWindows(names: string[], excludePid: number): DetectedProcess[] {
	// tasklist /V /FO CSV gives: "Image Name","PID","Session Name",...,"Command Line"
	// /V for verbose (includes command line on some Windows versions)
	const output = execSync("tasklist /FO CSV /NH", {
		encoding: "utf-8",
		timeout: 10_000,
		windowsHide: true,
	});

	const results: DetectedProcess[] = [];

	for (const line of output.split("\n")) {
		if (!line.trim()) continue;

		// Parse CSV: "process.exe","1234","Console","1","12,345 K"
		const parts = line.split('","');
		if (parts.length < 2) continue;

		const processName = parts[0].replace(/^"/, "").toLowerCase();
		const pidStr = parts[1]?.replace(/"/g, "");
		const pid = Number.parseInt(pidStr, 10);

		if (Number.isNaN(pid) || pid === excludePid) continue;

		for (const name of names) {
			if (processName.includes(name.toLowerCase())) {
				results.push({
					pid,
					matchedName: name,
					commandLine: processName,
				});
				break;
			}
		}
	}

	// Additional check with wmic for command line (more reliable)
	try {
		const wmicOutput = execSync(
			"wmic process get ProcessId,CommandLine /FORMAT:CSV",
			{ encoding: "utf-8", timeout: 10_000, windowsHide: true },
		);

		for (const line of wmicOutput.split("\n")) {
			if (!line.trim()) continue;
			const lower = line.toLowerCase();

			// Skip daemon's own process and other daemon instances
			if (lower.includes("--daemon")) continue;

			for (const name of names) {
				if (lower.includes(name.toLowerCase())) {
					// Extract PID from CSV (last field typically)
					const parts = line.split(",");
					const pidStr = parts[parts.length - 1]?.trim();
					const pid = Number.parseInt(pidStr, 10);

					if (!Number.isNaN(pid) && pid !== excludePid) {
						// Avoid duplicates
						if (!results.some((r) => r.pid === pid)) {
							results.push({
								pid,
								matchedName: name,
								commandLine: line.trim(),
							});
						}
					}
					break;
				}
			}
		}
	} catch {
		// wmic may not be available on all Windows versions; tasklist is enough
	}

	return results;
}

function detectUnix(names: string[], excludePid: number): DetectedProcess[] {
	const output = execSync("ps aux", {
		encoding: "utf-8",
		timeout: 10_000,
	});

	const results: DetectedProcess[] = [];

	for (const line of output.split("\n")) {
		if (!line.trim()) continue;

		const lower = line.toLowerCase();

		// Skip daemon's own process
		if (lower.includes("--daemon")) continue;

		// Parse ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
		const parts = line.trim().split(/\s+/);
		if (parts.length < 11) continue;

		const pid = Number.parseInt(parts[1], 10);
		if (Number.isNaN(pid) || pid === excludePid) continue;

		// Command is everything from index 10 onwards
		const commandLine = parts.slice(10).join(" ");

		for (const name of names) {
			if (commandLine.toLowerCase().includes(name.toLowerCase())) {
				results.push({
					pid,
					matchedName: name,
					commandLine,
				});
				break;
			}
		}
	}

	return results;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			resolve();
			return;
		}

		const timer = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
