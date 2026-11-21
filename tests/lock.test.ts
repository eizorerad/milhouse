/** One milhouse per repository: the lock, its stale takeover and its release. */

import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

describe("acquireLock", () => {
	it("refuses a second holder and can be released and re-acquired", () => {
		const dir = tempDir();
		const release = acquireLock(dir);
		expect(() => acquireLock(dir)).toThrow(/Another milhouse is running/);
		release();
		acquireLock(dir)();
	});

	it("never shows a lock without its owner, and leaves no temporary file behind", () => {
		const dir = tempDir();
		const release = acquireLock(dir);
		// The pid and when that process started: the pid alone may be another process after a crash.
		expect(readFileSync(join(dir, ".milhouse", "lock"), "utf-8")).toMatch(
			new RegExp(`^${process.pid} \\w{3} \\w{3} +\\d+ [\\d:]+ \\d{4}$`),
		);
		expect(readdirSync(join(dir, ".milhouse"))).toEqual(["lock"]);
		release();
		expect(readdirSync(join(dir, ".milhouse"))).toEqual([]);
	});

	it("takes over a stale lock left by a dead process", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "lock"), "2147483646");
		acquireLock(dir)();
	});

	it("takes over a lock whose pid now belongs to another process, and names the file when it is held", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		const path = join(dir, ".milhouse", "lock");
		// This very pid is alive, but the lock was written by a process that started long ago.
		writeFileSync(path, `${process.pid} Thu Jan  1 00:00:00 1970`);
		const release = acquireLock(dir);
		expect(() => acquireLock(dir)).toThrow(`If it is not, delete ${path}`);
		release();

		writeFileSync(path, String(process.pid)); // a lock of 0.5.2 holds the pid only: it is judged by that
		expect(() => acquireLock(dir)).toThrow(/Another milhouse is running/);
	});

	it("treats an unreadable lock file as stale (never signals pid 0)", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "lock"), "");
		acquireLock(dir)();
	});
});

describe("acquireLock takeover", () => {
	it("clears a stale lock exactly once, even when a second starter is taking over at the same time", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "lock"), "2147483646");
		// Another starter is in the middle of taking the stale lock over: this one must wait, not delete.
		mkdirSync(join(dir, ".milhouse", "lock.takeover"));
		const old = new Date(Date.now() - 60_000);
		utimesSync(join(dir, ".milhouse", "lock.takeover"), old, old); // ... but it died a minute ago
		acquireLock(dir)();
		expect(existsSync(join(dir, ".milhouse", "lock.takeover"))).toBe(false);
	});

	it("does not take a lock over while a live process holds it", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "lock"), String(process.pid));
		expect(() => acquireLock(dir)).toThrow(/Another milhouse is running/);
		expect(readFileSync(join(dir, ".milhouse", "lock"), "utf-8")).toBe(String(process.pid));
	});

	it("gives up instead of waiting forever when another starter keeps the takeover", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "lock"), "2147483646");
		mkdirSync(join(dir, ".milhouse", "lock.takeover")); // fresh: somebody is working on it
		expect(() => acquireLock(dir)).toThrow(/Could not acquire/);
	}, 30_000); // 50 tries with a pause each: seconds on a busy runner, and it is not the speed that is tested
});
