/** Codex as a harness: the whole pipeline on it, mixed with Claude, and what goes wrong with it. */

import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSteps, stepHarness, stepModel } from "../src/config.ts";
import { requireAgents } from "../src/pipeline.ts";
import { run } from "../src/proc.ts";
import {
	allStatus,
	calls,
	captureConsole,
	cleanupTempDirs,
	flag,
	go,
	latest,
	makeRepo,
	milhouse,
	readFile,
	resetFakeAgentEnv,
	testConfig,
	useFakeAgent,
} from "./helpers.ts";

const output = captureConsole();

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

describe("the whole pipeline on Codex", () => {
	it("scans, validates, plans, executes, reviews and merges through `codex exec`", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ harness: "codex" }))).toBe(true);

		const journal = fake.journal();
		expect(journal.length).toBeGreaterThan(5);
		expect(journal.every((call) => call.harness === "codex")).toBe(true);
		for (const call of journal) {
			expect(call.args[0]).toBe("exec");
			if (call.role === "Executor") {
				expect(call.args).toContain("--dangerously-bypass-approvals-and-sandbox");
				expect(call.cwd).toContain(".milhouse/work"); // edits and commits in the run's worktree
			} else {
				expect(flag(call.args, "-s")).toBe("read-only");
			}
			expect(call.args).not.toContain("-m"); // Codex's own model applies
		}
		const [task] = latest(repo).loadTasks();
		expect(readFile(repo, `${task.id}.txt`)).toBe(`${task.title}\n`); // the work landed on the branch
	});

	it("counts tokens instead of dollars, and says so in the report", async () => {
		useFakeAgent({ cost: 0.02 });
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ harness: "codex" }))).toBe(true);
		const cost = latest(repo).loadCost();
		expect(cost.total).toBe(0);
		expect(cost.tokens?.input).toBeGreaterThan(10_000);
		expect(cost.tokens?.output).toBeGreaterThan(0);
		expect(output.join("\n")).toMatch(/Pipeline complete: .* tokens \(Codex reports no dollars\)/);
	});

	it("warns that the budget cannot limit it, and does not stop it for lack of dollars", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, testConfig({ harness: "codex", budget: 0.001 }))).toBe(true);
		expect(output.join("\n")).toContain("The budget cannot limit Codex");
		expect(calls(fake, "Executor")).toHaveLength(1);
	});
});

describe("one harness per step", () => {
	const mixed = (over: Record<string, unknown> = {}) =>
		testConfig({ phases: { verify: { harness: "codex" } }, ...over });

	it("lets Claude do the work and Codex review it, each with its own flags and cost", async () => {
		const fake = useFakeAgent({ cost: 0.05 });
		const repo = await makeRepo();
		expect(await go(repo, mixed())).toBe(true);

		expect(calls(fake, "Executor").every((c) => c.harness === "claude")).toBe(true);
		const reviews = calls(fake, "Truth Verifier");
		expect(reviews).toHaveLength(1);
		expect(reviews[0].harness).toBe("codex");
		expect(flag(reviews[0].args, "-s")).toBe("read-only");
		expect(reviews[0].cwd).toContain(".milhouse/work"); // it reads the run's worktree

		const cost = latest(repo).loadCost();
		expect(cost.total).toBeGreaterThan(0); // Claude's dollars
		expect(cost.byPhase.verify).toBeUndefined(); // none of them Codex's
		expect(cost.tokens?.input).toBeGreaterThan(0); // Codex's tokens
	});

	it("gives each step the model of its own harness, never the other one's", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		expect(await go(repo, mixed({ model: "opus-x" }))).toBe(true);
		for (const call of fake.journal()) {
			if (call.harness === "claude") expect(flag(call.args, "--model")).toBe("opus-x");
			else expect(call.args).not.toContain("-m");
		}

		const fake2 = useFakeAgent({});
		const repo2 = await makeRepo();
		const config = mixed({ phases: { verify: { harness: "codex", model: "gpt-x" } } });
		expect(await go(repo2, config)).toBe(true);
		const review = calls(fake2, "Truth Verifier")[0];
		expect(flag(review.args, "-m")).toBe("gpt-x");
		expect(flag(calls(fake2, "Executor")[0].args, "--model")).toBe("sonnet"); // Claude's default
	});

	it("passes harnessArgs to the harness they are for, and only to it", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const config = mixed({ harnessArgs: { claude: ["--verbose"], codex: ["-p", "milhouse"] } });
		expect(await go(repo, config)).toBe(true);
		for (const call of fake.journal()) {
			if (call.harness === "claude") {
				expect(call.args).toContain("--verbose");
				expect(call.args).not.toContain("milhouse");
			} else {
				expect(call.args.slice(0, 3)).toEqual(["exec", "-p", "milhouse"]);
				expect(call.args).not.toContain("--verbose");
			}
		}
	});
});

describe("choosing the harness and the model of a step", () => {
	it("falls back to the global harness, and to that harness's default model", () => {
		const claudeRun = testConfig();
		expect(stepHarness(claudeRun, "scan")).toBe("claude");
		expect(stepModel(claudeRun, "scan")).toBe("sonnet");
		const codexRun = testConfig({ harness: "codex" });
		expect(stepHarness(codexRun, "exec")).toBe("codex");
		expect(stepModel(codexRun, "exec")).toBe(""); // Codex's own default
		expect(stepModel(testConfig({ harness: "codex", model: "gpt-x" }), "exec")).toBe("gpt-x");
	});

	it("never hands the global model to a step on the other harness", () => {
		const config = testConfig({ model: "opus", phases: { verify: { harness: "codex" } } });
		expect(stepModel(config, "exec")).toBe("opus");
		expect(stepModel(config, "verify")).toBe("");
		const named = testConfig({
			model: "opus",
			phases: { verify: { harness: "codex", model: "gpt-x" } },
		});
		expect(stepModel(named, "verify")).toBe("gpt-x");
	});

	it("lists the steps that will call an agent: the reviewer only with the definition of done", () => {
		const config = testConfig();
		expect(agentSteps(config, ["scan", "exec", "merge"])).toEqual(["scan", "exec", "verify"]);
		expect(agentSteps(config, ["merge"])).toEqual([]);
		expect(agentSteps(testConfig({ gates: { dod: false } }), ["exec"])).toEqual(["exec"]);
	});
});

describe("the agents have to be installed", () => {
	it("requires the binary of every harness the steps will use, and only those", () => {
		useFakeAgent({});
		process.env.MILHOUSE_CODEX = "/nonexistent/codex";
		const claudeOnly = testConfig();
		expect(() => requireAgents(claudeOnly, ["scan", "exec", "merge"])).not.toThrow();
		const withCodex = testConfig({ phases: { verify: { harness: "codex" } } });
		expect(() => requireAgents(withCodex, ["scan", "plan"])).not.toThrow(); // verify is not needed yet
		expect(() => requireAgents(withCodex, ["exec"])).toThrow(
			/"\/nonexistent\/codex" was not found.*Codex/,
		);
		expect(() => requireAgents(testConfig({ harness: "codex" }), ["merge"])).not.toThrow(); // merge needs none
	});

	it("fails before a new run leaves anything behind", async () => {
		useFakeAgent({});
		process.env.MILHOUSE_CODEX = "/nonexistent/codex";
		const repo = await makeRepo();
		await expect(go(repo, testConfig({ harness: "codex" }))).rejects.toThrow(
			/was not found on PATH/,
		);
		expect(
			await run("ls", ["-A", ".milhouse"], { cwd: repo }).then((r) => r.stdout.trim()),
		).not.toContain("runs");
	});
});

describe("a failure that every call would share", () => {
	const eight = { scan: Array.from({ length: 8 }, (_, i) => ({ title: `Thing ${i + 1}` })) };

	for (const [name, harness, failure] of [
		[
			"Claude is logged out",
			"claude",
			{ message: "Not logged in · Please run /login", result: true },
		],
		[
			"Codex gets a 401",
			"codex",
			{ message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication" },
		],
	] as const) {
		it(`stops the phase instead of failing every item three times when ${name}`, async () => {
			const fake = useFakeAgent({ ...eight, fail: { "Issue Validator": failure } });
			const repo = await makeRepo();
			const config = testConfig({ harness, phases: { validate: { workers: 5, retries: 2 } } });
			expect(await go(repo, config)).toBe(false);

			// At most the calls that were in flight together; nothing was retried, nothing was planned.
			expect(calls(fake, "Issue Validator").length).toBeLessThanOrEqual(5);
			expect(calls(fake, "Planner")).toHaveLength(0);
			expect(latest(repo).loadIssues().length).toBe(8); // none of them was confirmed or dropped
			const text = output.join("\n");
			expect(text).toContain("Stopped: every other call would fail the same way");
			expect(text).not.toContain("attempt 2/3"); // no item was retried
		});
	}

	it("does not blame the executor for it when the run is resumed", async () => {
		const fake = useFakeAgent({
			fail: {
				Executor: { message: "Not logged in \u00b7 Please run /login", result: true, times: 1 },
			},
		});
		const repo = await makeRepo();
		expect(await go(repo)).toBe(false);
		expect(allStatus(repo, "failed")).toBe(true);

		expect(await go(repo, testConfig(), { resume: true })).toBe(true);
		const executors = calls(fake, "Executor");
		expect(executors).toHaveLength(2);
		expect(executors[1].prompt).not.toContain("Not logged in");
		expect(executors[1].prompt).not.toContain("The previous attempt failed");
	});

	it("lets --resume take the untouched items up once the cause is gone", async () => {
		const fake = useFakeAgent({
			...eight,
			fail: { "Issue Validator": { message: "Not logged in", result: true, times: 5 } },
		});
		const repo = await makeRepo();
		const config = testConfig({ phases: { validate: { workers: 5, retries: 0 } } });
		expect(await go(repo, config)).toBe(false);
		expect(await go(repo, config, { resume: true })).toBe(true);
		expect(
			latest(repo)
				.loadIssues()
				.every((i) => i.status === "CONFIRMED"),
		).toBe(true);
		expect(calls(fake, "Issue Validator").length).toBeLessThan(8 + 5 + 1);
	});
});

describe("the CLI", () => {
	it("--harness codex runs every step on Codex, whatever the config says", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		await milhouse(repo, "--init");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { harness: "claude", phases: { verify: { harness: "claude" } } };',
		);
		expect((await milhouse(repo, "--harness", "codex", "--run")).code).toBe(0);
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
		expect((await milhouse(repo, "--harness", "codex", "--run")).code).toBe(0);
		expect(fake.journal().length).toBeGreaterThan(5);
		for (const call of fake.journal()) expect(call.args).not.toContain("-m");

		const fake2 = useFakeAgent({});
		const repo2 = await makeRepo();
		await milhouse(repo2, "--init");
		writeFileSync(join(repo2, ".milhouse", "config.ts"), 'export default { model: "sonnet" };');
		expect((await milhouse(repo2, "--harness", "codex", "--model", "gpt-x", "--run")).code).toBe(0);
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
		expect((await milhouse(repo, "--model", "opus-x", "--run")).code).toBe(0);
		for (const call of fake.journal()) {
			if (call.harness === "claude") expect(flag(call.args, "--model")).toBe("opus-x");
			else expect(call.args).not.toContain("-m");
		}
	});

	it("rejects an unknown harness, in the flag and in the config", async () => {
		const fake = useFakeAgent({});
		const repo = await makeRepo();
		const flagged = await milhouse(repo, "--harness", "gemini", "--run");
		expect(flagged.code).toBe(2);
		expect(flagged.stderr).toContain("--harness must be one of: claude, codex");

		await milhouse(repo, "--init");
		writeFileSync(join(repo, ".milhouse", "config.ts"), 'export default { harness: "gemini" };');
		const configured = await milhouse(repo, "--run");
		expect(configured.code).toBe(2);
		expect(configured.stderr).toContain("harness must be one of claude, codex");
		writeFileSync(
			join(repo, ".milhouse", "config.ts"),
			'export default { phases: { scan: { harness: "aider" } } };',
		);
		expect((await milhouse(repo, "--run")).stderr).toContain("phases.scan.harness");
		expect(fake.journal()).toHaveLength(0);
	});
});
