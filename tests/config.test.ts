import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logWarnMock = mock((..._args: unknown[]) => {});
const logDebugMock = mock((..._args: unknown[]) => {});

mock.module("../src/ui/logger.ts", () => ({
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

const { loadUserConfig, clearConfigCache } = await import("../src/config/loader.ts");

describe("config loader error handling", () => {
	let tempDir: string;

	beforeEach(() => {
		clearConfigCache();
		logWarnMock.mockClear();
		logDebugMock.mockClear();
		tempDir = mkdtempSync(join(tmpdir(), "milhouse-config-test-"));
	});

	test("successful config load - no warnings", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.ts"),
			"export default { cost: { budgetLimit: 100 } };",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 100 } });
		expect(logWarnMock).toHaveBeenCalledTimes(0);
		expect(logDebugMock).toHaveBeenCalledTimes(0);
	});

	test("missing config file - no warning", async () => {
		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(0);
		expect(logDebugMock).toHaveBeenCalledTimes(0);
	});

	test("config with syntax error - warning logged", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.ts"), "export default {{{ invalid syntax");

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const warnMsg = String(logWarnMock.mock.calls[0][0]);
		expect(warnMsg).toContain("Failed to load .milhouse/config.ts");
	});

	test("config with runtime error - warning logged", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		// Runtime error: referencing undefined variable
		writeFileSync(
			join(configDir, "config.ts"),
			"export default { value: undefinedVariable };",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const warnMsg = String(logWarnMock.mock.calls[0][0]);
		expect(warnMsg).toContain("Failed to load .milhouse/config.ts");
	});

	test("YAML parse error - warning logged", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.yaml"), "invalid: [unclosed array");

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({});
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const warnMsg = String(logWarnMock.mock.calls[0][0]);
		expect(warnMsg).toContain("config.yaml");
	});

	test("valid YAML config loads without warnings", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yaml"),
			"cost:\n  budgetLimit: 200\n",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 200 } });
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("TS error falls back to YAML with warning", async () => {
		const configDir = join(tempDir, ".milhouse");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.ts"), "export default {{{ invalid");
		writeFileSync(
			join(configDir, "config.yaml"),
			"cost:\n  budgetLimit: 150\n",
		);

		const result = await loadUserConfig(tempDir);
		expect(result).toEqual({ cost: { budgetLimit: 150 } });
		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const warnMsg = String(logWarnMock.mock.calls[0][0]);
		expect(warnMsg).toContain("config.ts");
	});
});
