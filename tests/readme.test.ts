/** The README's examples are what people paste: they have to load, and a run has to do what they say. */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deepMerge, loadConfig, stepHarness, stepModel } from "../src/config.ts";
import type { AgentStep, Config } from "../src/types.ts";
import {
	calls,
	cleanupTempDirs,
	flag,
	go,
	makeRepo,
	projectWith,
	resetFakeAgentEnv,
	silenceConsole,
	useFakeAgent,
} from "./helpers.ts";

silenceConsole({ honorDebug: false });

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

const README = readFileSync(resolve(import.meta.dir, "../README.md"), "utf-8");

/** The first ```ts block after `heading`. */
function exampleAfter(heading: string): string {
	const from = README.indexOf(heading);
	expect(from).toBeGreaterThan(-1);
	const open = README.indexOf("```ts\n", from) + "```ts\n".length;
	return README.slice(open, README.indexOf("\n```", open));
}

describe('the README example "One agent per step"', () => {
	const example = () => exampleAfter("### One agent per step");

	it("loads, and every step has the agent, model and parallelism its comment promises", async () => {
		const config = await loadConfig(projectWith(example()));
		const expected: Record<AgentStep, [harness: string, model: string]> = {
			scan: ["claude", "claude-opus-5-5"],
			validate: ["codex", ""], // "" = the model of the user's Codex config
			plan: ["claude", "claude-sonnet-5-5"],
			consolidate: ["claude", "claude-haiku-5-5"],
			exec: ["claude", "claude-opus-5-5"],
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
			allowUnchecked: true,
			commands: { setup: "", test: "" },
		}) as unknown as Config;
		expect(await go(repo, config)).toBe(true);

		const asked = (role: string) => calls(fake, role);
		for (const role of ["Lead Investigator", "Planner", "Consistency Manager", "Executor"]) {
			expect(asked(role).length).toBeGreaterThan(0);
			expect(asked(role).every((c) => c.harness === "claude")).toBe(true);
		}
		expect(new Set(asked("Lead Investigator").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["claude-opus-5-5"]),
		);
		expect(new Set(asked("Planner").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["claude-sonnet-5-5"]),
		);
		expect(new Set(asked("Consistency Manager").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["claude-haiku-5-5"]),
		);
		expect(new Set(asked("Executor").map((c) => flag(c.args, "--model")))).toEqual(
			new Set(["claude-opus-5-5"]),
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

		// The rules of a step reach that step's prompt and no other.
		const promptsOf = (role: string) => asked(role).map((c) => c.prompt);
		const ruleOf: Record<string, string> = {
			"Lead Investigator": "Prefer bugs that lose data or break security over style",
			Executor: "Write the failing test first",
			"Truth Verifier": "Reject a fix that comes without a test",
		};
		for (const role of ["Lead Investigator", "Executor", "Truth Verifier"]) {
			for (const text of promptsOf(role)) {
				expect(text).toContain(`## Extra rules for this step\n- ${ruleOf[role]}`);
			}
		}
		for (const role of ["Issue Validator", "Planner", "Consistency Manager"]) {
			for (const text of promptsOf(role)) expect(text).not.toContain("Extra rules");
		}
	});
});
