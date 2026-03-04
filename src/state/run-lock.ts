/**
 * Per-run per-phase execution locks
 * Prevents concurrent execution of the same phase for the same run
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRunDir } from "./runs.ts";

interface LockInfo {
	pid: number;
	startedAt: string;
}

function getLockPath(runId: string, phase: string, workDir: string): string {
	return join(getRunDir(runId, workDir), `${phase}.lock`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const MAX_RETRY_ATTEMPTS = 3;

/**
 * Acquire a run-level lock for a specific phase.
 * Uses writeFileSync with the 'wx' (exclusive create) flag for atomic
 * lock acquisition, eliminating the TOCTOU race between check and write.
 * @throws Error if the run is already locked by an active process
 */
export function acquireRunLock(
	runId: string,
	phase: string,
	workDir = process.cwd(),
): { release: () => void } {
	const lockPath = getLockPath(runId, phase, workDir);
	const dir = join(lockPath, "..");
	mkdirSync(dir, { recursive: true });

	const lockInfo: LockInfo = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};

	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: "wx" });
			// Exclusive write succeeded — lock acquired
			return {
				release: () => {
					try {
						rmSync(lockPath, { force: true });
					} catch {
						// Best-effort release
					}
				},
			};
		} catch (err: unknown) {
			const error = err as NodeJS.ErrnoException;
			if (error.code !== "EEXIST") {
				throw error;
			}

			// Lock file already exists — check if holder is still alive
			try {
				const content = readFileSync(lockPath, "utf-8");
				const lock: LockInfo = JSON.parse(content);

				if (isPidAlive(lock.pid)) {
					throw new Error(
						`Run ${runId} phase "${phase}" is locked by PID ${lock.pid} since ${lock.startedAt}`,
					);
				}
				// Stale lock — PID is dead, remove and retry
			} catch (e) {
				if (e instanceof Error && e.message.includes("is locked by PID")) {
					throw e;
				}
				// Corrupted or unreadable lock file — remove and retry
			}

			try {
				rmSync(lockPath, { force: true });
			} catch {
				// Removal failed (e.g., race with another process); retry will hit EEXIST again
			}
		}
	}

	throw new Error(
		`Failed to acquire lock for run ${runId} phase "${phase}" after ${MAX_RETRY_ATTEMPTS} attempts`,
	);
}

/**
 * Check if a run phase is currently locked
 */
export function isRunLocked(
	runId: string,
	phase: string,
	workDir = process.cwd(),
): { locked: boolean; pid?: number; since?: string } {
	const lockPath = getLockPath(runId, phase, workDir);

	if (!existsSync(lockPath)) {
		return { locked: false };
	}

	try {
		const content = readFileSync(lockPath, "utf-8");
		const lock: LockInfo = JSON.parse(content);

		if (isPidAlive(lock.pid)) {
			return { locked: true, pid: lock.pid, since: lock.startedAt };
		}

		// Stale lock
		return { locked: false };
	} catch {
		return { locked: false };
	}
}
