/** Things that go wrong around the pipeline in real use: the user's checkout, git settings, odd agents. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
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
	tempDir,
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

describe("where milhouse is started", () => {
	it("works in a linked worktree of the repository and merges into that worktree's branch", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const linked = join(tempDir(), "linked");
		await git(repo, "worktree", "add", "-q", "-b", "feature/x", linked);

		expect(await go(linked)).toBe(true);
		expect(existsSync(join(linked, ".milhouse", "runs"))).toBe(true);
		expect(await git(repo, "log", "--format=%s", "feature/x")).toContain("[T-");
		expect(await git(repo, "log", "--format=%s", "main")).not.toContain("[T-"); // the other branch is untouched
		expect(await refExists(repo, latest(linked).ref)).toBe(false); // cleaned up, as for any run
	});

	it("works in a directory whose name has spaces and non-ASCII characters", async () => {
		useFakeAgent({});
		const repo = await makeRepo(join(tempDir(), "my project \u00e9\u00e8 (copy)"));
		const config = testConfig({ commands: { setup: "true", test: 'test "$(pwd)" != ""' } });
		expect(await go(repo, config)).toBe(true);
		const [task] = latest(repo).loadTasks();
		expect(readFile(repo, `${task.id}.txt`)).toBe(`${task.title}\n`);
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

describe("what exec may build on", () => {
	it("refuses to start a run with untracked files: exec works from the last commit and would not see them", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		writeFile(repo, "wip.ts", "export const wip = 1;\n");
		await expect(go(repo)).rejects.toThrow(/untracked/);
		expect(fake.journal()).toHaveLength(0);
		expect(await go(repo, testConfig({ pipeline: ["scan"] }))).toBe(true); // reading is fine
	});

	it("will not publish a ref that moved ahead of every commit that was reviewed", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		const tip = await revParse(repo, store.ref);
		const tree = await git(repo, "rev-parse", `${tip}^{tree}`);
		const unreviewed = await git(
			repo,
			"commit-tree",
			tree,
			"-p",
			tip,
			"-m",
			"an unreviewed commit",
		);
		await git(repo, "update-ref", store.ref, unreviewed);
		const before = await revParse(repo, "HEAD");

		expect(await go(repo, testConfig(), { only: "merge" })).toBe(false);
		expect(await revParse(repo, "HEAD")).toBe(before);
		expect(output.join("\n")).toContain("reviewed");
		expect(store.loadTasks().every((t) => t.status === "verified")).toBe(true);
	});

	it("sets a picked-up attempt up at its own commit: it may need what the accepted work lacks", async () => {
		useFakeAgent({ fail: { "Truth Verifier": { message: "overloaded", times: 99 } } });
		const repo = await makeRepo();
		// Lists the files that exist when setup runs. Setup at the wrong commit would see none of the task files.
		const config = testConfig({
			commands: { setup: "ls *.txt >> ../setup-seen 2>/dev/null || true" },
		});
		expect(await go(repo, config)).toBe(false); // the work is done, only the review keeps failing
		const [task] = latest(repo).loadTasks();
		expect(readFile(repo, ".milhouse/work/setup-seen")).not.toContain(task.id);

		process.env.FAKE_AGENT_SCENARIO = JSON.stringify({});
		expect(await go(repo, config, { resume: true })).toBe(true);
		expect(readFile(repo, ".milhouse/work/setup-seen")).toContain(task.id);
	});
});

describe("what agents and checks do to the worktree", () => {
	it("stops, and leaves the attempt where it is, when a failed attempt cannot be kept", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		// A branch named mh-failed stands in the way of every mh-failed/<issue> branch.
		writeFile(repo, ".git/refs/heads/mh-failed", `${await revParse(repo, "HEAD")}\n`);

		await expect(go(repo)).rejects.toThrow(/could not be kept/);
		const store = latest(repo);
		expect(existsSync(store.worktree)).toBe(true); // not removed, not reset: it is the only copy
		expect(readdirSync(store.worktree).some((name) => name.startsWith("T-"))).toBe(true);
	});

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
