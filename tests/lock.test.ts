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
		expect(readFileSync(join(dir, ".milhouse", "lock"), "utf-8")).toBe(String(process.pid));
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
	});
});
