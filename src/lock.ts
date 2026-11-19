/** One milhouse per repository at a time: a lock file that holds the pid of its owner. */

import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./state.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A takeover that has been going on this long was abandoned by a crashed starter. */
const STALE_TAKEOVER_MS = 10_000;

/**
 * Create the lock file with its owner already inside it: written whole to a file of its own, then linked
 * into place. Creating it empty and writing afterwards would let a second starter see a lock without an
 * owner, take it for a dead one's and clear it. Throws EEXIST when somebody holds the lock.
 */
function createLock(path: string): void {
	const mine = `${path}.${process.pid}.tmp`;
	writeFileSync(mine, String(process.pid));
	try {
		linkSync(mine, path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
		writeFileSync(path, String(process.pid), { flag: "wx" }); // a filesystem without hard links
	} finally {
		rmSync(mine, { force: true });
	}
}

/** One milhouse per repository at a time. Returns the release function (also runs on exit). */
export function acquireLock(workDir: string): () => void {
	const path = join(workDir, STATE_DIR, "lock");
	const takeover = `${path}.takeover`;
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			createLock(path);
			const release = () => {
				process.off("exit", release);
				rmSync(path, { force: true });
			};
			process.once("exit", release);
			return release;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		let holder: string;
		try {
			holder = readFileSync(path, "utf-8");
		} catch {
			continue; // released in the meantime
		}
		const pid = Number(holder);
		if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
			throw new Error(`Another milhouse is running in this repository (pid ${pid}).`);
		}

		// The holder is dead. Only one starter at a time may clear its lock: two starters that both saw
		// the stale lock would otherwise delete each other's fresh one and both run.
		try {
			mkdirSync(takeover);
		} catch {
			const started = statSync(takeover, { throwIfNoEntry: false })?.mtimeMs ?? 0;
			if (Date.now() - started > STALE_TAKEOVER_MS) {
				rmSync(takeover, { recursive: true, force: true });
			} else {
				Bun.sleepSync(20);
			}
			continue;
		}
		try {
			if (readFileSync(path, "utf-8") === holder) rmSync(path, { force: true });
		} catch {
			// already gone
		} finally {
			rmSync(takeover, { recursive: true, force: true });
		}
	}
	throw new Error("Could not acquire the milhouse lock.");
}
