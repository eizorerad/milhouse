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

/**
 * Acquire a run-level lock for a specific phase
 * @throws Error if the run is already locked by an active process
 */
export function acquireRunLock(
	runId: string,
	phase: string,
	workDir = process.cwd(),
): { release: () => void } {
	const lockPath = getLockPath(runId, phase, workDir);
	const dir = join(lockPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Check existing lock
	if (existsSync(lockPath)) {
		try {
			const content = readFileSync(lockPath, "utf-8");
			const lock: LockInfo = JSON.parse(content);

			if (isPidAlive(lock.pid)) {
				throw new Error(
					`Run ${runId} phase "${phase}" is locked by PID ${lock.pid} since ${lock.startedAt}`
				);
			}
			// Stale lock — process is dead, overwrite
		} catch (e) {
			if (e instanceof Error && e.message.includes("is locked by PID")) {
				throw e;
			}
			// Corrupted lock file, overwrite
		}
	}

	const lockInfo: LockInfo = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};

	writeFileSync(lockPath, JSON.stringify(lockInfo));

	return {
		release: () => {
			try {
				if (existsSync(lockPath)) {
					rmSync(lockPath);
				}
			} catch {
				// Best-effort release
			}
		},
	};
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
