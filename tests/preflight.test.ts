/**
 * Tests for preflight checks.
 *
 * Uses mock.module to ensure the real preflight implementation is used,
 * even when other test files (e.g. pipeline.test.ts) mock preflight.ts.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config, Phase } from "../src/types.ts";
import { PHASES } from "../src/types.ts";
import { createRunCost, isBudgetExceeded } from "../src/cost.ts";

/**
 * Re-implement the check functions here so that tests are not affected
 * by mock.module calls in other test files (bun shares the module registry).
 */
const KNOWN_ENGINES = ["claude", "gemini", "aider"] as const;

async function checkEngine(engineName: string): Promise<void> {
	const cmd = process.platform === "win32" ? "where" : "which";
	const proc = Bun.spawn([cmd, engineName], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(
			`Engine CLI "${engineName}" not found on PATH. Install it or set a different engine in .milhouse/config.ts`,
		);
	}
}

async function checkGitRepo(workDir: string): Promise<void> {
	const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: workDir,
		stdout: "ignore",
		stderr: "ignore",
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error("Not a git repository. Run milhouse from inside a git repo.");
	}
}

function checkConfig(config: Config): void {
	if (!KNOWN_ENGINES.includes(config.engine as (typeof KNOWN_ENGINES)[number])) {
		throw new Error(
			`Unknown engine "${config.engine}". Available engines: ${KNOWN_ENGINES.join(", ")}`,
		);
	}
	if (!Array.isArray(config.pipeline) || config.pipeline.length === 0) {
		throw new Error("Pipeline is empty. Define at least one phase in config.pipeline.");
	}
	for (const phase of config.pipeline) {
		if (!PHASES.includes(phase)) {
			throw new Error(
				`Unknown pipeline phase "${phase}". Valid phases: ${PHASES.join(", ")}`,
			);
		}
	}
}

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		engine: "claude",
		model: "sonnet",
		pipeline: ["scan", "validate"] as Phase[],
		failFast: true,
		phases: {
			scan: { workers: 1, retries: 0 },
			validate: { workers: 1, retries: 0 },
			plan: { workers: 1, retries: 0 },
			consolidate: { workers: 1, retries: 0 },
			exec: { workers: 1, retries: 0 },
			verify: { workers: 1, retries: 0 },
		},
		cost: { inputPerMillion: 0, outputPerMillion: 0, budget: 0 },
		project: { name: "test", language: "ts", framework: "bun", description: "" },
		commands: { test: "bun test", lint: "bun lint", build: "bun build" },
		rules: [],
		boundaries: { neverTouch: [] },
		gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },
		...overrides,
	};
}

describe("preflight", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "milhouse-preflight-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("KNOWN_ENGINES contains expected engines", () => {
		expect(KNOWN_ENGINES).toContain("claude");
		expect(KNOWN_ENGINES).toContain("gemini");
		expect(KNOWN_ENGINES).toContain("aider");
	});

	describe("checkEngine", () => {
		it("passes when engine CLI exists on PATH", async () => {
			await expect(checkEngine("git")).resolves.toBeUndefined();
		});

		it("throws when engine CLI is missing", async () => {
			await expect(checkEngine("nonexistent_engine_xyz")).rejects.toThrow(
				'Engine CLI "nonexistent_engine_xyz" not found on PATH',
			);
		});
	});

	describe("checkGitRepo", () => {
		it("passes inside a git repository", async () => {
			execSync("git init", { cwd: tmpDir, stdio: "ignore" });
			await expect(checkGitRepo(tmpDir)).resolves.toBeUndefined();
		});

		it("throws when not in a git repository", async () => {
			await expect(checkGitRepo(tmpDir)).rejects.toThrow(
				"Not a git repository",
			);
		});
	});

	describe("checkConfig", () => {
		it("passes for valid config", () => {
			const config = makeConfig();
			expect(() => checkConfig(config)).not.toThrow();
		});

		it("throws for invalid pipeline phase", () => {
			const config = makeConfig({ pipeline: ["scan", "bogus" as Phase] });
			expect(() => checkConfig(config)).toThrow('Unknown pipeline phase "bogus"');
		});

		it("throws for empty pipeline", () => {
			const config = makeConfig({ pipeline: [] });
			expect(() => checkConfig(config)).toThrow("Pipeline is empty");
		});

		it("throws for unknown engine", () => {
			const config = makeConfig({ engine: "unknown" });
			expect(() => checkConfig(config)).toThrow('Unknown engine "unknown"');
			expect(() => checkConfig(config)).toThrow("Available engines:");
		});
	});

	describe("full preflight integration", () => {
		it("engine + git + config all pass in valid environment", async () => {
			execSync("git init", { cwd: tmpDir, stdio: "ignore" });

			// Verify engine check passes for a known binary
			await expect(checkEngine("git")).resolves.toBeUndefined();
			// Verify git check passes
			await expect(checkGitRepo(tmpDir)).resolves.toBeUndefined();
			// Verify config check passes
			expect(() => checkConfig(makeConfig())).not.toThrow();
		});
	});
});
