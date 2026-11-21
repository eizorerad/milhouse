/** Failure, crash and resume scenarios: the pipeline must never lose or fake work. */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	branchExists,
	currentBranch,
	deleteRef,
	ensureWorktree,
	refExists,
	revParse,
} from "../src/git.ts";
import {
	TWO_ISSUES,
	allStatus,
	calls,
	cleanupTempDirs,
	commitFile,
	git,
	go,
	latest,
	mainSubjects,
	makeRepo,
	noMerge,
	readFile,
	resetFakeAgentEnv,
	setScenario,
	silenceConsole,
	testConfig,
	useFakeAgent,
	writeFile,
} from "./helpers.ts";

silenceConsole();

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

describe("what an agent can and cannot do to the accepted work", () => {
	it("does not let a renamed protected file through the neverTouch gate", async () => {
		useFakeAgent({ exec: { "Add greeting": "rename-protected" } });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ neverTouch: ["src/app.ts"] }))).toBe(false);
		const [task] = latest(repo).loadTasks();
		expect(task.status).toBe("failed");
		expect(task.error).toContain("src/app.ts");
		expect(readFile(repo, "src/app.ts")).toContain("app = 1");
		expect(await mainSubjects(repo)).toEqual(["initial"]);
	});

	it("works when the agent commits on a branch of its own: the accepted ref is out of its reach", async () => {
		useFakeAgent({ exec: { "Add greeting": "own-branch" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
		expect(await git(repo, "branch", "--list", "mh/*")).toBe("");
		expect((await mainSubjects(repo)).length).toBe(3);
	});

	it("rejects work that drops commits which were already accepted", async () => {
		useFakeAgent({ ...TWO_ISSUES, exec: { "Low thing": "reset-history" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);

		const store = latest(repo);
		const issues = new Map(store.loadIssues().map((i) => [i.title, i.id]));
		const low = store.loadTasks().filter((t) => t.issue_id === issues.get("Low thing"));
		expect(low.every((t) => t.status === "failed")).toBe(true);
		expect(low[0].error).toContain("no longer part of HEAD");
		const critical = store.loadTasks().filter((t) => t.issue_id === issues.get("Critical thing"));
		expect(critical.every((t) => t.status === "merged")).toBe(true);
		expect((await mainSubjects(repo)).length).toBe(3); // initial + the critical issue's two tasks
	});

	it("does not let a scan title smuggle terminal escape sequences into the state", async () => {
		useFakeAgent({ scan: [{ title: "Evil \u001b]0;pwned\u0007title\u001b[2J" }] });
		const repo = await makeRepo();
		await go(repo, testConfig({ pipeline: ["scan"] }));
		expect(latest(repo).loadIssues()[0].title).toBe("Evil ]0;pwnedtitle[2J");
	});
});

describe("resuming", () => {
	it("continues from the merged state when some issues are still open", async () => {
		useFakeAgent({ ...TWO_ISSUES, exec: { "Critical thing": "never-commits" } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);

		const store = latest(repo);
		const head = await revParse(repo, "HEAD");
		expect(store.loadMeta().base_sha).toBe(head); // the run now starts from the merged state
		expect(await revParse(repo, store.ref)).toBe(head);
		expect(existsSync(store.worktree)).toBe(false); // no setup was run in it: it is made again in a moment
		expect((await mainSubjects(repo)).length).toBe(3); // initial + the low issue's two tasks

		setScenario(TWO_ISSUES);
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		// Built on top of what was merged, so the second merge is a plain fast-forward.
		expect(await git(repo, "log", "--merges", "--oneline")).toBe("");
		expect((await mainSubjects(repo)).length).toBe(5);
		expect(await refExists(repo, store.ref)).toBe(false);
		expect(allStatus(repo, "merged")).toBe(true);
	});

	it("discards what an interrupted session left in the worktree", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, testConfig({ pipeline: ["scan", "validate", "plan", "consolidate"] }));
		const store = latest(repo);

		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);
		await commitFile(store.worktree, "ghost.txt", "ghost", "[T-ghost] left by an interrupted run");
		writeFile(store.worktree, "dirty.txt", "dirty");

		expect(await go(repo, testConfig(), { only: "exec" })).toBe(true);
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(existsSync(`${repo}/ghost.txt`)).toBe(false);
		expect(existsSync(`${repo}/dirty.txt`)).toBe(false);
		expect((await mainSubjects(repo)).some((s) => s.includes("T-ghost"))).toBe(false);
	});

	it("discards it also when the session was killed in the middle of a git command, which left its lock", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, testConfig({ pipeline: ["scan", "validate", "plan", "consolidate"] }));
		const store = latest(repo);

		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);
		await commitFile(store.worktree, "ghost.txt", "ghost", "[T-ghost] left by an interrupted run");
		writeFile(store.worktree, "dirty.txt", "dirty");
		const gitDir = await git(store.worktree, "rev-parse", "--absolute-git-dir");
		writeFileSync(join(gitDir, "index.lock"), "");

		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
		expect(existsSync(`${repo}/ghost.txt`)).toBe(false);
		expect(existsSync(`${repo}/dirty.txt`)).toBe(false);
		expect((await mainSubjects(repo)).some((s) => s.includes("T-ghost"))).toBe(false);
	});

	it("keeps the git settings that the caller passes through the environment, for the agents too", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		Object.assign(process.env, {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "From The Caller",
		});
		try {
			expect(await go(repo)).toBe(true);
			expect(await git(repo, "log", "-1", "--format=%an")).toBe("From The Caller"); // the agent's commit
		} finally {
			for (const name of ["COUNT", "KEY_0", "VALUE_0"]) delete process.env[`GIT_CONFIG_${name}`];
		}
	});

	it("does not tell the executor to fix an outage: the next attempt gets the tasks, not the error", async () => {
		const fake = useFakeAgent({
			fail: { Executor: { message: "API Error: 529 Overloaded", times: 1 } },
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		const prompts = calls(fake, "Executor").map((call) => call.prompt);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).not.toContain("The previous attempt failed");
		expect(prompts[1]).not.toContain("529");
		expect(prompts[1]).toContain("Tasks to do, in this order");
	});

	it("says that the accepted work is missing when its ref was lost, although a worktree is still there", async () => {
		useFakeAgent({ ...TWO_ISSUES, exec: { "Low thing": "never-commits" } });
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(false); // one issue accepted, one failed
		const store = latest(repo);
		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);
		await deleteRef(repo, store.ref);

		expect(await go(repo, noMerge(), { resume: true })).toBe(false); // an answer, not a git error thrown
		expect(store.loadTasks().find((t) => t.status === "failed")?.error).toContain(
			"is missing although tasks were verified",
		);
		expect(store.loadMeta().status).toBe("failed");
	});

	it("does not redo an issue that was accepted but never recorded (a crash in between)", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		const store = latest(repo);
		store.updateTasks(
			store.loadTasks().map((t) => t.id),
			{ status: "pending" },
		);

		expect(await go(repo, noMerge(), { only: "exec" })).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1);
		expect(calls(fake, "Truth Verifier")).toHaveLength(1);
		expect(allStatus(repo, "verified")).toBe(true);
	});

	it("keeps finished work when only the review failed, and asks just for the review on resume", async () => {
		const fake = useFakeAgent({ fail: { "Truth Verifier": { message: "overloaded", times: 99 } } });
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);

		const store = latest(repo);
		expect(allStatus(repo, "failed")).toBe(true);
		expect(store.loadTasks()[0].error).toContain("The review could not be completed");
		expect(calls(fake, "Executor")).toHaveLength(1); // the executor was not sent back to work
		expect(await branchExists(repo, `mh-failed/${store.loadIssues()[0].id}`)).toBe(true);

		setScenario({});
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1); // nothing was redone
		expect(calls(fake, "Truth Verifier")).toHaveLength(3);
		expect((await mainSubjects(repo)).some((s) => s.includes("wip"))).toBe(false);
		expect(await git(repo, "branch", "--list", "mh-failed/*")).toBe("");
	});

	it("waits for what an issue depends on instead of building on missing work", async () => {
		const scenario = {
			scan: [
				{ title: "Base thing", severity: "HIGH" },
				{ title: "Dependent thing", severity: "LOW" },
			],
			cross: [["Dependent thing", "Base thing"]],
			exec: { "Base thing": "never-commits" },
		};
		const fake = useFakeAgent(scenario);
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);

		expect(calls(fake, "Executor").map((c) => c.issueTitle)).toEqual(["Base thing", "Base thing"]);
		const dependent = latest(repo)
			.loadTasks()
			.filter((t) => t.title.startsWith("Dependent"));
		expect(dependent.length).toBeGreaterThan(0);
		expect(dependent.every((t) => t.status === "pending" && t.error === undefined)).toBe(true);

		setScenario({});
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
		expect(calls(fake, "Executor").map((c) => c.issueTitle)).toEqual([
			"Base thing",
			"Base thing",
			"Base thing",
			"Dependent thing",
		]);
	});
});

describe("budget", () => {
	it("keeps the work when the budget runs out before the review, and reviews it after the budget is raised", async () => {
		const fake = useFakeAgent({ cost: 0.01 });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ budget: 0.045 }))).toBe(false);

		expect(allStatus(repo, "failed")).toBe(true);
		expect(latest(repo).loadTasks()[0].error).toContain("budget");
		expect(calls(fake, "Truth Verifier")).toHaveLength(0);

		expect(await go(repo, testConfig({ budget: 0 }), { resume: true })).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1);
		expect(calls(fake, "Truth Verifier")).toHaveLength(1);
		expect(allStatus(repo, "merged")).toBe(true);
	});

	it("merges what was accepted when a resume finds the budget spent before it starts", async () => {
		const fake = useFakeAgent({
			...TWO_ISSUES,
			cost: 0.01,
			exec: { "Low thing": "never-commits" },
		});
		const repo = await makeRepo();
		expect(await go(repo, noMerge())).toBe(false); // "Critical thing" is accepted, "Low thing" failed
		const executorCalls = calls(fake, "Executor").length;

		expect(await go(repo, testConfig({ budget: 0.01 }), { resume: true })).toBe(false);
		expect(calls(fake, "Executor")).toHaveLength(executorCalls); // no money, no new call
		expect((await mainSubjects(repo)).some((s) => s.includes("Critical thing part 1"))).toBe(true);
		const byStatus = latest(repo)
			.loadTasks()
			.map((t) => t.status)
			.sort();
		expect(byStatus).toEqual(["failed", "failed", "merged", "merged"]);
	});

	it("still merges, and calls the run complete, when the budget ran out during the last step", async () => {
		useFakeAgent({ cost: 0.01 });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ budget: 0.055 }))).toBe(true);
		expect(latest(repo).loadMeta().status).toBe("completed");
		expect(allStatus(repo, "merged")).toBe(true);
	});
});

describe("merge: tested before it touches your branch", () => {
	const headFile = (repo: string) => `${repo}/.milhouse/work/head-during-checks`;

	it("keeps the branch where it was while the merge commit is being checked", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({
			commands: { test: "git -C ../../.. rev-parse HEAD > ../head-during-checks" },
		});
		await go(repo, { ...config, pipeline: noMerge().pipeline });
		const moved = await commitFile(repo, "other.txt", "x", "a commit made meanwhile");

		expect(await go(repo, config, { only: "merge" })).toBe(true);
		expect(readFile(repo, ".milhouse/work/head-during-checks").trim()).toBe(moved);
		expect(await git(repo, "rev-parse", "HEAD")).not.toBe(moved); // published only afterwards
		expect(await git(repo, "log", "--merges", "--oneline")).not.toBe("");
		expect(existsSync(headFile(repo))).toBe(true);
	});

	it("never loses a commit the user makes while the merge is being checked", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		await commitFile(repo, "other.txt", "x", "a commit made meanwhile");
		// While the checks of the merge run, the user commits to the branch.
		writeFile(repo, ".milhouse/work/go", "");
		const racing = testConfig({
			commands: {
				test: "test -f ../go && git -C ../../.. commit --allow-empty -q -m 'user commit during checks'; true",
			},
		});
		expect(await go(repo, racing, { only: "merge" })).toBe(false);
		expect((await mainSubjects(repo))[0]).toBe("user commit during checks");
		expect(await git(repo, "log", "--merges", "--oneline")).toBe("");
		expect(allStatus(repo, "verified")).toBe(true);

		// Run again without the race: the work merges on top of the user's commit.
		writeFile(repo, ".milhouse/work/go2", "");
		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(await mainSubjects(repo)).toContain("user commit during checks");
		expect(allStatus(repo, "merged")).toBe(true);
	});

	it("merges even when git is configured to squash by default", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await git(repo, "config", "branch.main.mergeOptions", "--squash");
		expect(await go(repo)).toBe(true);
		expect((await mainSubjects(repo)).length).toBe(3);
		expect(allStatus(repo, "merged")).toBe(true);
	});

	it("moves the run's starting point after a merge even when another issue never got planned", async () => {
		const bogus = [{ file: "src/app.ts", line_start: 1, line_end: 2, snippet: "not in the file" }];
		useFakeAgent({
			scan: [
				{ title: "Good thing", severity: "HIGH" },
				{ title: "Bad evidence", severity: "LOW" },
			],
			evidence: { "Bad evidence": bogus },
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false); // the second issue could not be validated

		const store = latest(repo);
		const head = await revParse(repo, "HEAD");
		expect(store.loadMeta().base_sha).toBe(head);
		expect(await revParse(repo, store.ref)).toBe(head);

		setScenario({
			scan: [
				{ title: "Good thing", severity: "HIGH" },
				{ title: "Bad evidence", severity: "LOW" },
			],
		});
		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		expect(await git(repo, "log", "--merges", "--oneline")).toBe(""); // built on the merged state
		expect((await mainSubjects(repo)).length).toBe(5);
	});
});

describe("a folder where the worktree should be", () => {
	it("is not taken for the worktree: the merge leaves the user's branch and edits alone", async () => {
		useFakeAgent({});
		const repo = await makeRepo(); // the tests keep their worktrees inside the repository
		writeFile(repo, ".milhouse/config.ts", "export default {};\n");
		await git(repo, "add", "-f", ".milhouse/config.ts");
		await git(repo, "commit", "-q", "-m", "config");
		expect(await go(repo, noMerge())).toBe(true);
		const store = latest(repo);
		expect(existsSync(store.worktree)).toBe(false);
		mkdirSync(store.worktree, { recursive: true }); // a plain folder: git would work on the project here
		writeFile(repo, ".milhouse/config.ts", "export default { budget: 1 };\n"); // not committed

		expect(await go(repo, testConfig(), { only: "merge" })).toBe(true);
		expect(await currentBranch(repo)).toBe("main");
		expect(readFile(repo, ".milhouse/config.ts")).toContain("budget: 1");
		expect(allStatus(repo, "merged")).toBe(true);
	});
});

describe("exec: what the checks must not do", () => {
	it("rejects checks that rewrite tracked files: the tested state would not be the committed one", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({ commands: { lint: "echo '// reformatted' >> src/app.ts" } });
		expect(await go(repo, config)).toBe(false);
		// The first attempt is sent back with exactly this reason.
		expect(calls(fake, "Executor")[1].prompt).toContain("Running the checks changed tracked files");
		expect(latest(repo).loadTasks()[0].status).toBe("failed");
		expect(await mainSubjects(repo)).toEqual(["initial"]);
	});

	it("does not deadlock when two issues depend on each other: they run in severity order", async () => {
		useFakeAgent({
			scan: [
				{ title: "A thing", severity: "HIGH" },
				{ title: "B thing", severity: "LOW" },
			],
			crossTasks: [
				["A thing part 2", "B thing part 1"],
				["B thing part 2", "A thing part 1"],
			],
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		expect(allStatus(repo, "merged")).toBe(true);
		expect((await mainSubjects(repo)).length).toBe(5);
	});
});

describe("worktree preparation, artifacts and a branch that changes under the merge", () => {
	it("runs setup again when the worktree has to be recreated, for example for a merge", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const config = testConfig({ commands: { setup: "echo ran >> ../setup-count" } });
		await go(repo, { ...config, pipeline: noMerge().pipeline });
		expect(readFile(repo, ".milhouse/work/setup-count")).toBe("ran\n");
		expect(existsSync(latest(repo).worktree)).toBe(false); // removed when the run completed

		await commitFile(repo, "other.txt", "x", "a commit made meanwhile"); // forces a tested merge commit
		expect(await go(repo, config, { only: "merge" })).toBe(true);
		// Set up when the worktree was recreated, and again on the merged commit: the branch may have
		// changed what has to be installed (a lockfile), and the checks must see exactly that.
		expect(readFile(repo, ".milhouse/work/setup-count")).toBe("ran\nran\nran\n");
	});

	it("runs setup again when an earlier setup never finished", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, testConfig({ pipeline: ["scan", "validate", "plan", "consolidate"] }));
		const store = latest(repo);
		// A worktree that exists but whose setup was interrupted (no marker).
		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);

		const config = testConfig({ commands: { setup: "echo ran >> ../setup-count" } });
		expect(await go(repo, config, { only: "exec" })).toBe(true);
		expect(readFile(repo, ".milhouse/work/setup-count")).toBe("ran\n");
	});

	it("does not treat files the checks create as part of the work: a retry is not sent back for them", async () => {
		const fake = useFakeAgent({ fail: { "Truth Verifier": { message: "overloaded", times: 1 } } });
		const repo = await makeRepo();
		const config = testConfig({ commands: { test: "echo out > artifact.log" } });
		expect(await go(repo, config)).toBe(true);
		expect(calls(fake, "Executor")).toHaveLength(1); // the retry only asked for the review again
		expect(existsSync(`${repo}/artifact.log`)).toBe(false);
	});

	it("does not merge into another branch when the user switches while the merge is being checked", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		await commitFile(repo, "other.txt", "x", "a commit made meanwhile");
		writeFile(repo, ".milhouse/work/go", "");
		const switching = testConfig({
			commands: { test: "test -f ../go && git -C ../../.. switch -q -c elsewhere; true" },
		});
		expect(await go(repo, switching, { only: "merge" })).toBe(false);
		expect(await git(repo, "rev-parse", "main")).toBe(await git(repo, "rev-parse", "elsewhere"));
		expect(await git(repo, "log", "--merges", "--oneline", "elsewhere")).toBe("");
		expect(allStatus(repo, "verified")).toBe(true);
	});

	it("leaves the user's staged edits alone when the branch moved and the merge cannot be published", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await go(repo, noMerge());
		await commitFile(repo, "other.txt", "x", "a commit made meanwhile");
		writeFile(repo, ".milhouse/work/go", "");
		const racing = testConfig({
			commands: {
				// While the checks run, the user stages an edit and commits something else.
				test: "test -f ../go && cd ../../.. && echo staged >> src/app.ts && git add src/app.ts && echo y > y.txt && git add y.txt && git commit -q -m 'user work' -- y.txt; true",
			},
		});
		expect(await go(repo, racing, { only: "merge" })).toBe(false);
		expect(await git(repo, "diff", "--cached", "--name-only")).toBe("src/app.ts"); // still staged
		expect(readFile(repo, "src/app.ts")).toContain("staged");
	});
});

describe("issue order with circular dependencies", () => {
	it("starts a cycle at one of its members, never at an issue that only depends on it", async () => {
		useFakeAgent({
			scan: [
				{ title: "C thing", severity: "CRITICAL" },
				{ title: "A thing", severity: "HIGH" },
				{ title: "B thing", severity: "LOW" },
			],
			crossTasks: [
				["C thing part 1", "A thing part 1"], // C depends on A
				["A thing part 2", "B thing part 1"], // A and B depend on each other
				["B thing part 2", "A thing part 1"],
			],
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(true);
		const subjects = (await mainSubjects(repo)).reverse().slice(1); // oldest first, without "initial"
		const firstOf = (title: string) => subjects.findIndex((s) => s.includes(title));
		expect(firstOf("A thing")).toBeLessThan(firstOf("C thing")); // C builds on A
	});
});
