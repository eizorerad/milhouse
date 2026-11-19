import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "../src/state.ts";
import type { Issue, Task } from "../src/types.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

const BASE = { branch: "main", sha: "abc123" };

const issue = (id: string): Issue => ({
	id,
	type: "bug",
	title: `Issue ${id}`,
	rationale: "r",
	severity: "HIGH",
	status: "UNVALIDATED",
	evidence: [],
});

const task = (id: string, issueId = "P1"): Task => ({
	id,
	issue_id: issueId,
	title: `Task ${id}`,
	description: "",
	files: [],
	depends_on: [],
	checks: [],
	acceptance: [],
	status: "pending",
});

describe("RunStore", () => {
	it("creates a run with its starting point and ignore file", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, "fix auth", BASE);
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
		const store = RunStore.create(tempDir(), undefined, BASE);
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

	it("tracks completed phases without duplicates and finishes with a status", () => {
		const store = RunStore.create(tempDir(), undefined, BASE);
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
		const store = RunStore.create(dir, undefined, BASE);
		store.saveTasks([task("T1")]);
		writeFileSync(join(dir, ".milhouse", "runs", store.runId, "tasks.json"), '[{"id": "T1", ');
		expect(() => store.loadTasks()).toThrow(/Corrupt state file .*tasks\.json/);
	});

	it("writes atomically (no temp file is left behind)", () => {
		const dir = tempDir();
		const store = RunStore.create(dir, undefined, BASE);
		store.saveIssues([issue("P1")]);
		// The temporary name is random, so look at what is in the directory, not for a name.
		const files = readdirSync(join(dir, ".milhouse", "runs", store.runId));
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(files).toContain("issues.json");
	});

	it("lists runs oldest first, finds the latest and looks runs up by id", async () => {
		const dir = tempDir();
		const first = RunStore.create(dir, "one", BASE);
		await Bun.sleep(5);
		const second = RunStore.create(dir, "two", BASE);
		expect(RunStore.list(dir).map((r) => r.id)).toEqual([first.runId, second.runId]);
		expect(RunStore.latest(dir)?.runId).toBe(second.runId);
		expect(RunStore.byId(dir, first.runId).loadMeta().scope).toBe("one");
		expect(() => RunStore.byId(dir, "nope")).toThrow(/not found/);
		expect(RunStore.latest(tempDir())).toBeNull();
		expect(RunStore.list(tempDir())).toEqual([]);
	});

	it("cleans only finished runs older than the cutoff", async () => {
		const dir = tempDir();
		const old = RunStore.create(dir, "old", BASE);
		const stopped = RunStore.create(dir, "stopped", BASE);
		const fresh = RunStore.create(dir, "fresh", BASE);
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
