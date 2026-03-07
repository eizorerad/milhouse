/**
 * Tests for preflight checks.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config, Phase } from "../src/types.ts";
import { KNOWN_ENGINES, checkEngine, checkGitRepo, checkConfig, preflight } from "../src/preflight.ts";

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

	it("exports KNOWN_ENGINES", () => {
		expect(KNOWN_ENGINES).toContain("claude");
		expect(KNOWN_ENGINES).toContain("gemini");
		expect(KNOWN_ENGINES).toContain("aider");
	});

	describe("checkEngine", () => {
		it("passes when engine CLI exists on PATH", async () => {
			// 'git' is always available
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

	describe("full preflight", () => {
		it("resolves when all checks pass", async () => {
			execSync("git init", { cwd: tmpDir, stdio: "ignore" });

			// Use 'git' as engine since it's always available, but config check
			// requires known engine. Instead, check if claude is on PATH.
			const cmd = process.platform === "win32" ? "where" : "which";
			const proc = Bun.spawn([cmd, "claude"], { stdout: "ignore", stderr: "ignore" });
			const code = await proc.exited;
			if (code !== 0) {
				console.log("Skipping full happy path: claude CLI not on PATH");
				return;
			}

			const config = makeConfig();
			await expect(preflight(config, tmpDir)).resolves.toBeUndefined();
		});
	});
});
