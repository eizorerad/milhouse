import { afterEach, describe, expect, it } from "bun:test";
import {
	CONFIG_TEMPLATE,
	ConfigError,
	DEFAULTS,
	agentSteps,
	deepMerge,
	loadConfig,
	stepHarness,
	stepModel,
} from "../src/config.ts";
import { cleanupTempDirs, projectWith, testConfig } from "./helpers.ts";

afterEach(cleanupTempDirs);

describe("loadConfig", () => {
	it("returns the defaults without a config file", async () => {
		expect(await loadConfig(projectWith())).toEqual(DEFAULTS);
	});

	it("merges the user config over the defaults, key by key", async () => {
		const dir = projectWith(
			`export default { model: "opus", phases: { exec: { retries: 5 } }, neverTouch: [".env*"] };`,
		);
		const config = await loadConfig(dir);
		expect(config.model).toBe("opus");
		expect(config.phases.exec.retries).toBe(5);
		expect(config.phases.exec.model).toBe(""); // untouched sibling survives
		expect(config.phases.validate.workers).toBe(5);
		expect(config.neverTouch).toEqual([".env*"]);
	});

	it("applies CLI overrides last", async () => {
		const dir = projectWith(`export default { model: "opus" };`);
		const config = await loadConfig(dir, { model: "haiku", phases: { validate: { workers: 2 } } });
		expect(config.model).toBe("haiku");
		expect(config.phases.validate.workers).toBe(2);
		expect(config.phases.plan.workers).toBe(5);
	});

	it("fails on a config that cannot be loaded instead of silently using defaults", async () => {
		const dir = projectWith("export default {{{ not typescript");
		await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
	});

	it("rejects unknown keys at any depth (a typo must not silently disable a rule)", async () => {
		const dir = projectWith(
			`export default { neverTouches: ["x"], budgetLimit: 5, phases: { exec: { workers: 3 } } };`,
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect(error.message).toContain("neverTouches");
		expect(error.message).toContain("budgetLimit");
		expect(error.message).toContain("phases.exec.workers");
	});

	it("rejects values of the wrong type", async () => {
		const dir = projectWith(
			`export default { budget: "lots", failFast: "yes", neverTouch: "x", gates: { ignore: "*.md" } };`,
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error.message).toContain("budget must be a number");
		expect(error.message).toContain("failFast must be a boolean");
		expect(error.message).toContain("neverTouch must be an array of strings");
		expect(error.message).toContain("gates.ignore must be an array of strings");
	});

	it("takes the time that agents and checks may run from the config, and rejects a limit that is not positive", async () => {
		const set = await loadConfig(
			projectWith(
				"export default { commandTimeoutMinutes: 30, phases: { exec: { timeoutMinutes: 60 } } };",
			),
		);
		expect(set.commandTimeoutMinutes).toBe(30);
		expect(set.phases.exec.timeoutMinutes).toBe(60);
		expect(set.phases.scan.timeoutMinutes).toBe(15); // untouched default

		const longest = projectWith(
			"export default { commandTimeoutMinutes: 1440, phases: { exec: { timeoutMinutes: 1440 } } };",
		);
		expect((await loadConfig(longest)).commandTimeoutMinutes).toBe(1440);
		const tooLong = await loadConfig(
			projectWith("export default { commandTimeoutMinutes: 1441 };"),
		).catch((e) => e);
		expect(tooLong.message).toContain(
			"commandTimeoutMinutes must be a number above 0 and at most 1440",
		);

		const bad = projectWith(
			"export default { commandTimeoutMinutes: 0, phases: { scan: { timeoutMinutes: -1 } } };",
		);
		const error = await loadConfig(bad).catch((e) => e);
		expect(error.message).toContain("commandTimeoutMinutes must be a number above 0");
		expect(error.message).toContain("phases.scan.timeoutMinutes must be a number above 0");
	});

	it("rejects patterns with an exception (!), which neverTouch and gates.ignore do not support", async () => {
		const dir = projectWith(
			'export default { neverTouch: ["*.lock", "!keep.lock"], gates: { ignore: ["!a.md"] } };',
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error.message).toContain('neverTouch: "!keep.lock" cannot start with "!"');
		const hidden = projectWith('export default { neverTouch: ["/!x", "//!y"] };');
		const slashed = await loadConfig(hidden).catch((e) => e);
		expect(slashed.message).toContain('neverTouch: "/!x" cannot start with "!"');
		expect(slashed.message).toContain('neverTouch: "//!y" cannot start with "!"');
		expect(error.message).toContain('gates.ignore: "!a.md" cannot start with "!"');
	});

	it("takes a time limit for the whole command, and rejects a negative one", async () => {
		expect((await loadConfig(projectWith("export default { maxMinutes: 90 };"))).maxMinutes).toBe(
			90,
		);
		expect((await loadConfig(projectWith())).maxMinutes).toBe(0); // no limit
		const error = await loadConfig(projectWith("export default { maxMinutes: -5 };")).catch(
			(e) => e,
		);
		expect(error.message).toContain("maxMinutes must be a finite number >= 0");
	});

	it("accepts the two harnesses, globally and per step, with their extra arguments", async () => {
		const dir = projectWith(
			`export default { harness: "codex", harnessArgs: { codex: ["-p", "work"] }, phases: { verify: { harness: "claude", model: "haiku" } } };`,
		);
		const config = await loadConfig(dir);
		expect(config.harness).toBe("codex");
		expect(config.harnessArgs).toEqual({ claude: [], codex: ["-p", "work"] });
		expect(config.phases.verify.harness).toBe("claude");
		expect(config.phases.scan.harness).toBe(""); // the global one
	});

	it("rejects a harness that does not exist, and extra arguments that are not a list of strings", async () => {
		const dir = projectWith(
			`export default { harness: "gemini", harnessArgs: { codex: "-p work" }, phases: { scan: { harness: "aider" } } };`,
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect(error.message).toContain("harnessArgs.codex must be an array of strings");
		const typed = projectWith(
			`export default { harness: "gemini", phases: { scan: { harness: "aider" } } };`,
		);
		const second = await loadConfig(typed).catch((e) => e);
		expect(second.message).toContain("harness must be one of claude, codex");
		expect(second.message).toContain("phases.scan.harness");
		const unknown = projectWith("export default { harnessArgs: { gemini: [] } };");
		expect((await loadConfig(unknown).catch((e) => e)).message).toContain("harnessArgs.gemini");
	});

	it("accepts rules for a single step, and rejects rules that are not a list of strings", async () => {
		const ok = projectWith(
			'export default { phases: { exec: { rules: ["Write the failing test first"] } } };',
		);
		expect((await loadConfig(ok)).phases.exec.rules).toEqual(["Write the failing test first"]);
		expect((await loadConfig(projectWith("export default {};"))).phases.exec.rules).toEqual([]);
		const bad = projectWith('export default { phases: { scan: { rules: "be careful" } } };');
		expect((await loadConfig(bad).catch((e) => e)).message).toContain(
			"phases.scan.rules must be an array of strings",
		);
	});

	it("rejects extra arguments that would change what Milhouse relies on, and allows the rest", async () => {
		const dir = projectWith(
			`export default { harnessArgs: { claude: ["--output-format", "text", "--verbose"], codex: ["-s", "workspace-write", "--output-last-message=out.txt", "-p", "profile"] } };`,
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect(error.message).toContain('harnessArgs.claude: "--output-format"');
		expect(error.message).toContain('harnessArgs.codex: "-s"');
		expect(error.message).toContain('harnessArgs.codex: "--output-last-message"');
		expect(error.message).not.toContain("--verbose");
		expect(error.message).not.toContain('"-p"'); // a profile for Codex; for Claude -p is the print mode

		const models = projectWith(
			'export default { harnessArgs: { claude: ["--model", "x"], codex: ["-m", "x", "--model=y"] } };',
		);
		const modelError = (await loadConfig(models).catch((e) => e)).message;
		expect(modelError).toContain('harnessArgs.claude: "--model"');
		expect(modelError).toContain('harnessArgs.codex: "-m"');
		expect(modelError).toContain('harnessArgs.codex: "--model"');

		const attached = projectWith(
			'export default { harnessArgs: { claude: ["-pfoo"], codex: ["-oanswer.txt", "-sworkspace-write", "--", "-pprofile"] } };',
		);
		const attachedError = (await loadConfig(attached).catch((e) => e)).message;
		expect(attachedError).toContain('harnessArgs.claude: "-p"');
		expect(attachedError).toContain('harnessArgs.codex: "-o"');
		expect(attachedError).toContain('harnessArgs.codex: "-s"');
		expect(attachedError).toContain('harnessArgs.codex: "--"');
		expect(attachedError.match(/harnessArgs\.codex: "-p"/)).toBeNull();

		const claudePrint = projectWith(`export default { harnessArgs: { claude: ["-p"] } };`);
		expect((await loadConfig(claudePrint).catch((e) => e)).message).toContain(
			'harnessArgs.claude: "-p"',
		);
		const fine = projectWith(
			`export default { harnessArgs: { codex: ["-p", "profile", "-c", "x=1"] } };`,
		);
		expect((await loadConfig(fine)).harnessArgs.codex).toEqual(["-p", "profile", "-c", "x=1"]);
	});

	it("rejects a budget that is not a finite number: NaN would switch the limit off, Infinity would break every call", async () => {
		for (const budget of ["Number.NaN", "Number.POSITIVE_INFINITY", "-Infinity"]) {
			const dir = projectWith(`export default { budget: ${budget} };`);
			const error = await loadConfig(dir).catch((e) => e);
			expect(error).toBeInstanceOf(ConfigError);
			expect(error.message).toContain("budget must be a finite number >= 0");
		}
	});

	it("rejects out-of-range numbers", async () => {
		const dir = projectWith(
			"export default { budget: -1, phases: { exec: { retries: -2 }, plan: { workers: 0 } } };",
		);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error.message).toContain("budget must be a finite number >= 0");
		expect(error.message).toContain("phases.exec.retries");
		expect(error.message).toContain("phases.plan.workers");
	});

	it("requires the pipeline to list known phases once, in order", async () => {
		for (const pipeline of [`["exec", "scan"]`, `["scan", "verify"]`, `["scan", "scan"]`]) {
			const dir = projectWith(`export default { pipeline: ${pipeline} };`);
			await expect(loadConfig(dir)).rejects.toThrow(/pipeline must list phases/);
		}
		const ok = projectWith(`export default { pipeline: ["scan", "validate", "plan"] };`);
		expect((await loadConfig(ok)).pipeline).toEqual(["scan", "validate", "plan"]);
	});

	it("rejects a config that does not export an object", async () => {
		const dir = projectWith("export default 42;");
		await expect(loadConfig(dir)).rejects.toThrow(/must export a config object/);
	});

	it("accepts the template written by --init", async () => {
		const dir = projectWith(CONFIG_TEMPLATE);
		expect(await loadConfig(dir)).toEqual(DEFAULTS);
	});
});

describe("deepMerge", () => {
	it("does not mutate its inputs and replaces arrays", () => {
		const base = { a: { b: 1, c: [1] }, d: 1 };
		const merged = deepMerge(base, { a: { c: [2, 3] } }, { d: undefined });
		expect(merged).toEqual({ a: { b: 1, c: [2, 3] }, d: 1 });
		expect(base).toEqual({ a: { b: 1, c: [1] }, d: 1 });
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
