import { beforeEach, describe, expect, mock, test } from "bun:test";

const logWarnMock = mock((..._args: unknown[]) => {});

mock.module("../ui/logger.ts", () => ({
	logWarn: (...args: unknown[]) => logWarnMock(...args),
	logInfo: () => {},
	logError: () => {},
	logDebug: () => {},
	logSuccess: () => {},
	setVerbose: () => {},
	isVerbose: () => false,
	formatTask: (t: string) => t,
	formatDuration: (ms: number) => `${ms}ms`,
	formatTokens: () => "",
}));

const { resolveConfig, VALID_PHASES } = await import("./define.ts");
type Config = Parameters<typeof resolveConfig>[0];

describe("resolveConfig budgetLimit", () => {
	test("default budgetLimit is 50", () => {
		const config = resolveConfig({});
		expect(config.cost.budgetLimit).toBe(50);
	});

	test("explicit budgetLimit: 0 preserves unlimited", () => {
		const config = resolveConfig({ cost: { budgetLimit: 0 } });
		expect(config.cost.budgetLimit).toBe(0);
	});

	test("explicit budgetLimit overrides default", () => {
		const config = resolveConfig({ cost: { budgetLimit: 10 } });
		expect(config.cost.budgetLimit).toBe(10);
	});
});

describe("mergePhases phase key validation", () => {
	beforeEach(() => {
		logWarnMock.mockClear();
	});

	test("valid phase keys merge normally", () => {
		const config: Config = {
			phases: { exec: { workers: 10 } },
		};
		const resolved = resolveConfig(config);
		expect(resolved.phases.exec.workers).toBe(10);
		expect(resolved.phases.exec.model).toBe("opus");
		expect(resolved.phases.exec.retries).toBe(3);
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("invalid phase key logs warning and is skipped", () => {
		const config = {
			phases: { exce: { workers: 10 } },
		} as unknown as Config;
		const resolved = resolveConfig(config);

		expect(logWarnMock).toHaveBeenCalledTimes(1);
		const msg = String(logWarnMock.mock.calls[0][0]);
		expect(msg).toContain("exce");
		expect(msg).toContain("exec");

		// The invalid key should not affect the result
		expect(resolved.phases.exec.workers).toBe(3);
	});

	test("closest-match accuracy for common typos", () => {
		const typos: [string, string][] = [
			["exce", "exec"],
			["scna", "scan"],
			["varify", "verify"],
			["plann", "plan"],
		];

		for (const [typo, expected] of typos) {
			logWarnMock.mockClear();
			const config = {
				phases: { [typo]: { workers: 99 } },
			} as unknown as Config;
			resolveConfig(config);

			expect(logWarnMock).toHaveBeenCalledTimes(1);
			const msg = String(logWarnMock.mock.calls[0][0]);
			expect(msg).toContain(typo);
			expect(msg).toContain(expected);
		}
	});

	test("multiple invalid keys each produce their own warning", () => {
		const config = {
			phases: { exce: { workers: 1 }, scna: { workers: 2 } },
		} as unknown as Config;
		resolveConfig(config);

		expect(logWarnMock).toHaveBeenCalledTimes(2);
		const msg0 = String(logWarnMock.mock.calls[0][0]);
		const msg1 = String(logWarnMock.mock.calls[1][0]);
		expect(msg0).toContain("exce");
		expect(msg1).toContain("scna");
	});

	test("no warnings when phases is undefined", () => {
		const config: Config = {};
		resolveConfig(config);
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("no warnings for empty phases object", () => {
		const config: Config = { phases: {} };
		resolveConfig(config);
		expect(logWarnMock).toHaveBeenCalledTimes(0);
	});

	test("VALID_PHASES contains all 6 phase names", () => {
		expect(VALID_PHASES).toEqual(["scan", "validate", "plan", "consolidate", "exec", "verify"]);
		expect(VALID_PHASES.length).toBe(6);
	});
});

describe("resolveConfig gates", () => {
	test("default gates values are all true when no gates provided", () => {
		const config = resolveConfig({});
		expect(config.gates).toEqual({
			evidence: true,
			diffHygiene: true,
			placeholder: true,
			dod: true,
		});
	});

	test("explicit false values override defaults", () => {
		const config = resolveConfig({ gates: { evidence: false } });
		expect(config.gates.evidence).toBe(false);
		expect(config.gates.diffHygiene).toBe(true);
		expect(config.gates.placeholder).toBe(true);
		expect(config.gates.dod).toBe(true);
	});

	test("partial overrides only affect specified fields", () => {
		const config = resolveConfig({ gates: { diffHygiene: false, dod: false } });
		expect(config.gates.evidence).toBe(true);
		expect(config.gates.diffHygiene).toBe(false);
		expect(config.gates.placeholder).toBe(true);
		expect(config.gates.dod).toBe(false);
	});

	test("all fields explicitly set to false works", () => {
		const config = resolveConfig({
			gates: { evidence: false, diffHygiene: false, placeholder: false, dod: false },
		});
		expect(config.gates).toEqual({
			evidence: false,
			diffHygiene: false,
			placeholder: false,
			dod: false,
		});
	});

	test("empty gates object preserves all defaults", () => {
		const config = resolveConfig({ gates: {} });
		expect(config.gates).toEqual({
			evidence: true,
			diffHygiene: true,
			placeholder: true,
			dod: true,
		});
	});
});
