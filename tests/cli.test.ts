/** The real CLI as a subprocess: argument handling, --init, reports and one full run. */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { ensureWorktree, refExists } from "../src/git.ts";
import { acquireLock } from "../src/lock.ts";
import { RunStore } from "../src/state.ts";
import {
	ENTRY,
	TWO_ISSUES,
	alive,
	calls,
	cleanupTempDirs,
	commitFile,
	flag,
	git,
	isAscii,
	makeRepo,
	milhouse,
	resetFakeAgentEnv,
	tempDir,
	useFakeAgent,
	waitFor,
} from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

/** A run on a repository without checks, which milhouse refuses unless it is told to go on. */
const unchecked = (repo: string, ...args: string[]) => milhouse(repo, "--allow-unchecked", ...args);

describe("arguments", () => {
	it("prints the help without arguments, with --help and with -h", async () => {
		const dir = tempDir();
		for (const args of [[], ["--help"], ["-h"]]) {
			const result = await milhouse(dir, ...args);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Usage:");
			expect(result.stdout).toContain("milhouse --resume");
			expect(isAscii(result.stdout)).toBe(true); // it must read well in any terminal
		}
	});

	it("prints the version", async () => {
		const result = await milhouse(tempDir(), "--version");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(pkg.version);
	});

	it("rejects unknown flags instead of starting a paid run (a typo must never run the pipeline)", async () => {
		for (const bad of ["--nope", "--rsume", "--versoin", "-x"]) {
			const fake = useFakeAgent({});
			const repo = await makeRepo();
			const result = await milhouse(repo, bad);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain('Run "milhouse --help"');
			expect(fake.journal()).toHaveLength(0);
		}
	});

	it("rejects bad option values and conflicting phases", async () => {
		const dir = tempDir();
		expect((await milhouse(dir, "--run", "--workers", "abc")).code).toBe(2);
		expect((await milhouse(dir, "--run", "--workers", "0")).code).toBe(2);
		const two = await milhouse(dir, "--scan", "--exec");
		expect(two.code).toBe(2);
		expect(two.stderr).toContain("Pick one phase");
		const both = await milhouse(dir, "--report", "--clean");
		expect(both.code).toBe(2);
		expect(both.stderr).toContain("Pick one of: --report, --clean");
	});

	it("rejects an invalid config with a clear message", async () => {
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(join(repo, ".milhouse", "config.ts"), "export default { budgetLimit: 5 };");
		const result = await unchecked(repo, "--run");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("budgetLimit");
	});
});

describe("--init, --list-runs, --report, --clean", () => {
	it("treats bare init as setup even with uncommitted changes, without starting agents", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		writeFileSync(join(repo, "src/app.ts"), "work in progress");
		const result = await milhouse(repo, "init");
		expect(result.code).toBe(0);
		const config = join(repo, ".milhouse", "config.ts");
		expect(existsSync(config)).toBe(true);
		writeFileSync(config, "export default { budget: 7 };");
		for (const args of [["-v", "init"], ["--init"]]) {
			const repeat = await milhouse(repo, ...args);
			expect(repeat.code).toBe(0);
			expect(repeat.stdout).toContain("already exists");
		}
		expect(readFileSync(config, "utf8")).toBe("export default { budget: 7 };");
		expect(RunStore.list(repo)).toHaveLength(0);
		expect(fake.journal()).toHaveLength(0);
	});

	it("writes the commands that the project defines into the config it creates", async () => {
		const repo = await makeRepo();
		writeFileSync(join(repo, "package.json"), '{"scripts": {"test": "node --test"}}');
		const result = await milhouse(repo, "init");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("test: npm run test");
		const config = readFileSync(join(repo, ".milhouse", "config.ts"), "utf8");
		expect(config).toContain('test: "npm run test"');
		expect(config).toContain('setup: "npm install"');
	});

	it("keeps init in longer task descriptions and explicit run scopes", async () => {
		useFakeAgent({ scan: [] });
		for (const [args, scope] of [
			[["init", "a", "project"], "init a project"],
			[["--scan", "init"], "init"],
			[["--scope", "init"], "init"],
		] as const) {
			const repo = await makeRepo();
			expect((await unchecked(repo, ...args)).code).toBe(0);
			expect(RunStore.latest(repo)?.loadMeta().scope).toBe(scope);
		}
	});

	it("creates the config in a folder that git does not see: there is nothing to commit", async () => {
		const repo = await makeRepo();
		const first = await milhouse(repo, "--init");
		expect(first.code).toBe(0);
		expect(existsSync(join(repo, ".milhouse", "config.ts"))).toBe(true);
		expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
		// Whoever wants to share the settings can still commit them.
		await git(repo, "add", "-f", ".milhouse/config.ts");
		expect(await git(repo, "status", "--porcelain")).toBe("A  .milhouse/config.ts");
		await git(repo, "reset", "-q");

		const second = await milhouse(repo, "--init");
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("already exists");
	});

	it("handles an empty state", async () => {
		const dir = tempDir();
		expect((await milhouse(dir, "--list-runs")).stdout).toContain("No runs yet");
		expect((await milhouse(dir, "--clean")).stdout).toContain("Nothing to clean");
		const report = await milhouse(dir, "--report");
		expect(report.code).toBe(2);
		expect(report.stderr).toContain("no runs yet");
	});
});

describe("--clean", () => {
	/** A failed run, aged 40 days, whose worktree is still there (as after a killed run). */
	async function oldRunWithLeftovers(repo: string): Promise<RunStore> {
		expect((await unchecked(repo, "--run")).code).toBe(1);
		const store = RunStore.latest(repo) as RunStore;
		expect(existsSync(store.worktree)).toBe(false); // a failed issue is parked on its branch, not kept here
		await ensureWorktree(repo, store.worktree, store.ref, store.loadMeta().base_sha);
		const metaPath = join(repo, ".milhouse", "runs", store.runId, "meta.json");
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		meta.created_at = new Date(Date.now() - 40 * 86_400_000).toISOString();
		writeFileSync(metaPath, JSON.stringify(meta));
		return store;
	}

	it("removes old finished runs with their leftover worktree and ref, keeps recent ones", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		expect((await unchecked(repo, "--run")).code).toBe(1);
		expect((await milhouse(repo, "--clean")).stdout).toContain("Nothing to clean"); // too recent
		expect((await milhouse(repo, "--clean", "--days", "-1")).code).toBe(2);

		const store = await oldRunWithLeftovers(repo);
		const result = await milhouse(repo, "--clean");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(store.runId);
		expect(existsSync(store.worktree)).toBe(false);
		expect(await refExists(repo, store.ref)).toBe(false);
		expect(RunStore.list(repo).map((r) => r.id)).not.toContain(store.runId);
	});

	it("does not clean while another milhouse works in the checkout: it could be resuming that very run", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		const store = await oldRunWithLeftovers(repo);
		const release = acquireLock(repo); // this process stands in for the other milhouse
		const result = await milhouse(repo, "--clean");
		release();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Another milhouse is running");
		expect(existsSync(store.worktree)).toBe(true);
		expect(RunStore.list(repo).map((r) => r.id)).toContain(store.runId);
	});

	it("keeps a run whose worktree somebody locked, and says so", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		const store = await oldRunWithLeftovers(repo);
		await git(repo, "worktree", "lock", store.worktree);

		const result = await milhouse(repo, "--clean");
		expect(result.code).toBe(1);
		expect(result.stdout + result.stderr).toContain("locked");
		expect(existsSync(store.worktree)).toBe(true);
		expect(RunStore.list(repo).map((r) => r.id)).toContain(store.runId);
	});

	/** Ages the latest run by 40 days. */
	function age(repo: string): RunStore {
		const store = RunStore.latest(repo) as RunStore;
		const metaPath = join(repo, ".milhouse", "runs", store.runId, "meta.json");
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		meta.created_at = new Date(Date.now() - 40 * 86_400_000).toISOString();
		writeFileSync(metaPath, JSON.stringify(meta));
		return store;
	}

	it("keeps a run whose accepted work was never merged, so that --merge still finds it", async () => {
		useFakeAgent({ ...TWO_ISSUES, exec: { "Low thing": "never-commits" } });
		const repo = await makeRepo();
		expect((await unchecked(repo, "--run")).code).toBe(1); // one issue accepted, one failed
		const store = age(repo);

		const kept = await milhouse(repo, "--clean");
		expect(kept.code).toBe(1);
		expect(kept.stdout + kept.stderr).toContain("accepted work that was never merged");
		expect(kept.stdout + kept.stderr).toContain(`milhouse --merge --run-id ${store.runId}`);
		expect(await refExists(repo, store.ref)).toBe(true);

		expect((await milhouse(repo, "--merge", "--run-id", store.runId)).code).toBe(0);
		expect(await git(repo, "log", "--format=%s", "main")).toContain("Critical thing part 1");
		// Nothing of it is waiting any more. The other issue failed, so the run is not finished: --all.
		expect((await milhouse(repo, "--clean", "--all")).code).toBe(0);
		expect(RunStore.list(repo)).toEqual([]);
		expect(await refExists(repo, store.ref)).toBe(false);
	});

	it("removes the failed attempts that a run parked, together with the run", async () => {
		useFakeAgent({ exec: { "Add greeting": "todo-first" }, reject: { "Add greeting": 99 } });
		const repo = await makeRepo();
		expect((await unchecked(repo, "--run")).code).toBe(1);
		expect(await git(repo, "branch", "--list", "mh-failed/*")).not.toBe("");
		age(repo);

		expect((await milhouse(repo, "--clean", "--days", "0")).code).toBe(0); // 0: whatever its age
		expect(await git(repo, "branch", "--list", "mh-failed/*")).toBe("");
		expect(await git(repo, "for-each-ref", "refs/milhouse")).toBe("");
	});

	it("takes an old run that was stopped or killed only with --all", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		expect((await unchecked(repo, "--scan")).code).toBe(0); // one phase: the run is "stopped"
		const store = age(repo);
		expect(store.loadMeta().status).toBe("stopped");

		expect((await milhouse(repo, "--clean")).stdout).toContain("Nothing to clean");
		const all = await milhouse(repo, "--clean", "--all");
		expect(all.code).toBe(0);
		expect(all.stdout).toContain(store.runId);
		expect(RunStore.list(repo)).toEqual([]);
	});
});

describe("the first run in a project", () => {
	it("sets the project up by itself: the commands it defines are found, run and trusted for the merge", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await commitFile(repo, "Makefile", "test:\n\ttrue\n", "a project with a test command");

		const result = await milhouse(repo, "improve the greeting"); // no init, no flag
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Created .milhouse/config.ts");
		expect(result.stdout).toContain("test: make test");
		expect(readFileSync(join(repo, ".milhouse", "config.ts"), "utf-8")).toContain(
			'test: "make test"',
		);
		expect(calls(fake, "Executor")).toHaveLength(1);
		// Checked by the project's own command, so it merged; and nothing is left to commit or to clean up.
		expect(await git(repo, "log", "--format=%s", "main")).toContain("Add greeting part 1");
		expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");

		// What was found and done is on the screen: nobody has to ask for the report.
		expect(result.stdout).toContain("1 found: 1 confirmed");
		expect(result.stdout).toContain("2 total: 2 merged");

		const again = await milhouse(repo, "--list-runs"); // the config is written once
		expect(again.stdout).not.toContain("Created");
		expect((await milhouse(repo, "something else")).stdout).not.toContain("Created");
	});

	it("says what is missing when the project defines no command to check the work with", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const result = await milhouse(repo, "improve the greeting");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("No build, lint or test command was found");
		expect(result.stderr).toContain("--allow-unchecked");
		expect(fake.journal()).toHaveLength(0);
		expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
	});
});

describe("what the user does not have to put right", () => {
	const withTests = async (makefile = "test:\n\ttrue\n"): Promise<string> => {
		const repo = await makeRepo();
		await commitFile(repo, "Makefile", makefile, "a project with a test command");
		return repo;
	};
	const config = (repo: string) => readFileSync(join(repo, ".milhouse", "config.ts"), "utf-8");

	it("names the agent that is installed when Claude Code is not", async () => {
		useFakeAgent({});
		process.env.MILHOUSE_CLAUDE = "/nonexistent/claude";
		const repo = await withTests();
		const result = await milhouse(repo, "improve the greeting");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("the config names Codex as the agent");
		expect(config(repo)).toContain('harness: "codex",');
		expect(await git(repo, "log", "--format=%s", "main")).toContain("Add greeting part 1");
	});

	it("looks for the commands again when the config has none: the project may have got its tests since", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "init");
		expect(config(repo)).toContain('test: ""');
		await commitFile(repo, "Makefile", "test:\n\ttrue\n", "the first test");

		const result = await milhouse(repo, "improve the greeting");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("sets no build, lint or test command");
		expect(result.stdout).toContain("test: make test");
		expect(await git(repo, "log", "--format=%s", "main")).toContain("Add greeting part 1"); // checked, so merged
	});

	it("takes the limits of one command from the command line", async () => {
		useFakeAgent({ cost: 0.01 });
		const repo = await withTests();
		const stopped = await milhouse(repo, "improve the greeting", "--budget", "0.025");
		expect(stopped.code).toBe(1);
		expect(stopped.stdout).toContain("milhouse --resume --budget <usd>");
		expect((await milhouse(repo, "--resume", "--budget", "0")).code).toBe(0);
		expect(await git(repo, "log", "--format=%s", "main")).toContain("Add greeting part 1");

		for (const flag of ["--budget", "--max-tokens", "--max-minutes"]) {
			const bad = await milhouse(repo, "--resume", flag, "lots");
			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain(`${flag} must be a number of 0 or more`);
		}
	});

	it("starts on a commit whose checks fail when it is told that this is what the run is for", async () => {
		const fake = useFakeAgent({});
		const repo = await withTests("test:\n\tfalse\n");
		const refused = await milhouse(repo, "make the tests pass");
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--no-baseline");
		expect(fake.journal()).toHaveLength(0);

		await milhouse(repo, "make the tests pass", "--no-baseline");
		expect(calls(fake, "Executor").length).toBeGreaterThan(0);
	});
});

describe("a full run through the CLI", () => {
	it("runs the pipeline, then lists and reports the run", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");

		const result = await unchecked(repo, "improve the greeting");
		expect(result.code).toBe(0);
		const store = RunStore.latest(repo) as RunStore;
		expect(result.stdout).toContain(`milhouse --merge --run-id ${store.runId}`);
		expect(await git(repo, "log", "--format=%s", "main")).toBe("initial");
		expect((await milhouse(repo, "--report")).stdout).toContain("2 verified");
		expect((await milhouse(repo, "--merge", "--run-id", store.runId)).code).toBe(0);

		const list = await milhouse(repo, "--list-runs");
		expect(list.stdout).toContain("completed");
		expect(list.stdout).toContain("improve the greeting");

		const text = await milhouse(repo, "--report");
		expect(text.stdout).toContain("1 found: 1 confirmed");
		expect(text.stdout).toContain("2 total: 2 merged");
		expect(text.stdout).toContain("$0.06");

		const md = await milhouse(repo, "--report", "--format", "md");
		expect(md.stdout).toContain("# Milhouse run report");
		expect(md.stdout).toContain("## Tasks");

		// What was found and what became of it, not only how many.
		const [task] = store.loadTasks();
		expect(text.stdout).toContain("Add greeting (confirmed");
		expect(text.stdout).toContain(`${task.title} ${task.sha?.slice(0, 8)}`);
		const json = JSON.parse((await milhouse(repo, "--report", "--format", "json")).stdout);
		expect(json.details[0].tasks[0]).toEqual({
			title: task.title,
			status: "merged",
			sha: task.sha,
		});
		const unknown = await milhouse(repo, "--report", "--format", "xml");
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain("--format must be one of: terminal, md, json");
	});

	it("shows the plan before anything is changed: phase by phase, the report, then --resume", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect((await unchecked(repo, "--scan", "improve the greeting")).code).toBe(0);
		for (const phase of ["--validate", "--plan", "--consolidate"]) {
			expect((await unchecked(repo, phase)).code).toBe(0);
		}
		const plan = (await milhouse(repo, "--report")).stdout;
		expect(plan).toContain("[MEDIUM] Add greeting (confirmed: ok)");
		expect(plan).toMatch(/pending +Add greeting part 1\n/);
		expect(calls(fake, "Executor")).toHaveLength(0);

		expect((await unchecked(repo, "--resume")).code).toBe(0);
		expect(calls(fake, "Executor")).toHaveLength(1);
		expect(RunStore.list(repo)).toHaveLength(1); // one run all along
	});

	it("refuses a scope for a run that continues: the run keeps the one it started with", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect((await unchecked(repo, "--scan", "improve the greeting")).code).toBe(0);
		const before = fake.journal().length;
		for (const args of [
			["--resume", "something else"],
			["--plan", "--scope", "something else"],
		]) {
			const result = await unchecked(repo, ...args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("A run keeps the scope it started with");
		}
		expect(fake.journal()).toHaveLength(before);
		expect((RunStore.latest(repo) as RunStore).loadMeta().scope).toBe("improve the greeting");
	});

	it("continues the run that --run-id names, also when nothing else is said", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect((await unchecked(repo, "--scan", "improve the greeting")).code).toBe(0);
		const store = RunStore.latest(repo) as RunStore;

		const result = await unchecked(repo, "--run-id", store.runId);
		expect(result.stdout).not.toContain("Usage:");
		expect(result.code).toBe(0);
		expect(calls(fake, "Executor")).toHaveLength(1);
		expect(RunStore.list(repo)).toHaveLength(1);
	});

	it("exits non-zero when something failed and says how to continue", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		const result = await unchecked(repo, "--run");
		expect(result.code).toBe(1);
		expect(result.stdout + result.stderr).toContain("milhouse --resume");

		const report = await milhouse(repo, "--report");
		expect(report.stdout).toContain("Failed:");
		expect(report.stdout).toContain("Add greeting");
	});

	it("--model applies to every step, even where the config names another model", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { model: "sonnet", phases: { verify: { model: "haiku" } } };',
		);
		expect((await unchecked(repo, "--model", "opus-x", "--run")).code).toBe(0);
		const models = fake.journal().map((call) => flag(call.args, "--model"));
		expect(models.length).toBeGreaterThan(5);
		expect(new Set(models)).toEqual(new Set(["opus-x"]));
	});

	it("--workers sets the parallelism of the two steps that have workers, and of no other", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const result = await unchecked(repo, "--workers", "3", "--run");
		expect(result.code).toBe(0);
		const agents = result.stdout.split("\n").find((line) => line.includes("Agents:")) ?? "";
		expect(agents).toContain("validate claude/sonnet x3");
		expect(agents).toContain("plan claude/sonnet x3");
		expect(agents).not.toMatch(/(scan|consolidate|exec|verify) claude\/sonnet x/);
	});

	it("works from a subdirectory of the repository and keeps its state at the root", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const result = await unchecked(join(repo, "src"), "--run");
		expect(result.code).toBe(0);
		expect(existsSync(join(repo, ".milhouse", "runs"))).toBe(true);
		expect(existsSync(join(repo, "src", ".milhouse"))).toBe(false);
		const store = RunStore.latest(repo) as RunStore;
		expect((await milhouse(join(repo, "src"), "--list-runs")).stdout).toContain(store.runId);
	});

	it("explains a missing repository", async () => {
		useFakeAgent({});
		const result = await milhouse(tempDir(), "--run");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not a git repository");
	});
});

describe("harness and model on the command line", () => {
	it("--harness codex runs every step on Codex, whatever the config says", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { harness: "claude", phases: { verify: { harness: "claude" } } };',
		);
		expect((await unchecked(repo, "--harness", "codex", "--run")).code).toBe(0);
		expect(fake.journal().every((call) => call.harness === "codex")).toBe(true);
	});

	it("--harness codex drops the models that were named for Claude", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { model: "sonnet", phases: { exec: { model: "haiku" } } };',
		);
		expect((await unchecked(repo, "--harness", "codex", "--run")).code).toBe(0);
		expect(fake.journal().length).toBeGreaterThan(5);
		for (const call of fake.journal()) expect(call.args).not.toContain("-m");

		const fake2 = useFakeAgent({});
		const repo2 = await makeRepo();
		await milhouse(repo2, "--init");
		writeFileSync(join(repo2, ".milhouse", "config.ts"), 'export default { model: "sonnet" };');
		expect((await unchecked(repo2, "--harness", "codex", "--model", "gpt-x", "--run")).code).toBe(
			0,
		);
		for (const call of fake2.journal()) expect(flag(call.args, "-m")).toBe("gpt-x"); // named on purpose
	});

	it("--model applies where it can: not to a step on the other harness", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { model: "sonnet", phases: { exec: { model: "haiku" }, verify: { harness: "codex" } } };',
		);
		expect((await unchecked(repo, "--model", "opus-x", "--run")).code).toBe(0);
		for (const call of fake.journal()) {
			if (call.harness === "claude") expect(flag(call.args, "--model")).toBe("opus-x");
			else expect(call.args).not.toContain("-m");
		}
	});

	it("rejects an unknown harness, in the flag and in the config", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const flagged = await unchecked(repo, "--harness", "gemini", "--run");
		expect(flagged.code).toBe(2);
		expect(flagged.stderr).toContain("--harness must be one of: claude, codex");

		await milhouse(repo, "--init");
		writeFileSync(join(repo, ".milhouse", "config.ts"), 'export default { harness: "gemini" };');
		const configured = await unchecked(repo, "--run");
		expect(configured.code).toBe(2);
		expect(configured.stderr).toContain("harness must be one of claude, codex");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { phases: { scan: { harness: "aider" } } };',
		);
		expect((await unchecked(repo, "--run")).stderr).toContain("phases.scan.harness");
		expect(fake.journal()).toHaveLength(0);
	});
});

describe("interruption", () => {
	const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		it(`stops the running agent on ${signal}, so nothing keeps spending money`, async () => {
			const fake = useFakeAgent({ sleep: { "Lead Investigator": 60_000 } });
			const repo = await makeRepo();
			const child = spawn("bun", [ENTRY, "--allow-unchecked", "--run"], {
				cwd: repo,
				env: { ...process.env, NO_COLOR: "1" },
				stdio: "ignore",
			});
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

			const pidFile = join(fake.stateDir, "pids");
			await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() !== "");
			const agentPid = Number(readFileSync(pidFile, "utf-8").trim().split("\n")[0]);
			expect(alive(agentPid)).toBe(true);

			child.kill(signal);
			expect(await exited).toBe(exitCodes[signal]);
			await waitFor(() => !alive(agentPid), 5000);
			expect(alive(agentPid)).toBe(false);
			expect(existsSync(join(repo, ".milhouse", "lock"))).toBe(false); // the lock is released too
			// Not "running" for ever: the run says that it was stopped, and --resume takes it up.
			expect((RunStore.latest(repo) as RunStore).loadMeta().status).toBe("stopped");
		});
	}
});
