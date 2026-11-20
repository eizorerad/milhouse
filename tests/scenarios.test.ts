/** Things that go wrong around the pipeline in real use: the user's checkout, git settings, odd agents. */

import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkBase } from "../src/baseline.ts";
import { ensureWorktree, refExists, revParse } from "../src/git.ts";
import { RunStore } from "../src/state.ts";
import { discardWorktree, prepareWorktree } from "../src/worktree.ts";
import {
	TWO_ISSUES,
	allStatus,
	calls,
	captureConsole,
	cleanupTempDirs,
	commitFile,
	git,
	go,
	latest,
	mainSubjects,
	makeRepo,
	makeTask,
	noMerge,
	readFile,
	resetFakeAgentEnv,
	setScenario,
	tempDir,
	testConfig,
	unsetEnv,
	useFakeAgent,
	writeFile,
} from "./helpers.ts";

const output = captureConsole();

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

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
		expect(allStatus(repo, "verified")).toBe(true);
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

describe("what each step is told", () => {
	it("adds a step's own rules to that step's prompt only, after the global ones", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({
			rules: ["Use tabs"],
			phases: {
				scan: { rules: ["Prefer bugs that lose data"] },
				verify: { rules: ["Be strict about tests", "Reject stubs"] },
			},
		});
		expect(await go(repo, config)).toBe(true);

		const scan = calls(fake, "Lead Investigator")[0].prompt;
		expect(scan).toContain("## Extra rules for this step\n- Prefer bugs that lose data");
		expect(scan).toContain("- Use tabs"); // the global rules are still there
		const review = calls(fake, "Truth Verifier")[0].prompt;
		expect(review).toContain(
			"## Extra rules for this step\n- Be strict about tests\n- Reject stubs",
		);
		expect(review).not.toContain("Prefer bugs that lose data");
		for (const role of ["Issue Validator", "Planner", "Consistency Manager", "Executor"]) {
			for (const call of calls(fake, role)) expect(call.prompt).not.toContain("Extra rules");
		}
	});

	it("puts the extra rules before the answer format that Codex is asked for", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({ harness: "codex", phases: { scan: { rules: ["Prefer bugs"] } } });
		expect(await go(repo, config)).toBe(true);
		const scan = calls(fake, "Lead Investigator")[0].prompt;
		expect(scan).toContain("Extra rules for this step");
		expect(scan.indexOf("Extra rules for this step")).toBeLessThan(
			scan.indexOf("## Answer format"),
		);
	});
});

describe("what the pipeline tells you", () => {
	it("validates against the saved scope and prints the verdict and reason", async () => {
		const fake = useFakeAgent({ status: { "Add greeting": "FALSE" } });
		const repo = await makeRepo();
		const scope = "Only fix the Pages deployment";
		await go(repo, testConfig(), { only: "scan", scope });
		await go(repo, testConfig(), { only: "validate" });
		for (const role of ["Lead Investigator", "Issue Validator"]) {
			expect(calls(fake, role)[0].prompt).toContain(`## Focus\n${scope}`);
		}
		expect(output.map((line) => line.trim())).toContain("Add greeting - FALSE: ok");
	});

	it("says at the start which agent runs every step, so a surprise shows before it costs money", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({
			model: "claude-opus-5-5",
			phases: {
				validate: { harness: "codex", workers: 8 },
				plan: { model: "claude-sonnet-5-5", workers: 4 },
				verify: { harness: "codex", model: "gpt-x" },
			},
		});
		await go(repo, config);
		expect(output.join("\n")).toContain(
			"Agents: scan claude/claude-opus-5-5, validate codex/default x8, plan claude/claude-sonnet-5-5 x4, consolidate claude/claude-opus-5-5, exec claude/claude-opus-5-5, verify codex/gpt-x",
		);
	});

	it("shows Milhouse's own default for Claude when no model is named (not Claude Code's)", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, testConfig({ pipeline: ["scan"] }));
		expect(output.join("\n")).toContain("Agents: scan claude/sonnet");
	});

	it("says how to merge when the pipeline ends before merge", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		expect(output.join("\n")).toContain("milhouse --merge");
		expect(await refExists(repo, latest(repo).ref)).toBe(true);
	});

	it("keeps unchecked work for manual merge even if a test is configured on resume", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const unchecked = testConfig({ commands: { setup: "true", test: "  " }, allowUnchecked: true });
		expect(await go(repo, unchecked)).toBe(true);
		const store = latest(repo);
		const tip = await git(repo, "rev-parse", store.ref);
		expect(await mainSubjects(repo)).toEqual(["initial"]);
		expect(store.loadMeta().done).not.toContain("merge");
		expect(output.join("\n")).toContain("No build, lint or test command");
		expect(calls(fake, "Truth Verifier")[0].prompt).toContain(
			"No build, lint or test command was run.",
		);

		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(await mainSubjects(repo)).toEqual(["initial"]);
		expect(await git(repo, "rev-parse", store.ref)).toBe(tip);
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(await git(repo, "rev-parse", "HEAD")).toBe(tip);
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

	it("also refuses when an earlier phase reads the checkout again: a resumed run that still has to validate", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ pipeline: ["scan"] }))).toBe(true);
		writeFile(repo, "wip.ts", "export const wip = 1;\n");
		await expect(go(repo, testConfig(), { resume: true })).rejects.toThrow(/untracked/);
		expect(calls(fake, "Issue Validator")).toHaveLength(0);
	});

	it("will not carry on from a ref that moved ahead of every commit that was accepted", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		const tip = await revParse(repo, store.ref);
		const tree = await git(repo, "rev-parse", `${tip}^{tree}`);
		await git(
			repo,
			"update-ref",
			store.ref,
			await git(repo, "commit-tree", tree, "-p", tip, "-m", "x"),
		);

		const problem = await prepareWorktree(store, testConfig());
		expect(problem).toContain("setup failed");
		expect(problem).toContain("outside Milhouse");
		// ... but a tip that is already part of the user's branch is nothing to worry about
		await git(repo, "update-ref", store.ref, await revParse(repo, "HEAD"));
		expect(await prepareWorktree(store, testConfig())).toBeNull();
	});

	it("will not publish when the run recorded no accepted commit at all", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		store.updateTasks(
			store.loadTasks().map((t) => t.id),
			{ sha: undefined },
		);
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(false);
		expect(output.join("\n")).toContain("no accepted commit");
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

		setScenario({});
		expect(await go(repo, config, { resume: true })).toBe(true);
		expect(readFile(repo, ".milhouse/work/setup-seen")).toContain(task.id);
	});
});

describe("the starting commit", () => {
	it("is checked before anything is spent: a run cannot pass checks that fail without it", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({
			commands: { test: "echo broken >&2; exit 1" },
			gates: { baseline: true },
		});
		expect(await go(repo, config)).toBe(false);
		expect(fake.journal()).toHaveLength(0);
		expect(latest(repo).loadMeta().status).toBe("failed");
		expect(output.join("\n")).toContain("fail on the starting commit");
		expect(output.join("\n")).toContain("broken");
		const store = latest(repo);
		expect(existsSync(store.worktree)).toBe(false); // nothing of the run is left behind
		expect(await refExists(repo, store.ref)).toBe(false);
		const events = readFile(repo, `.milhouse/runs/${store.runId}/events.jsonl`);
		expect(events).toContain("baseline-failed");
	});

	it("stops the run, and says why, when the check cannot be made at all", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const elsewhere = tempDir();
		writeFile(elsewhere, "not-a-folder", "x"); // a file where the worktree's parent folder should be
		process.env.MILHOUSE_WORK_DIR = join(elsewhere, "not-a-folder", "inside");
		const config = testConfig({ commands: { test: "true" }, gates: { baseline: true } });
		expect(await go(repo, config)).toBe(false);
		expect(fake.journal()).toHaveLength(0);
		expect(latest(repo).loadMeta().status).toBe("failed");
		expect(await refExists(repo, latest(repo).ref)).toBe(false); // no ref of the run is left behind
	});

	it("checks in a new worktree: what a killed session left in the old one does not count", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const store = RunStore.create(repo, undefined, { branch: "main", sha: base });
		await ensureWorktree(repo, store.worktree, store.ref, base);
		writeFile(store.worktree, "stale.txt", "left by a killed session");
		const config = testConfig({
			commands: { test: "test ! -f stale.txt" },
			gates: { baseline: true },
		});
		expect(await checkBase(store, config)).toBeNull();
	});

	it("checks the commit that the run started from, whatever the ref of the run says", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const store = RunStore.create(repo, undefined, { branch: "main", sha: base });
		await commitFile(repo, "later.txt", "newer", "later");
		await git(repo, "update-ref", store.ref, await revParse(repo, "HEAD"));
		const config = testConfig({
			commands: { test: "test ! -f later.txt" },
			gates: { baseline: true },
		});
		expect(await checkBase(store, config)).toBeNull();
	});

	it("does not touch the ref of a run with verified work, whatever its tasks say about their commits", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const store = RunStore.create(repo, undefined, { branch: "main", sha: base });
		const work = await commitFile(repo, "work.txt", "done", "T-1 work");
		await git(repo, "update-ref", store.ref, work);
		store.saveTasks([makeTask("T-1", { status: "verified" })]); // no sha recorded
		const config = testConfig({ commands: { test: "true" }, gates: { baseline: true } });
		expect(await checkBase(store, config)).toBeNull();
		expect(await revParse(repo, store.ref)).toBe(work);
	});

	it("leaves a run alone once it has accepted work: its starting commit was usable", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const store = RunStore.create(repo, undefined, { branch: "main", sha: base });
		store.saveTasks([makeTask("T-1", { sha: base, status: "pending" })]);
		const failing = testConfig({ commands: { test: "exit 1" }, gates: { baseline: true } });
		expect(await checkBase(store, failing)).toBeNull();
	});

	it("stops the run when the setup of the check fails, before any agent works", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({
			commands: { setup: "exit 7", test: "true" },
			gates: { baseline: true },
		});
		expect(await go(repo, config)).toBe(false);
		expect(fake.journal()).toHaveLength(0);
		expect(output.join("\n")).toContain("setup failed");
		expect(output.join("\n")).not.toContain("gates.baseline"); // the run could not fix a setup
	});

	it("checks the starting commit only when the config asks for it: one more run of the checks", async () => {
		useFakeAgent({});
		const runsOfCheck = async (baseline: boolean): Promise<number> => {
			const repo = await makeRepo();
			const config = testConfig({
				commands: { test: "echo ran >> ../checks.log" },
				gates: { baseline },
			});
			expect(await go(repo, config)).toBe(true);
			return readFile(repo, ".milhouse/work/checks.log").trim().split("\n").length;
		};
		expect((await runsOfCheck(true)) - (await runsOfCheck(false))).toBe(1);
	});

	it("lets the run go on when its checks pass", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const passing = testConfig({ commands: { test: "true" }, gates: { baseline: true } });
		expect(await go(repo, passing)).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
	});
});

describe("time limits from the config", () => {
	it("stops an agent call after the minutes set for its step", async () => {
		useFakeAgent({ sleep: { "Lead Investigator": 5_000 } });
		const repo = await makeRepo();
		const config = testConfig({ phases: { scan: { timeoutMinutes: 0.005 } } }); // 300 ms
		expect(await go(repo, config)).toBe(false);
		expect(output.join("\n")).toContain("timed out");
	});

	it("stops the run when maxMinutes is used up, and no call may outlast it", async () => {
		const fake = useFakeAgent({ sleep: { "Lead Investigator": 5_000 } });
		const repo = await makeRepo();
		const started = Date.now();
		expect(await go(repo, testConfig({ maxMinutes: 0.01 }))).toBe(false); // 600 ms
		expect(Date.now() - started).toBeLessThan(3_000); // the scan call was cut short, not waited for
		expect(output.join("\n")).toContain("time limit");
		expect(calls(fake, "Planner")).toHaveLength(0);
	});

	it("stops a check after commandTimeoutMinutes, and tells the executor", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({ commands: { test: "sleep 5" }, commandTimeoutMinutes: 0.005 });
		expect(await go(repo, config)).toBe(false);
		expect(calls(fake, "Executor")[1].prompt).toContain("timed out");
	});
});

describe("what agents and checks do to the worktree", () => {
	it("removes the setup marker of a worktree that an earlier version put inside the project", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		unsetEnv("MILHOUSE_WORK_DIR");
		const store = RunStore.create(repo, undefined, {
			branch: "main",
			sha: await revParse(repo, "HEAD"),
		});
		const old = join(repo, ".milhouse", "work", store.runId);
		await ensureWorktree(repo, old, store.ref, store.loadMeta().base_sha);
		writeFile(repo, `.milhouse/work/${store.runId}.ready`, "");
		await discardWorktree(store);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(`${old}.ready`)).toBe(false);
	});

	it("works in a worktree outside the project, and removes it when the run is complete", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		unsetEnv("MILHOUSE_WORK_DIR"); // the default place, in the user's cache folder (a temporary one here)
		const cache = tempDir();
		const home = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = cache;
		try {
			expect(await go(repo)).toBe(true);
			const store = latest(repo);
			const [executor] = calls(fake, "Executor");
			expect(executor.cwd.startsWith(repo)).toBe(false);
			expect(executor.cwd).toContain(store.runId);
			expect(store.worktree.startsWith(join(cache, "milhouse"))).toBe(true);
			expect(existsSync(store.worktree)).toBe(false);
		} finally {
			if (home === undefined) unsetEnv("XDG_CACHE_HOME");
			else process.env.XDG_CACHE_HOME = home;
		}
	});

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
		expect(allStatus(repo, "failed")).toBe(true);
	});

	it("never lets a commit make .milhouse a link either: its config would be run from elsewhere", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "milhouse-link" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(calls(fake, "Executor")[1].prompt).toContain("must never be modified: .milhouse");
		expect(allStatus(repo, "failed")).toBe(true);
	});

	it("protects the .milhouse/ of the project only, not one in a folder of an example", async () => {
		useFakeAgent({ exec: { "Add greeting": "nested-milhouse" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
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
