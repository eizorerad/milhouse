/**
 * Tests for config loading.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `milhouse-config-test-${Date.now()}`);
		mkdirSync(join(tempDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("warns and returns defaults when config has a runtime error", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `throw new Error("broken config");`);

		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const config = await loadConfig(tempDir);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const msg = warnSpy.mock.calls[0][0] as string;
			expect(msg).toContain("Failed to load config");
			expect(msg).toContain(configPath);
			expect(msg).toContain("Using defaults");

			expect(config.engine).toBe("claude");
			expect(config.failFast).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("merges valid user config with defaults", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { engine: "gemini", model: "pro" };`);

		const config = await loadConfig(tempDir);

		expect(config.engine).toBe("gemini");
		expect(config.model).toBe("pro");
		expect(config.failFast).toBe(true);
	});

	it("applies CLI overrides on top of user config", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { engine: "gemini" };`);

		const config = await loadConfig(tempDir, { model: "opus" });

		expect(config.engine).toBe("gemini");
		expect(config.model).toBe("opus");
	});

	it("throws ConfigError for invalid engine", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { engine: "gpt4" };`);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for invalid pipeline entry", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { pipeline: ["scan", "bogus"] };`);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for negative workers", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, "export default { phases: { scan: { workers: -1, retries: 2 } } };");

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for negative budget", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(
			configPath,
			"export default { cost: { inputPerMillion: 5, outputPerMillion: 25, budget: -5 } };",
		);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for negative retries", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(
			configPath,
			"export default { phases: { validate: { workers: 5, retries: -1 } } };",
		);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for negative budget", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(
			configPath,
			`export default { cost: { inputPerMillion: 5, outputPerMillion: 25, budget: -5 } };`,
		);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError for negative retries", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(
			configPath,
			`export default { phases: { validate: { workers: 5, retries: -1 } } };`,
		);

		expect(loadConfig(tempDir)).rejects.toThrow(ConfigError);
	});

	it("warns on unknown top-level key", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { engine: "claude", unknownKey: true };`);

		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const config = await loadConfig(tempDir);
			expect(config.engine).toBe("claude");
			expect(warnSpy).toHaveBeenCalled();
			const msgs = warnSpy.mock.calls.map((c) => c[0] as string);
			expect(msgs.some((m) => m.includes("unknownKey"))).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("accepts valid config with engine 'gemini'", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { engine: "gemini" };`);

		const config = await loadConfig(tempDir);
		expect(config.engine).toBe("gemini");
	});

	it("accepts empty pipeline array", async () => {
		const configPath = join(tempDir, ".milhouse", "config.ts");
		writeFileSync(configPath, `export default { pipeline: [] };`);

		const config = await loadConfig(tempDir);
		expect(config.pipeline).toEqual([]);
	});

	it("returns defaults when no config file exists", async () => {
		const emptyDir = join(tmpdir(), `milhouse-noconfig-${Date.now()}`);
		mkdirSync(emptyDir, { recursive: true });

		try {
			const config = await loadConfig(emptyDir);
			expect(config.engine).toBe("claude");
			expect(config.model).toBe("sonnet");
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});
