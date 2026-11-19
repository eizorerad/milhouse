/** Test helpers: temporary git repositories, the fake agent, a default config, the console. */

import { afterEach, beforeEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { DEFAULTS, deepMerge } from "../src/config.ts";
import { type PipelineOptions, runPipeline } from "../src/pipeline.ts";
import { run } from "../src/proc.ts";
import { RunStore } from "../src/state.ts";
import type { Config, Issue, Task } from "../src/types.ts";

export const FAKE_AGENT = resolve(import.meta.dir, "fixtures/fake-agent.ts");

const created: string[] = [];

export function tempDir(prefix = "milhouse-test-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

export function cleanupTempDirs(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, { cwd });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

export function writeFile(repo: string, file: string, content: string): void {
	const path = join(repo, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

export const readFile = (repo: string, file: string): string =>
	readFileSync(join(repo, file), "utf-8");

export async function commitFile(
	repo: string,
	file: string,
	content: string,
	message: string,
): Promise<string> {
	writeFile(repo, file, content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

/** A repository on `main` with one commit containing src/app.ts, in `dir` (a new temporary directory by default). */
export async function makeRepo(dir = tempDir()): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	await git(dir, "config", "commit.gpgsign", "false");
	await commitFile(dir, "src/app.ts", "export const app = 1;\nexport const two = 2;\n", "initial");
	return dir;
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
	const base = deepMerge(DEFAULTS as unknown as Record<string, unknown>, {
		budget: 0,
		phases: {
			scan: { retries: 0 },
			validate: { retries: 0 },
			plan: { retries: 0 },
			consolidate: { retries: 0 },
			exec: { retries: 1 },
			verify: { retries: 0 },
		},
	});
	return deepMerge(base, overrides) as unknown as Config;
}

export interface FakeAgent {
	stateDir: string;
	journal(): Array<{
		harness: "claude" | "codex";
		role: string;
		issueTitle: string;
		args: string[];
		cwd: string;
		prompt: string;
	}>;
}

/** Point the engine at the fake agent. Returns accessors for what it saw. */
export function useFakeAgent(scenario: Record<string, unknown> = {}): FakeAgent {
	const stateDir = tempDir("milhouse-fake-");
	process.env.MILHOUSE_CLAUDE = FAKE_AGENT;
	process.env.MILHOUSE_CODEX = FAKE_AGENT;
	process.env.FAKE_AGENT_STATE = stateDir;
	process.env.FAKE_AGENT_SCENARIO = JSON.stringify(scenario);
	process.env.MILHOUSE_RETRY_DELAY_MS = "1";
	return {
		stateDir,
		journal: () => {
			try {
				return readFileSync(join(stateDir, "journal.jsonl"), "utf-8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			} catch {
				return [];
			}
		},
	};
}

/** Remove environment variables (a plain `delete` on a literal name is flagged by the linter). */
export function unsetEnv(...names: string[]): void {
	for (const name of names) delete process.env[name];
}

/** Plain ASCII: what a terminal without UTF-8 shows correctly. */
export const isAscii = (text: string): boolean =>
	[...text].every((c) => (c.codePointAt(0) ?? 0) < 128);

export function resetFakeAgentEnv(): void {
	for (const key of [
		"MILHOUSE_CLAUDE",
		"MILHOUSE_CODEX",
		"FAKE_AGENT_STATE",
		"FAKE_AGENT_SCENARIO",
		"MILHOUSE_RETRY_DELAY_MS",
	]) {
		delete process.env[key];
	}
}

/** Run the pipeline in `repo` with the test config. */
export const go = (repo: string, config = testConfig(), opts: PipelineOptions = {}) =>
	runPipeline(config, { workDir: repo, ...opts });

export const latest = (repo: string): RunStore => RunStore.latest(repo) as RunStore;

export const calls = (fake: FakeAgent, role: string) =>
	fake.journal().filter((c) => c.role === role);

/** Commit subjects on main, newest first. */
export const mainSubjects = async (repo: string): Promise<string[]> =>
	(await git(repo, "log", "--format=%s", "main")).split("\n");

/** Where a run that a unit test creates starts: a branch and a made-up commit, no repository. */
export const BASE = { branch: "main", sha: "abc" };

/** An issue for unit tests: a confirmed HIGH bug titled by its id; `over` says what differs. */
export const makeIssue = (id: string, over: Partial<Issue> = {}): Issue => ({
	id,
	type: "bug",
	title: id,
	rationale: "r",
	severity: "HIGH",
	status: "CONFIRMED",
	evidence: [],
	...over,
});

/** A task for unit tests: a pending task of issue P1, titled by its id; `over` says what differs. */
export const makeTask = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	issue_id: "P1",
	title: id,
	description: "",
	files: [],
	depends_on: [],
	checks: [],
	acceptance: [],
	status: "pending",
	...over,
});

/** Undo what silenceConsole or captureConsole did to console.log and console.error. */
function restoreConsole(): void {
	spyOn(console, "log").mockRestore();
	spyOn(console, "error").mockRestore();
}

/**
 * Keep what the code under test prints with console.log and console.error out of the test output,
 * in every test of the file that calls this at its top level. DEBUG_TESTS=1 lets it through, unless
 * the file passes `honorDebug: false`.
 */
export function silenceConsole({ honorDebug = true }: { honorDebug?: boolean } = {}): void {
	beforeEach(() => {
		if (honorDebug && process.env.DEBUG_TESTS) return;
		spyOn(console, "log").mockImplementation(() => {});
		spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(restoreConsole);
}

/**
 * Collect what the code under test prints with console.log and console.error, without colours, in
 * every test of the file that calls this at its top level. The returned list holds the lines of the
 * running test. DEBUG_TESTS=1 prints them instead (and the list stays empty).
 */
export function captureConsole(): string[] {
	const lines: string[] = [];
	beforeEach(() => {
		lines.length = 0;
		const collect = (...args: unknown[]) =>
			void lines.push(stripVTControlCharacters(args.join(" ")));
		spyOn(console, "log").mockImplementation(process.env.DEBUG_TESTS ? console.info : collect);
		spyOn(console, "error").mockImplementation(process.env.DEBUG_TESTS ? console.info : collect);
	});
	afterEach(restoreConsole);
	return lines;
}
