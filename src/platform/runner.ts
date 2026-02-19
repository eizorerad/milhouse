/**
 * @fileoverview Platform Runner
 *
 * Handles execution of the Milhouse CLI, either via compiled binary
 * or development mode with bun/tsx.
 *
 * @module platform/runner
 * @since 4.4.0
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { RunnerOptions, RunnerResult, RuntimeCache, RuntimeEnvironment } from "./types.ts";

/**
 * Cache for runtime availability checks
 * Avoids repeated `which`/`where` calls during a single CLI session
 */
const runtimeCache: RuntimeCache = {
	available: new Map(),
	lastChecked: 0,
	cacheDuration: 60000, // 1 minute cache
};

/**
 * Check if a command exists in PATH
 *
 * @param command - Command name to check
 * @param isWindows - Whether running on Windows
 * @returns Whether the command is available
 */
function checkCommandExists(command: string, isWindows: boolean): boolean {
	try {
		const checkCommand = isWindows ? "where" : "which";
		const result = spawnSync(checkCommand, [command], {
			stdio: "pipe",
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Check if a runtime is available, with caching
 *
 * @param runtime - Runtime to check
 * @param isWindows - Whether running on Windows
 * @returns Whether the runtime is available
 */
export function isRuntimeAvailable(runtime: RuntimeEnvironment, isWindows: boolean): boolean {
	const now = Date.now();

	// Check cache validity
	if (now - runtimeCache.lastChecked < runtimeCache.cacheDuration) {
		const cached = runtimeCache.available.get(runtime);
		if (cached !== undefined) {
			return cached;
		}
	}

	// Perform check and cache result
	const available = checkCommandExists(runtime, isWindows);
	runtimeCache.available.set(runtime, available);
	runtimeCache.lastChecked = now;

	return available;
}

/**
 * Clear the runtime cache
 * Useful for testing or when environment changes
 */
export function clearRuntimeCache(): void {
	runtimeCache.available.clear();
	runtimeCache.lastChecked = 0;
}

/**
 * Get the preferred runtime order based on platform
 *
 * On Windows, tsx is preferred for better compatibility with simple-git.
 * On other platforms, bun is preferred for performance.
 *
 * @param isWindows - Whether running on Windows
 * @returns Ordered list of runtimes to try
 */
export function getPreferredRuntimes(isWindows: boolean): RuntimeEnvironment[] {
	return isWindows ? ["tsx", "bun"] : ["bun", "tsx"];
}

/**
 * Execute a command with the compiled binary
 *
 * @param binaryPath - Path to the compiled binary
 * @param argv - Command line arguments
 * @param cwd - Working directory
 * @returns Execution result
 */
function executeCompiled(binaryPath: string, argv: string[], cwd: string): RunnerResult {
	const result = spawnSync(binaryPath, argv, {
		stdio: "inherit",
		cwd,
	});

	return {
		exitCode: result.status ?? 1,
		success: result.status === 0,
		runner: "compiled",
		error: result.error?.message,
	};
}

/**
 * Execute a command with a development runtime
 *
 * @param runtime - Runtime to use (bun or tsx)
 * @param entryPath - Path to TypeScript entry point
 * @param argv - Command line arguments
 * @param cwd - Working directory
 * @param isWindows - Whether running on Windows
 * @returns Execution result
 */
function executeDev(
	runtime: RuntimeEnvironment,
	entryPath: string,
	argv: string[],
	cwd: string,
	isWindows: boolean,
): RunnerResult {
	// Build runtime-specific arguments
	const runtimeArgs = runtime === "bun" ? ["run", entryPath] : [entryPath];
	const fullArgs = [...runtimeArgs, ...argv];

	let result;
	if (isWindows) {
		// On Windows, use cmd.exe /c to run .cmd files
		result = spawnSync("cmd.exe", ["/c", runtime, ...fullArgs], {
			stdio: "inherit",
			cwd,
		});
	} else {
		result = spawnSync(runtime, fullArgs, {
			stdio: "inherit",
			cwd,
		});
	}

	// Check if spawn itself failed (not just non-zero exit)
	if (result.error) {
		return {
			exitCode: 1,
			success: false,
			runner: runtime,
			error: result.error.message,
		};
	}

	return {
		exitCode: result.status ?? 1,
		success: result.status === 0,
		runner: runtime,
	};
}

/**
 * Run the CLI using the best available method
 *
 * Tries in order:
 * 1. Compiled binary (if available)
 * 2. Development runtime (bun or tsx, based on platform preference)
 *
 * @param options - Runner options
 * @returns Execution result
 */
export function runCli(options: RunnerOptions): RunnerResult {
	const { compiledBinaryPath, devEntryPath, argv, cwd, platform } = options;

	// Try compiled binary first
	if (compiledBinaryPath && existsSync(compiledBinaryPath)) {
		return executeCompiled(compiledBinaryPath, argv, cwd);
	}

	// Check if dev entry exists
	if (!existsSync(devEntryPath)) {
		return {
			exitCode: 1,
			success: false,
			runner: "none",
			error: `Neither compiled binary nor source entry found`,
		};
	}

	// Try development runtimes in preferred order
	const runtimes = getPreferredRuntimes(platform.isWindows);

	for (const runtime of runtimes) {
		if (!isRuntimeAvailable(runtime, platform.isWindows)) {
			continue;
		}

		const result = executeDev(runtime, devEntryPath, argv, cwd, platform.isWindows);

		// If spawn succeeded (even with non-zero exit), return the result
		if (!result.error || !result.error.includes("ENOENT")) {
			return result;
		}
	}

	// No runtime available
	return {
		exitCode: 1,
		success: false,
		runner: "none",
		error: "No compatible runtime found. Install bun or tsx.",
	};
}

/**
 * Get a user-friendly message for runner failures
 *
 * @param result - Runner result
 * @returns User-friendly error message
 */
export function getRunnerErrorMessage(result: RunnerResult): string {
	if (result.runner === "none") {
		return [
			"Unable to run Milhouse CLI.",
			"",
			"Options:",
			"  1. Build the compiled binary: bun run build",
			"  2. Install bun: https://bun.sh",
			"  3. Install tsx: npm install -g tsx",
		].join("\n");
	}

	if (result.error) {
		return `Execution failed (${result.runner}): ${result.error}`;
	}

	return `Execution failed with exit code ${result.exitCode}`;
}
