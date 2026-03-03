import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logWarnMock = mock((..._args: unknown[]) => {});
const logDebugMock = mock((..._args: unknown[]) => {});

mock.module("../ui/logger.ts", () => ({
	logWarn: (...args: unknown[]) => logWarnMock(...args),
	logInfo: () => {},
	logError: () => {},
	logDebug: (...args: unknown[]) => logDebugMock(...args),
	logSuccess: () => {},
	setVerbose: () => {},
	isVerbose: () => false,
	formatTask: (t: string) => t,
	formatDuration: (ms: number) => `${ms}ms`,
	formatTokens: () => "",
}));

const { loadUserConfig, clearConfigCache } = await import("./loader.ts");

describe("config loader error logging", () => {
	let tempDir: string;

	beforeEach(() => {
		clearConfigCache();
		logWarnMock.mockClear();
		logDebugMock.mockClear();
		tempDir = mkdtempSync(join(tmpdir(), "milhouse-loader-test-"));
	});

	test("syntax error in TS config triggers logWarn", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.ts"), "export default {{{");

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const msg = String(logWarnMock.mock.calls[0][0]);
		expect(msg).toContain("config.ts");
	});

	test("YAML parse error triggers logWarn", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.yaml"), "key: [unclosed");

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const msg = String(logWarnMock.mock.calls[0][0]);
		expect(msg).toContain("config.yaml");
	});

	test("valid TS config loads without warnings", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.ts"),
			"export default { cost: { budgetLimit: 42 } };",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 42 } });
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("valid YAML config loads without warnings", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yaml"),
			"cost:\n  budgetLimit: 99\n",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 99 } });
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("no config files returns empty object without warnings", async () => {
		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(0);
		expect(logDebugMock).toHaveBeenCalledTimes(0);
	});

	test("TS failure falls through to valid YAML", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.ts"), "export default {{{");
		writeFileSync(
			join(configDir, "config.yaml"),
			"cost:\n  budgetLimit: 77\n",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 77 } });
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const msg = String(logWarnMock.mock.calls[0][0]);
		expect(msg).toContain("config.ts");
	});
});
