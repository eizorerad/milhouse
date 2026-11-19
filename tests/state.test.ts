import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "../src/state.ts";
import { BASE, cleanupTempDirs, makeIssue, makeTask, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

/** Where this file's own runs start; the first test checks that it is recorded as given. */
const START = { branch: "main", sha: "abc123" };

/** Issues titled "Issue <id>" that are not validated yet; tasks titled "Task <id>". */
const issue = (id: string) => makeIssue(id, { title: `Issue ${id}`, status: "UNVALIDATED" });
const task = (id: string) => makeTask(id, { title: `Task ${id}` });

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
		const dir = tempDir();
		const store = new RunStore(dir, "run-1");
		expect(store.ref).toBe("refs/milhouse/run-1");
		expect(store.worktree).toBe(join(dir, ".milhouse", "work", "run-1"));
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
