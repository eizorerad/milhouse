/** The real CLI as a subprocess: argument handling, --init, reports and one full run. */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { ensureWorktree, isDirty, refExists } from "../src/git.ts";
import { run } from "../src/proc.ts";
import { RunStore } from "../src/state.ts";
import { sleep } from "../src/util.ts";
import {
	cleanupTempDirs,
	git,
	isAscii,
	makeRepo,
	resetFakeAgentEnv,
	tempDir,
	useFakeAgent,
} from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

const ENTRY = resolve(import.meta.dir, "../src/index.ts");

const milhouse = (cwd: string, ...args: string[]) =>
	run("bun", [ENTRY, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" }, timeoutMs: 120_000 });

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
	});

	it("rejects an invalid config with a clear message", async () => {
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(join(repo, ".milhouse", "config.ts"), "export default { budgetLimit: 5 };");
		const result = await milhouse(repo, "--run");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("budgetLimit");
	});
});

describe("--init, --list-runs, --report, --clean", () => {
	it("creates the config and keeps the working tree clean, so the next run is not blocked", async () => {
		const repo = await makeRepo();
		const first = await milhouse(repo, "--init");
		expect(first.code).toBe(0);
		expect(existsSync(join(repo, ".milhouse", "config.ts"))).toBe(true);
		expect(readFileSync(join(repo, ".milhouse", ".gitignore"), "utf-8")).toContain("runs/");
		expect(await isDirty(repo)).toBe(false);

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
		expect((await milhouse(repo, "--run")).code).toBe(1);
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
		expect((await milhouse(repo, "--run")).code).toBe(1);
		expect((await milhouse(repo, "--clean")).stdout).toContain("Nothing to clean"); // too recent

		const store = await oldRunWithLeftovers(repo);
		const result = await milhouse(repo, "--clean");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(store.runId);
		expect(existsSync(store.worktree)).toBe(false);
		expect(await refExists(repo, store.ref)).toBe(false);
		expect(RunStore.list(repo).map((r) => r.id)).not.toContain(store.runId);
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
});

describe("a full run through the CLI", () => {
	it("runs the pipeline, then lists and reports the run", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");

		const result = await milhouse(repo, "improve the greeting");
		expect(result.stdout).toContain("Pipeline complete");
		expect(result.code).toBe(0);

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
	});

	it("exits non-zero when something failed and says how to continue", async () => {
		useFakeAgent({ exec: { "Add greeting": "never-commits" } });
		const repo = await makeRepo();
		const result = await milhouse(repo, "--run");
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
		expect((await milhouse(repo, "--model", "opus-x", "--run")).code).toBe(0);
		const models = fake.journal().map((call) => call.args[call.args.indexOf("--model") + 1]);
		expect(models.length).toBeGreaterThan(5);
		expect(new Set(models)).toEqual(new Set(["opus-x"]));
	});

	it("works from a subdirectory of the repository and keeps its state at the root", async () => {
		useFakeAgent({});
		const repo = await makeRepo();
		const result = await milhouse(join(repo, "src"), "--run");
		expect(result.code).toBe(0);
		expect(existsSync(join(repo, ".milhouse", "runs"))).toBe(true);
		expect(existsSync(join(repo, "src", ".milhouse"))).toBe(false);
		expect((await milhouse(join(repo, "src"), "--list-runs")).stdout).toContain("completed");
	});

	it("explains a missing repository", async () => {
		useFakeAgent({});
		const result = await milhouse(tempDir(), "--run");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not a git repository");
	});
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor(condition: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await sleep(50);
}

describe("interruption", () => {
	const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		it(`stops the running agent on ${signal}, so nothing keeps spending money`, async () => {
			const fake = useFakeAgent({ sleep: { "Lead Investigator": 60_000 } });
			const repo = await makeRepo();
			const child = spawn("bun", [ENTRY, "--run"], {
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
		});
	}
});
