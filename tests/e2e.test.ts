/** The whole pipeline against a real git repository, with the fake agent standing in for Claude. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { isDirty, refExists } from "../src/git.ts";
import { acquireLock } from "../src/state.ts";
import {
	calls,
	cleanupTempDirs,
	commitFile,
	git,
	go,
	latest,
	mainSubjects,
	makeRepo,
	readFile,
	resetFakeAgentEnv,
	testConfig,
	useFakeAgent,
	writeFile,
} from "./helpers.ts";

beforeEach(() => {
	if (!process.env.DEBUG_TESTS) {
		spyOn(console, "log").mockImplementation(() => {});
		spyOn(console, "error").mockImplementation(() => {});
	}
});

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
	spyOn(console, "log").mockRestore();
	spyOn(console, "error").mockRestore();
});

describe("happy path", () => {
	it("takes an issue from scan to a fast-forward merge, checking everything on the way", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);

		const store = latest(repo);
		expect(store.loadMeta()).toMatchObject({
			status: "completed",
			done: ["scan", "validate", "plan", "consolidate", "exec", "merge"],
			base_branch: "main",
		});
		const tasks = store.loadTasks();
		expect(tasks.map((t) => t.status)).toEqual(["merged", "merged"]);
		expect(store.loadIssues().map((i) => i.status)).toEqual(["CONFIRMED"]);

		// One commit per task landed on the user's branch, in order, without a merge commit.
		const subjects = await mainSubjects(repo);
		expect(subjects.slice(0, 2)).toEqual(tasks.map((t) => `[${t.id}] ${t.title}`).reverse());
		expect(readFile(repo, `${tasks[0].id}.txt`)).toBe(`${tasks[0].title}\n`);
		expect(await git(repo, "log", "--merges", "--oneline")).toBe("");

		// Nothing is left behind.
		expect(await refExists(repo, store.ref)).toBe(false);
		expect(existsSync(store.worktree)).toBe(false);
		expect(await isDirty(repo)).toBe(false);
		expect(await git(repo, "branch", "--list", "mh-failed/*")).toBe("");

		// Every role ran once, in order, and was charged what it reported.
		expect(fake.journal().map((c) => c.role)).toEqual([
			"Lead Investigator",
			"Issue Validator",
			"Planner",
			"Consistency Manager",
			"Executor",
			"Truth Verifier",
		]);
		expect(store.loadCost().total).toBeCloseTo(0.06);
		expect(Object.keys(store.loadCost().byPhase).sort()).toEqual([
			"consolidate",
			"exec",
			"plan",
			"scan",
			"validate",
			"verify",
		]);
	});

	it("keeps agents isolated: read-only tools everywhere except the executor, which works in the run's worktree", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await go(repo);
		const store = latest(repo);
		for (const call of fake.journal()) {
			const writer = call.role === "Executor";
			expect(call.args).toContain("--strict-mcp-config");
			expect(call.args.includes("--dangerously-skip-permissions")).toBe(writer);
			expect(call.args.includes("--tools")).toBe(!writer);
			expect(call.cwd).toBe(writer || call.role === "Truth Verifier" ? store.worktree : repo);
		}
	});

	it("runs issues one after another, most severe first, each on top of the previous ones", async () => {
		const fake = useFakeAgent({
			scan: [
				{ title: "Low thing", severity: "LOW" },
				{ title: "Critical thing", severity: "CRITICAL" },
			],
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Executor").map((c) => c.issueTitle)).toEqual([
			"Critical thing",
			"Low thing",
		]);
		const subjects = (await mainSubjects(repo)).slice(0, 4).reverse();
		expect(subjects.map((s) => s.includes("Critical thing"))).toEqual([true, true, false, false]);
		const store = latest(repo);
		expect(store.loadTasks().every((t) => t.status === "merged")).toBe(true);
	});

	it("passes the scope to the scan and remembers it", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, testConfig(), { scope: "focus on auth" });
		expect(calls(fake, "Lead Investigator")[0].prompt).toContain("focus on auth");
		expect(latest(repo).loadMeta().scope).toBe("focus on auth");
	});

	it("completes cleanly when the scan finds nothing", async () => {
		const fake = useFakeAgent({ scan: [] });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(fake.journal()).toHaveLength(1);
		expect(latest(repo).loadMeta().status).toBe("completed");
	});

	it("does not plan an issue the validator calls false", async () => {
		const fake = useFakeAgent({ status: { "Add greeting": "FALSE" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Planner")).toHaveLength(0);
		expect(latest(repo).loadIssues()[0].status).toBe("FALSE");
	});
});

describe("repair loop", () => {
	it("feeds a placeholder back to the executor and accepts the fixed result", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "todo-first" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);

		const executor = calls(fake, "Executor");
		expect(executor).toHaveLength(2);
		expect(executor[0].prompt).not.toContain("The previous attempt failed");
		expect(executor[1].prompt).toContain("The previous attempt failed");
		expect(executor[1].prompt).toContain("TODO");
		const [task] = latest(repo).loadTasks();
		expect(readFile(repo, `${task.id}.txt`)).not.toContain("TODO");
		expect(calls(fake, "Truth Verifier")).toHaveLength(1); // only the fixed work was reviewed
	});

	it("sends back files left uncommitted in the worktree", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "junk-first" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Executor")[1].prompt).toContain(
			"Uncommitted changes are left in the worktree",
		);
		expect(existsSync(`${repo}/junk.txt`)).toBe(false);
	});

	it("sends the work back when the reviewer rejects it, then accepts the second try", async () => {
		const fake = useFakeAgent({ reject: { "Add greeting": 1 } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(2);
		expect(calls(fake, "Truth Verifier")).toHaveLength(2);
		expect(calls(fake, "Executor")[1].prompt).toContain("The reviewer rejected the work");
		expect(calls(fake, "Executor")[1].prompt).toContain("criteria not met");
	});

	it("asks the reviewer again when the review itself failed, without sending the executor back to work", async () => {
		const fake = useFakeAgent({ fail: { "Truth Verifier": { message: "overloaded", times: 1 } } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1);
		expect(calls(fake, "Truth Verifier")).toHaveLength(2);
	});

	it("sends back failing project checks and lets them run in the worktree", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		// `ls *.txt` only succeeds inside the worktree, where the executor's files are.
		const config = testConfig({ commands: { build: "true", test: "ls *.txt" } });
		expect(await go(repo, config)).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1);

		const failing = testConfig({ commands: { test: "echo broken >&2; exit 1" } });
		const repo2 = await makeRepo();
		const fake2 = useFakeAgent({});
		expect(await go(repo2, failing)).toBe(false);
		expect(calls(fake2, "Executor")[1].prompt).toContain("test failed");
		expect(calls(fake2, "Executor")[1].prompt).toContain("broken");
		expect(calls(fake2, "Truth Verifier")).toHaveLength(0); // the reviewer is only asked about work that passes the checks
	});

	it("skips the checks and the reviewer when the definition-of-done gate is off", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({ gates: { dod: false }, commands: { test: "exit 1" } });
		expect(await go(repo, config)).toBe(true);
		expect(calls(fake, "Truth Verifier")).toHaveLength(0);
	});

	it("lets a gate be switched off", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "todo-first" } });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ gates: { placeholder: false } }))).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1);
	});
});

describe("failures stay contained", () => {
	it("parks a failed issue, resets the worktree and carries on with the next issue", async () => {
		const fake = useFakeAgent({
			scan: [
				{ title: "Critical thing", severity: "CRITICAL" },
				{ title: "Low thing", severity: "LOW" },
			],
			exec: { "Critical thing": "never-commits" },
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);

		const store = latest(repo);
		expect(store.loadMeta().status).toBe("failed");
		const issues = new Map(store.loadIssues().map((i) => [i.title, i.id]));
		const byIssue = (title: string) =>
			store.loadTasks().filter((t) => t.issue_id === issues.get(title));
		expect(byIssue("Critical thing").map((t) => t.status)).toEqual(["failed", "failed"]);
		expect(byIssue("Critical thing")[0].error).toContain("no commit");
		expect(byIssue("Low thing").map((t) => t.status)).toEqual(["merged", "merged"]);

		// The low issue did not build on the failed attempt: none of its files reached main.
		const criticalFiles = byIssue("Critical thing").map((t) => `${t.id}.txt`);
		for (const file of criticalFiles) expect(existsSync(`${repo}/${file}`)).toBe(false);
		// The failed attempt is kept for inspection, including what was never committed.
		const parked = `mh-failed/${issues.get("Critical thing")}`;
		expect(await git(repo, "ls-tree", "-r", "--name-only", parked)).toContain(criticalFiles[0]);
		expect(calls(fake, "Executor")).toHaveLength(3); // critical twice (retry), low once
	});

	it("never merges work that touches a forbidden file, even when the rest is fine", async () => {
		useFakeAgent({ exec: { "Add greeting": "forbidden" } });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ neverTouch: ["secrets.env"] }))).toBe(false);
		const store = latest(repo);
		expect(store.loadTasks().every((t) => t.status === "failed")).toBe(true);
		expect(store.loadTasks()[0].error).toContain("secrets.env");
		expect(existsSync(`${repo}/secrets.env`)).toBe(false);
		expect(await mainSubjects(repo)).toEqual(["initial"]);
	});

	it("fails an issue whose setup command fails, without calling the agent", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ commands: { setup: "exit 4" } }))).toBe(false);
		expect(calls(fake, "Executor")).toHaveLength(0);
		expect(latest(repo).loadTasks()[0].error).toContain("setup failed");
		expect(existsSync(latest(repo).worktree)).toBe(false);
	});

	it("runs the setup command once, in the new worktree", async () => {
		useFakeAgent({ scan: [{ title: "One" }, { title: "Two" }] });
		const repo = await makeRepo();
		// Appends to a file outside the worktree (but inside .milhouse/, which is ignored).
		expect(await go(repo, testConfig({ commands: { setup: "echo ran >> ../setup-count" } }))).toBe(
			true,
		);
		expect(readFile(repo, ".milhouse/work/setup-count")).toBe("ran\n");
	});

	it("rejects evidence that was made up, and accepts it when the gate is off", async () => {
		const bogus = {
			"Add greeting": [
				{ file: "src/app.ts", line_start: 1, line_end: 2, snippet: "this text is not in the file" },
			],
		};
		useFakeAgent({ evidence: bogus });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(latest(repo).loadIssues()[0].status).toBe("UNVALIDATED");
		expect(latest(repo).loadTasks()).toEqual([]);

		useFakeAgent({ evidence: bogus });
		const repo2 = await makeRepo();
		expect(await go(repo2, testConfig({ gates: { evidence: false } }))).toBe(true);
	});
});

describe("budget and resume", () => {
	it("stops when the budget is used up and finishes the job after --resume", async () => {
		const fake = useFakeAgent({ cost: 0.01 });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ budget: 0.025 }))).toBe(false);

		const store = latest(repo);
		expect(store.loadMeta()).toMatchObject({
			status: "stopped",
			done: ["scan", "validate", "plan"],
		});
		expect(store.loadCost().total).toBeCloseTo(0.03);
		expect(await mainSubjects(repo)).toEqual(["initial"]);

		expect(await go(repo, testConfig({ budget: 0 }), { resume: true })).toBe(true);
		expect(latest(repo).runId).toBe(store.runId);
		expect(latest(repo).loadMeta().status).toBe("completed");
		expect(calls(fake, "Lead Investigator")).toHaveLength(1); // finished phases are not repeated
		expect((await mainSubjects(repo)).length).toBe(3);
	});

	it("retries what failed when resumed, without redoing what worked", async () => {
		const fake = useFakeAgent({ fail: { "Issue Validator": { message: "overloaded" } } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(latest(repo).loadMeta()).toMatchObject({ status: "failed", done: ["scan"] });

		process.env.FAKE_AGENT_SCENARIO = JSON.stringify({});
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(calls(fake, "Lead Investigator")).toHaveLength(1);
		expect(calls(fake, "Issue Validator")).toHaveLength(2);
		expect(latest(repo).loadMeta().status).toBe("completed");
	});

	it("retries a failed issue on resume with the old failure as feedback", async () => {
		const fake = useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "failed"),
		).toBe(true);

		process.env.FAKE_AGENT_SCENARIO = JSON.stringify({});
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		const executor = calls(fake, "Executor");
		expect(executor[executor.length - 1].prompt).toContain("The previous attempt failed");
		expect(executor[executor.length - 1].prompt).toContain("no commit");
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "merged"),
		).toBe(true);
		expect(await git(repo, "branch", "--list", "mh-failed/*")).toBe(""); // the stale parked attempt is gone
	});

	it("stops after the first failing phase when failFast is on", async () => {
		const fake = useFakeAgent({ fail: { "Issue Validator": { message: "overloaded" } } });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ failFast: true }))).toBe(false);
		expect(calls(fake, "Planner")).toHaveLength(0);
		expect(latest(repo).loadMeta().done).toEqual(["scan"]);
	});
});

describe("single phases", () => {
	it("--scan starts a run and later phases continue the latest one", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, testConfig(), { only: "scan", scope: "x" })).toBe(true);
		const run = latest(repo);
		expect(run.loadIssues()).toHaveLength(1);
		expect(run.loadMeta().status).toBe("stopped"); // paused: the rest of the pipeline is still to do

		expect(await go(repo, testConfig(), { only: "validate" })).toBe(true);
		expect(latest(repo).runId).toBe(run.runId);
		expect(latest(repo).loadIssues()[0].status).toBe("CONFIRMED");
		expect(calls(fake, "Lead Investigator")).toHaveLength(1);
	});

	it("refuses to continue a run that does not exist", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await expect(go(repo, testConfig(), { only: "validate" })).rejects.toThrow(
			/no run to continue/,
		);
		await expect(go(repo, testConfig(), { resume: true })).rejects.toThrow(/no run to continue/);
		await expect(go(repo, testConfig(), { resume: true, runId: "nope" })).rejects.toThrow(
			/not found/,
		);
	});
});

describe("merge", () => {
	const noMerge = () =>
		testConfig({ pipeline: ["scan", "validate", "plan", "consolidate", "exec"] });

	it("leaves verified work on its branch when merge is not in the pipeline, and merges it later", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		expect(store.loadTasks().every((t) => t.status === "verified")).toBe(true);
		expect(await mainSubjects(repo)).toEqual(["initial"]);
		expect(await refExists(repo, store.ref)).toBe(true);

		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "merged"),
		).toBe(true);
		expect((await mainSubjects(repo)).length).toBe(3);
	});

	it("makes a merge commit and re-checks the result when the branch moved during the run", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		await commitFile(repo, "other.txt", "someone else", "a commit made meanwhile");

		const config = testConfig({ commands: { test: "test -f other.txt && ls *.txt" } });
		expect(await go(repo, config, { only: "merge" })).toBe(true);
		expect(await git(repo, "log", "--merges", "--oneline")).not.toBe("");
		expect(existsSync(`${repo}/other.txt`)).toBe(true);
		const [task] = latest(repo).loadTasks();
		expect(existsSync(`${repo}/${task.id}.txt`)).toBe(true);
	});

	it("undoes a merge commit whose result breaks the checks: nothing broken stays on the branch", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		const moved = await commitFile(repo, "other.txt", "x", "a commit made meanwhile");
		const store = latest(repo);

		expect(await go(repo, testConfig({ commands: { test: "exit 1" } }), { only: "merge" })).toBe(
			false,
		);
		expect(await git(repo, "rev-parse", "HEAD")).toBe(moved); // the merge was taken back
		expect(await isDirty(repo)).toBe(false);
		expect(store.loadTasks().every((t) => t.status === "verified")).toBe(true);
		expect(await refExists(repo, store.ref)).toBe(true);

		// Once the checks pass the same work can still be merged.
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(store.loadTasks().every((t) => t.status === "merged")).toBe(true);
	});

	it("refuses a merge whose checks rewrote a tracked file: what lands is what was tested", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		const moved = await commitFile(repo, "other.txt", "broken\n", "a commit made meanwhile");
		const store = latest(repo);
		const errors: string[] = [];
		spyOn(console, "error").mockImplementation((...parts) => {
			errors.push(parts.join(" "));
		});

		// The linter repairs the file and the test passes only because it did: in the worktree, not in the commit.
		const fixing = testConfig({
			commands: { lint: "echo fixed > other.txt", test: "grep -q fixed other.txt" },
		});
		expect(await go(repo, fixing, { only: "merge" })).toBe(false);
		expect(errors.join("\n")).toContain("changed tracked files");
		expect(await git(repo, "rev-parse", "HEAD")).toBe(moved); // nothing was published
		expect(await git(repo, "log", "--merges", "--oneline")).toBe("");
		expect(await isDirty(repo)).toBe(false);
		expect(store.loadTasks().every((t) => t.status === "verified")).toBe(true);
		expect(await refExists(repo, store.ref)).toBe(true);

		// Commands that leave the files alone merge the same work.
		const readOnly = testConfig({ commands: { test: "test -f other.txt" } });
		expect(await go(repo, readOnly, { only: "merge" })).toBe(true);
		expect(await git(repo, "log", "--merges", "--oneline")).not.toBe("");
		expect(readFile(repo, "other.txt")).toBe("broken\n");
	});

	it("refuses to merge into another branch than the run started on", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		await git(repo, "checkout", "-q", "-b", "elsewhere");
		await expect(go(repo, testConfig(), { only: "merge" })).rejects.toThrow(/started on "main"/);
		await expect(go(repo, testConfig(), { resume: true })).rejects.toThrow(/started on "main"/);
		await git(repo, "checkout", "-q", "main");
		expect(await mainSubjects(repo)).toEqual(["initial"]);
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "verified"),
		).toBe(true);
	});

	it("keeps the verified work when the merge conflicts", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		const store = latest(repo);
		const [task] = store.loadTasks();
		await commitFile(repo, `${task.id}.txt`, "a different version\n", "conflicting change");
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(false);
		expect(await refExists(repo, store.ref)).toBe(true);
		expect(await isDirty(repo)).toBe(false);
		expect(
			latest(repo)
				.loadTasks()
				.every((t) => t.status === "verified"),
		).toBe(true);
	});
});

describe("preflight", () => {
	it("explains what is wrong before spending anything", async () => {
		const fake = useFakeAgent({});

		const notRepo = (await import("./helpers.ts")).tempDir();
		await expect(go(notRepo)).rejects.toThrow(/not a git repository/);

		const empty = (await import("./helpers.ts")).tempDir();
		await git(empty, "init", "-q");
		await expect(go(empty)).rejects.toThrow(/no commits/);

		const dirty = await makeRepo();
		writeFile(dirty, "src/app.ts", "changed");
		await expect(go(dirty)).rejects.toThrow(/uncommitted changes/);
		expect(await go(dirty, testConfig({ pipeline: ["scan"] }))).toBe(true); // reading does not need a clean tree

		const detached = await makeRepo();
		await git(detached, "checkout", "-q", "--detach");
		await expect(go(detached)).rejects.toThrow(/detached/);

		process.env.MILHOUSE_CLAUDE = "/nonexistent/claude";
		await expect(go(await makeRepo())).rejects.toThrow(/not found on PATH/);
		// merging needs no agent, so a missing binary is not what stops it
		await expect(go(await makeRepo(), testConfig(), { only: "merge" })).rejects.toThrow(
			/no run to continue/,
		);
		expect(fake.journal().filter((c) => c.role !== "Lead Investigator")).toHaveLength(0);
	});

	it("allows only one milhouse per repository", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const release = acquireLock(repo);
		await expect(go(repo)).rejects.toThrow(/Another milhouse is running/);
		release();
		expect(await go(repo)).toBe(true);
	});
});
