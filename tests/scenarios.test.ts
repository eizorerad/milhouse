/** Things that go wrong around the pipeline in real use: the user's checkout, git settings, odd agents. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ensureWorktree, refExists, revParse } from "../src/git.ts";
import { prepareWorktree } from "../src/worktree.ts";
import {
	calls,
	cleanupTempDirs,
	git,
	go,
	latest,
	makeRepo,
	readFile,
	resetFakeAgentEnv,
	testConfig,
	useFakeAgent,
	writeFile,
} from "./helpers.ts";

let output: string[] = [];

beforeEach(() => {
	output = [];
	const collect = (...args: unknown[]) =>
		void output.push(stripVTControlCharacters(args.join(" ")));
	spyOn(console, "log").mockImplementation(process.env.DEBUG_TESTS ? console.info : collect);
	spyOn(console, "error").mockImplementation(process.env.DEBUG_TESTS ? console.info : collect);
});

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
	spyOn(console, "log").mockRestore();
	spyOn(console, "error").mockRestore();
});

const PHASES_BEFORE_MERGE = ["scan", "validate", "plan", "consolidate", "exec"] as const;
const noMerge = (over: Record<string, unknown> = {}) =>
	testConfig({ pipeline: [...PHASES_BEFORE_MERGE], ...over });
const TWO_ISSUES = {
	scan: [
		{ title: "Critical thing", severity: "CRITICAL" },
		{ title: "Low thing", severity: "LOW" },
	],
};

describe("the user's checkout while a run is under way", () => {
	it("still merges when an editor or the OS created files meanwhile", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);

		writeFile(repo, ".DS_Store", "x");
		writeFile(repo, "notes.md", "my notes");
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(readFile(repo, "notes.md")).toBe("my notes");
		const [task] = latest(repo).loadTasks();
		expect(readFile(repo, `${task.id}.txt`)).toBe(`${task.title}\n`);
	});

	it("does not overwrite an ignored local file when the work starts to track a file of that name", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const [task] = latest(repo).loadTasks();

		appendFileSync(join(repo, ".git", "info", "exclude"), "*.txt\n"); // a local, uncommitted ignore rule
		writeFile(repo, `${task.id}.txt`, "my local copy");
		const before = await revParse(repo, "HEAD");

		expect(await go(repo, testConfig(), { only: "merge" })).toBe(false);
		expect(readFile(repo, `${task.id}.txt`)).toBe("my local copy");
		expect(await revParse(repo, "HEAD")).toBe(before);
		expect(await refExists(repo, latest(repo).ref)).toBe(true); // the work is still waiting
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "verified"),
		).toBe(true);
	});

	it("refuses to merge work that the run's records and its ref disagree about", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		const [task] = store.loadTasks();
		await git(repo, "checkout", "-q", "-b", "elsewhere");
		await git(repo, "commit", "-q", "--allow-empty", "-m", "a commit the ref never had");
		const stray = await revParse(repo, "HEAD");
		await git(repo, "checkout", "-q", "main");
		store.updateTasks([task.id], { sha: stray });

		expect(await go(repo, testConfig(), { only: "merge" })).toBe(false);
		expect(store.loadTasks().every((t) => t.status === "verified")).toBe(true);
	});

	it("will not rebuild a lost ref from the starting point when verified work depended on it", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		await git(repo, "update-ref", "-d", store.ref);

		const problem = await prepareWorktree(store, testConfig());
		expect(problem).toContain("setup failed");
		expect(problem).toContain("missing");
		expect(await refExists(repo, store.ref)).toBe(false); // not silently recreated
	});
});

describe("what the pipeline tells you", () => {
	it("says how to merge when the pipeline ends before merge", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		expect(output.join("\n")).toContain("milhouse --merge");
		expect(await refExists(repo, latest(repo).ref)).toBe(true);
	});

	it("warns that only the reviewer checks the work when no command is configured", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(output.join("\n")).toContain("No build, lint or test command");

		output = [];
		const repo2 = await makeRepo();
		expect(await go(repo2, testConfig({ commands: { test: "true" } }))).toBe(true);
		expect(output.join("\n")).not.toContain("No build, lint or test command");
	});

	it("does not fail a finished run because its worktree is locked", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge({ pipeline: ["scan", "validate", "plan", "consolidate"] }));
		const store = latest(repo);
		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);
		await git(repo, "worktree", "lock", store.worktree);

		expect(await go(repo, noMerge(), { only: "exec" })).toBe(true);
		expect(output.join("\n")).toContain("locked");
		await git(repo, "worktree", "unlock", store.worktree);
	});
});

describe("what agents and checks do to the worktree", () => {
	it("never lets a commit change .milhouse/, whose config is executed as code", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "milhouse-config" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(calls(fake, "Executor")[1].prompt).toContain(".milhouse/config.ts");
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "failed"),
		).toBe(true);
	});

	it("is not fooled by status.showUntrackedFiles=no: a leftover file is still sent back", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "junk-first" } });
		const repo = await makeRepo();
		await git(repo, "config", "status.showUntrackedFiles", "no");
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Executor")[1].prompt).toContain("Uncommitted changes are left");
		expect(existsSync(join(repo, "junk.txt"))).toBe(false);
	});

	it("starts the next issue from a fresh worktree (and a fresh setup) after one failed", async () => {
		useFakeAgent({ ...TWO_ISSUES, exec: { "Critical thing": "never-commits" } });
		const repo = await makeRepo();
		const config = testConfig({ commands: { setup: "echo ran >> ../setup-count" } });
		expect(await go(repo, config)).toBe(false); // the first issue fails, the second one is accepted
		const tasks = latest(repo).loadTasks();
		expect(tasks.filter((t) => t.status === "merged").length).toBeGreaterThan(0);
		// A failed attempt may have installed dependencies that the next issue must not build on silently.
		expect(readFile(repo, ".milhouse/work/setup-count")).toBe("ran\nran\n");
	});

	it("asks the reviewer again with the reason when its answer could not be read", async () => {
		const fake = useFakeAgent({ proseOnce: ["Truth Verifier"] });
		const repo = await makeRepo();
		const config = testConfig({ phases: { verify: { retries: 1 } } });
		expect(await go(repo, config)).toBe(true);
		const reviews = calls(fake, "Truth Verifier");
		expect(reviews).toHaveLength(2);
		expect(reviews[0].prompt).not.toContain("The previous attempt failed");
		expect(reviews[1].prompt).toContain("The previous attempt failed");
		expect(reviews[1].prompt).toContain("no JSON");
	});
});
