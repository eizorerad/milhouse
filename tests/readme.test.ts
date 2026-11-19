/** The README's examples are what people paste: they have to load, and a run has to do what they say. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deepMerge, loadConfig, stepHarness, stepModel } from "../src/config.ts";
import type { AgentStep, Config } from "../src/types.ts";
import {
	calls,
	cleanupTempDirs,
	go,
	makeRepo,
	resetFakeAgentEnv,
	tempDir,
	useFakeAgent,
} from "./helpers.ts";

beforeEach(() => {
	spyOn(console, "log").mockImplementation(() => {});
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
	spyOn(console, "log").mockRestore();
	spyOn(console, "error").mockRestore();
});

const README = readFileSync(resolve(import.meta.dir, "../README.md"), "utf-8");

/** The first ```ts block after `heading`. */
function exampleAfter(heading: string): string {
	const from = README.indexOf(heading);
	expect(from).toBeGreaterThan(-1);
	const open = README.indexOf("```ts\n", from) + "```ts\n".length;
	return README.slice(open, README.indexOf("\n```", open));
}

function projectWith(config: string): string {
	const dir = tempDir();
	mkdirSync(join(dir, ".milhouse"), { recursive: true });
	writeFileSync(join(dir, ".milhouse", "config.ts"), config);
	return dir;
}

const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

describe('the README example "One agent per step"', () => {
	const example = () => exampleAfter("### One agent per step");

	it("loads, and every step has the agent, model and parallelism its comment promises", async () => {
		const config = await loadConfig(projectWith(example()));
		const expected: Record<AgentStep, [harness: string, model: string]> = {
			scan: ["claude", "opus"],
			validate: ["codex", ""], // "" = the model of the user's Codex config
			plan: ["claude", "sonnet"],
			consolidate: ["claude", "haiku"],
			exec: ["claude", "opus"],
			verify: ["codex", ""],
		};
		for (const [step, [harness, model]] of Object.entries(expected)) {
			expect([step, stepHarness(config, step as AgentStep)]).toEqual([step, harness]);
			expect([step, stepModel(config, step as AgentStep)]).toEqual([step, model]);
		}
		expect(config.phases.validate.workers).toBe(8);
		expect(config.phases.plan.workers).toBe(4);
		expect(config.phases.exec.retries).toBe(3);
		expect(config.budget).toBe(20);
		expect(config.harnessArgs.codex).toEqual(["-c", 'model_reasoning_effort="high"']);
	});

	it("is what a run really does: each step calls its own harness with its own model", async () => {
		const fake = useFakeAgent({ scan: [{ title: "A" }, { title: "B" }, { title: "C" }] });
		const repo = await makeRepo();
		const loaded = await loadConfig(projectWith(example()));
		// The example installs and tests with bun; this repository has neither.
		const config = deepMerge(loaded as unknown as Record<string, unknown>, {
			budget: 0,
			commands: { setup: "", test: "" },
		}) as unknown as Config;
		expect(await go(repo, config)).toBe(true);

		const asked = (role: string) => calls(fake, role);
		for (const role of ["Lead Investigator", "Planner", "Consistency Manager", "Executor"]) {
			expect(asked(role).length).toBeGreaterThan(0);
			expect(asked(role).every((c) => c.harness === "claude")).toBe(true);
		}
		expect(new Set(asked("Lead Investigator").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["opus"]),
		);
		expect(new Set(asked("Planner").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["sonnet"]),
		);
		expect(new Set(asked("Consistency Manager").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["haiku"]),
		);
		expect(new Set(asked("Executor").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["opus"]),
		);

		// Three findings were checked, each by a Codex agent with the configured Codex flags.
		const validators = asked("Issue Validator");
		expect(validators).toHaveLength(3);
		for (const call of [...validators, ...asked("Truth Verifier")]) {
			expect(call.harness).toBe("codex");
			expect(call.args.slice(0, 3)).toEqual(["exec", "-c", 'model_reasoning_effort="high"']);
			expect(call.args).not.toContain("-m"); // the model of the user's Codex config
		}
		expect(asked("Truth Verifier").length).toBeGreaterThan(0);
	});
});
