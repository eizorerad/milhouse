import { lock, unlock, check } from "proper-lockfile";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
	/** Number of retries when acquiring lock (default: 5) */
	retries?: number;
	/** Lock considered stale after this many ms (default: 10000) */
	stale?: number;
}

/**
 * Execute an operation with file locking to prevent concurrent access.
 *
 * This function provides cross-process file locking using proper-lockfile,
 * which creates a .lock file alongside the target file. The lock is
 * automatically released when the operation completes or throws.
 *
 * @param filePath - Path to the file to lock
 * @param operation - Async or sync operation to execute while holding the lock
 * @param options - Lock configuration options
 * @returns The result of the operation
 *
 * @example
 * ```typescript
 * const issues = await withFileLock(issuesPath, () => {
 *   const data = loadIssuesForRun(runId, workDir);
 *   data[0].status = 'CONFIRMED';
 *   saveIssuesForRun(runId, data, workDir);
 *   return data[0];
 * });
 * ```
 */
export async function withFileLock<T>(
	filePath: string,
	operation: () => T | Promise<T>,
	options?: LockOptions,
): Promise<T> {
	// Ensure the file exists (proper-lockfile requires it)
	ensureFileExists(filePath);

	const release = await lock(filePath, {
		retries: options?.retries ?? 5,
		stale: options?.stale ?? 10000,
	});

	try {
		return await operation();
	} finally {
		await release();
	}
}

/**
 * Check if a file is currently locked by another process.
 *
 * This can be used to check lock status before attempting an operation,
 * though note that the status may change between checking and acquiring.
 *
 * @param filePath - Path to the file to check
 * @returns true if the file is locked, false otherwise
 */
export async function isFileLocked(filePath: string): Promise<boolean> {
	if (!existsSync(filePath)) {
		return false;
	}
	return check(filePath);
}

/**
 * Ensure a file exists for locking (creates empty JSON array if needed).
 *
 * proper-lockfile requires the target file to exist before locking.
 * This function creates the file with an empty array if it doesn't exist,
 * which is appropriate for our issues.json and tasks.json files.
 *
 * @param filePath - Path to the file to ensure exists
 */
function ensureFileExists(filePath: string): void {
	if (!existsSync(filePath)) {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(filePath, "[]");
	}
}
