/**
 * Stale lock cleanup
 *
 * Scans .milhouse/runs/ for .lock files left behind by dead processes.
 * Uses process.kill(pid, 0) to check if the owning process is still alive.
 * Dead locks are removed so daemon can proceed.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getRunsDir } from "../state/runs.ts";

interface LockFileContent {
	pid: number;
	startedAt: string;
}

export interface CleanedLock {
	/** Path to the removed lock file */
	path: string;
	/** Dead PID that held the lock */
	pid: number;
	/** Phase the lock was for */
	phase: string;
	/** Run ID the lock was for */
	runId: string;
}

/**
 * Find and remove stale lock files from all run directories.
 * A lock is stale if the process that created it is no longer alive.
 *
 * @returns Array of cleaned locks
 */
export function cleanStaleLocks(workDir = process.cwd()): CleanedLock[] {
	const runsDir = getRunsDir(workDir);

	if (!existsSync(runsDir)) {
		return [];
	}

	const cleaned: CleanedLock[] = [];

	let entries: string[];
	try {
		entries = readdirSync(runsDir);
	} catch {
		return [];
	}

	for (const runId of entries) {
		const runDir = join(runsDir, runId);

		let files: string[];
		try {
			files = readdirSync(runDir);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".lock")) continue;

			const lockPath = join(runDir, file);
			const phase = file.replace(".lock", "");

			try {
				const content = readFileSync(lockPath, "utf-8");
				const lock: LockFileContent = JSON.parse(content);

				if (!isPidAlive(lock.pid)) {
					rmSync(lockPath);
					cleaned.push({
						path: lockPath,
						pid: lock.pid,
						phase,
						runId,
					});
				}
			} catch {
				// Corrupted lock file — safe to remove
				try {
					rmSync(lockPath);
					cleaned.push({
						path: lockPath,
						pid: 0,
						phase,
						runId,
					});
				} catch {
					// Best effort
				}
			}
		}
	}

	return cleaned;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
