import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { RunStore } from "../src/state.ts";
import { BASE, cleanupTempDirs, makeIssue, makeTask, tempDir, unsetEnv } from "./helpers.ts";

const CACHE_HOME = process.env.XDG_CACHE_HOME;

afterEach(() => {
	cleanupTempDirs();
	unsetEnv("MILHOUSE_WORK_DIR");
	if (CACHE_HOME === undefined) unsetEnv("XDG_CACHE_HOME");
	else process.env.XDG_CACHE_HOME = CACHE_HOME;
});

/** Where this file's own runs start; the first test checks that it is recorded as given. */
const START = { branch: "main", sha: "abc123" };

/** Issues titled "Issue <id>" that are not validated yet; tasks titled "Task <id>". */
const issue = (id: string) => makeIssue(id, { title: `Issue ${id}`, status: "UNVALIDATED" });
const task = (id: string) => makeTask(id, { title: `Task ${id}` });

describe("the worktree of a run", () => {
	it("is outside the project, so that nothing installed in the project is found from it", () => {
		unsetEnv("MILHOUSE_WORK_DIR");
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, START);
		expect(store.worktree.startsWith(dir)).toBe(false);
		expect(store.worktree.endsWith(store.runId)).toBe(true);
	});

	it("is in the user's cache folder, in a folder of its project: two clones may have a run of the same id", () => {
		unsetEnv("MILHOUSE_WORK_DIR");
		const cache = tempDir();
		process.env.XDG_CACHE_HOME = cache;
		const first = new RunStore(tempDir(), "run-1");
		const second = new RunStore(tempDir(), "run-1");
		expect(first.worktree.startsWith(join(cache, "milhouse"))).toBe(true);
		expect(first.worktree).not.toBe(second.worktree);
	});

	it("is an absolute path even when MILHOUSE_WORK_DIR is relative, and ignores a blank one", () => {
		process.env.MILHOUSE_WORK_DIR = "relative/place";
		const relative = new RunStore(tempDir(), "run-1").worktree;
		expect(relative).toBe(join(process.cwd(), "relative/place", "run-1"));
		process.env.MILHOUSE_WORK_DIR = "   ";
		expect(new RunStore(tempDir(), "run-1").worktree.startsWith(" ")).toBe(false);
		expect(new RunStore(tempDir(), "run-1").worktree).toContain("milhouse");
	});

	it("keeps to the cache folder of the user when XDG_CACHE_HOME is blank or not an absolute path", () => {
		unsetEnv("MILHOUSE_WORK_DIR");
		for (const value of ["   ", "relative/cache"]) {
			process.env.XDG_CACHE_HOME = value;
			const { worktree } = new RunStore(tempDir(), "run-1");
			expect(worktree.startsWith(join(homedir(), ".cache", "milhouse"))).toBe(true);
		}
	});

	it("is under MILHOUSE_WORK_DIR when that is set", () => {
		const place = tempDir();
		process.env.MILHOUSE_WORK_DIR = place;
		const store = RunStore.create(tempDir(), undefined, START);
		expect(store.worktree).toBe(join(place, store.runId));
	});

	it("stays where a run of an earlier version put it", () => {
		unsetEnv("MILHOUSE_WORK_DIR");
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, START);
		const old = join(dir, ".milhouse", "work", store.runId);
		mkdirSync(old, { recursive: true });
		expect(store.worktree).toBe(old);
	});
});

describe("RunStore", () => {
	it("creates a run with its starting point and ignore file", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, "fix auth", START);
		const meta = store.loadMeta();
		expect(meta).toMatchObject({
			scope: "fix auth",
			status: "running",
			done: [],
			base_branch: "main",
			base_sha: "abc123",
		});
		expect(store.runId).toMatch(/^run-\d{8}-/);
		expect(readFileSync(join(dir, ".milhouse", ".gitignore"), "utf-8")).toContain("work/");
	});

	it("keeps a log of what happened, one JSON object per line", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, START);
		store.logEvent({ event: "first", n: 1 });
		store.logEvent({ event: "second" });
		const text = readFileSync(join(dir, ".milhouse", "runs", store.runId, "events.jsonl"), "utf-8");
		const events = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events.map((e) => e.event)).toEqual(["first", "second"]);
		expect(events[0].n).toBe(1);
		expect(Number.isNaN(Date.parse(events[0].at))).toBe(false);
	});

	it("round-trips issues and tasks and patches them immutably", () => {
		const store = RunStore.create(tempDir(), undefined, START);
		store.saveIssues([issue("P1"), issue("P2")]);
		store.updateIssue("P1", { status: "CONFIRMED" });
		expect(store.loadIssues().map((i) => i.status)).toEqual(["CONFIRMED", "UNVALIDATED"]);

		store.saveTasks([task("T1"), task("T2")]);
		store.updateTasks(["T2"], { status: "failed", error: "boom" });
		store.updateTasks(["T2"], { status: "verified", error: undefined });
		expect(store.loadTasks().map((t) => [t.status, t.error])).toEqual([
			["pending", undefined],
			["verified", undefined],
		]);
	});

	it("records the commit that was accepted for a task", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
		store.saveTasks([makeTask("T1")]);
		store.updateTasks(["T1"], { sha: "abc123" });
		expect(store.loadTasks()[0].sha).toBe("abc123");
	});

	it("tracks completed phases without duplicates and finishes with a status", () => {
		const store = RunStore.create(tempDir(), undefined, START);
		store.startPhase("scan");
		store.completePhase("scan");
		store.completePhase("scan");
		store.startPhase("validate");
		expect(store.loadMeta()).toMatchObject({
			phase: "validate",
			done: ["scan"],
			status: "running",
		});
		store.finish("failed");
		expect(store.loadMeta().status).toBe("failed");
	});

	it("derives the accepted-work ref and the worktree from the run id", () => {
		unsetEnv("MILHOUSE_WORK_DIR");
		const store = new RunStore(tempDir(), "run-1");
		expect(store.ref).toBe("refs/milhouse/run-1");
		expect(store.worktree).toContain("milhouse");
		expect(store.worktree.endsWith(`${sep}run-1`)).toBe(true);
	});

	it("fails loudly on a corrupt state file instead of silently resetting it", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, START);
		store.saveTasks([task("T1")]);
		writeFileSync(join(dir, ".milhouse", "runs", store.runId, "tasks.json"), '[{"id": "T1", ');
		expect(() => store.loadTasks()).toThrow(/Corrupt state file .*tasks\.json/);
	});

	it("writes atomically (no temp file is left behind)", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, START);
		store.saveIssues([issue("P1")]);
		// The temporary name is random, so look at what is in the directory, not for a name.
		const files = readdirSync(join(dir, ".milhouse", "runs", store.runId));
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(files).toContain("issues.json");
	});

	it("lists runs oldest first, finds the latest and looks runs up by id", async () => {
		const dir = tempDir();
		const first = RunStore.create(dir, "one", START);
		await Bun.sleep(5);
		const second = RunStore.create(dir, "two", START);
		expect(RunStore.list(dir).map((r) => r.id)).toEqual([first.runId, second.runId]);
		expect(RunStore.latest(dir)?.runId).toBe(second.runId);
		expect(RunStore.byId(dir, first.runId).loadMeta().scope).toBe("one");
		expect(() => RunStore.byId(dir, "nope")).toThrow(/not found/);
		expect(RunStore.latest(tempDir())).toBeNull();
		expect(RunStore.list(tempDir())).toEqual([]);
	});

	it("cleans only finished runs older than the cutoff", async () => {
		const dir = tempDir();
		const old = RunStore.create(dir, "old", START);
		const stopped = RunStore.create(dir, "stopped", START);
		const fresh = RunStore.create(dir, "fresh", START);
		for (const [store, status, daysAgo] of [
			[old, "completed", 40],
			[stopped, "stopped", 40],
			[fresh, "completed", 1],
		] as const) {
			store.finish(status);
			const metaPath = join(dir, ".milhouse", "runs", store.runId, "meta.json");
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			meta.created_at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
			writeFileSync(metaPath, JSON.stringify(meta));
		}
		expect((await RunStore.clean(dir, 30)).removed).toEqual([old.runId]);
		expect(
			RunStore.list(dir)
				.map((r) => r.id)
				.sort(),
		).toEqual([stopped.runId, fresh.runId].sort());
	});

	it("cleans old runs of any status when asked for all: a stopped one, one that never said how it ended", async () => {
		const dir = tempDir();
		const stopped = RunStore.create(dir, "stopped", START);
		const crashed = RunStore.create(dir, "crashed", START); // still "running": the process was killed
		const fresh = RunStore.create(dir, "fresh", START);
		stopped.finish("stopped");
		for (const store of [stopped, crashed]) {
			const metaPath = join(dir, ".milhouse", "runs", store.runId, "meta.json");
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			meta.created_at = new Date(Date.now() - 40 * 86_400_000).toISOString();
			writeFileSync(metaPath, JSON.stringify(meta));
		}
		expect((await RunStore.clean(dir, 30)).removed).toEqual([]);
		const { removed } = await RunStore.clean(dir, 30, undefined, true);
		expect(removed.sort()).toEqual([stopped.runId, crashed.runId].sort());
		expect(RunStore.list(dir).map((r) => r.id)).toEqual([fresh.runId]);
	});
});

describe("run ids", () => {
	it("only accepts ids that are safe as paths and ref names", () => {
		const dir = tempDir();
		for (const bad of ["../x", "run-/../x", "run-a b", "x", "", "run-é", "run-a/b"]) {
			expect(() => new RunStore(dir, bad)).toThrow(/Invalid run id/);
		}
		expect(new RunStore(dir, "run-20260101-abc_DEF-1").ref).toBe(
			"refs/milhouse/run-20260101-abc_DEF-1",
		);
	});

	it("treats a path-like --run-id as simply not found", () => {
		expect(() => RunStore.byId(tempDir(), "../../etc")).toThrow(/not found/);
	});

	it("takes the id from the directory name, never from the file content, and skips foreign directories", async () => {
		const dir = tempDir();
		const store = RunStore.create(dir, "real", BASE);
		const runs = join(dir, ".milhouse", "runs");
		// A repository could ship a run whose meta.json claims another id.
		const fake = join(runs, "run-planted");
		mkdirSync(fake);
		writeFileSync(
			join(fake, "meta.json"),
			JSON.stringify({
				id: "../../../victim",
				status: "completed",
				created_at: "2000-01-01T00:00:00Z",
				done: [],
			}),
		);
		mkdirSync(join(runs, "not-a-run"));
		writeFileSync(join(runs, "not-a-run", "meta.json"), "{}");

		const ids = RunStore.list(dir).map((r) => r.id);
		expect(ids).toEqual(["run-planted", store.runId]);
		expect((await RunStore.clean(dir, 1)).removed).toEqual(["run-planted"]); // removes only its own directory
		expect(RunStore.list(dir).map((r) => r.id)).toEqual([store.runId]);
	});

	it("never follows a planted symlink when writing the log either", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, BASE);
		const victim = join(tempDir(), "victim.txt");
		writeFileSync(victim, "precious");
		symlinkSync(victim, join(dir, ".milhouse", "runs", store.runId, "events.jsonl"));
		expect(() => store.logEvent({ event: "x" })).toThrow();
		expect(readFileSync(victim, "utf-8")).toBe("precious");
	});

	it("never follows a planted symlink when writing state", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, BASE);
		const victim = join(tempDir(), "victim.txt");
		writeFileSync(victim, "precious");
		const runDir = join(dir, ".milhouse", "runs", store.runId);
		symlinkSync(victim, join(runDir, "tasks.json.tmp"));
		store.saveTasks([makeTask("T1")]);
		expect(store.loadTasks()).toHaveLength(1);
		expect(readFileSync(victim, "utf-8")).toBe("precious");
	});
});
