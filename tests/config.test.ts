import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_TEMPLATE, ConfigError, DEFAULTS, deepMerge, loadConfig } from "../src/config.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

function projectWith(configSource?: string): string {
	const dir = tempDir();
	if (configSource !== undefined) {
		mkdirSync(join(dir, ".milhouse"));
		writeFileSync(join(dir, ".milhouse", "config.ts"), configSource);
	}
	return dir;
}

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
		const dir = projectWith(`export default { budget: "lots", failFast: "yes", neverTouch: "x" };`);
		const error = await loadConfig(dir).catch((e) => e);
		expect(error.message).toContain("budget must be a number");
		expect(error.message).toContain("failFast must be a boolean");
		expect(error.message).toContain("neverTouch must be an array of strings");
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
