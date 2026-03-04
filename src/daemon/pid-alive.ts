/**
 * Windows-safe PID liveness check.
 *
 * On Unix/macOS: uses process.kill(pid, 0) (signal 0 probe).
 * On Windows: after the signal-0 probe succeeds, verifies via tasklist
 * that the process image name matches an expected milhouse-related name
 * (bun.exe, node.exe, or any name containing "milhouse"). This guards
 * against Windows' aggressive PID reuse.
 */

const EXPECTED_NAMES = ["bun.exe", "node.exe"];

function isExpectedProcessName(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower.includes("milhouse")) return true;
	return EXPECTED_NAMES.some((n) => lower === n);
}

/**
 * Parse a tasklist CSV row and extract the image name.
 * tasklist /FO CSV /NH outputs lines like: "bun.exe","1234","Console","1","12,345 K"
 */
export function parseTasklistImageName(csvLine: string): string | null {
	const match = csvLine.match(/^"([^"]+)"/);
	return match ? match[1] : null;
}

/**
 * Check whether a process with the given PID is alive.
 *
 * On Windows, also verifies the process name matches expectations to
 * avoid false positives from PID reuse.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}

	// On non-Windows, the signal-0 probe is sufficient
	if (process.platform !== "win32") {
		return true;
	}

	// Windows: verify the process name via tasklist
	try {
		// Dynamic property access so tests can mock execSync on the module object
		const output = (require("node:child_process") as typeof import("node:child_process"))
			.execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});

		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("INFO:")) continue;

			const imageName = parseTasklistImageName(trimmed);
			if (imageName && isExpectedProcessName(imageName)) {
				return true;
			}
		}

		// tasklist succeeded but process name didn't match — PID was reused
		return false;
	} catch {
		// tasklist failed (e.g., permission error) — fall back to process.kill result
		return true;
	}
}
