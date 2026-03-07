/**
 * Tests for worker CLI flags: --exec-workers, --phase-workers, --workers (deprecated).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkerOverrides } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

describe("buildWorkerOverrides", () => {
	let logSpy: ReturnType<typeof jest.spyOn>;

	beforeEach(() => {
		// log.warn uses console.log internally
		logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("--exec-workers sets exec phase workers", () => {
		const overrides = buildWorkerOverrides({ execWorkers: "5" });
		expect(overrides.phases).toEqual({ exec: { workers: 5 } });
	});

	it("--workers (deprecated) sets exec phase workers and warns", () => {
		const overrides = buildWorkerOverrides({ workers: "5" });
		expect(overrides.phases).toEqual({ exec: { workers: 5 } });
		const calls = logSpy.mock.calls.map((c) => String(c[0]));
		expect(calls.some((c) => c.includes("--workers is deprecated"))).toBe(true);
	});

	it("--exec-workers takes precedence over --workers", () => {
		const overrides = buildWorkerOverrides({ workers: "3", execWorkers: "7" });
		expect(overrides.phases).toEqual({ exec: { workers: 7 } });
	});

	it("--phase-workers sets workers for multiple phases", () => {
		const overrides = buildWorkerOverrides({ phaseWorkers: "validate=8,exec=2" });
		const phases = overrides.phases as Record<string, { workers: number }>;
		expect(phases.validate).toEqual({ workers: 8 });
		expect(phases.exec).toEqual({ workers: 2 });
	});

	it("--phase-workers warns and skips invalid phase names", () => {
		const overrides = buildWorkerOverrides({ phaseWorkers: "bogus=5,exec=2" });
		const phases = overrides.phases as Record<string, { workers: number }>;
		expect(phases.exec).toEqual({ workers: 2 });
		expect(phases.bogus).toBeUndefined();
		const calls = logSpy.mock.calls.map((c) => String(c[0]));
		expect(calls.some((c) => c.includes('unknown phase "bogus"'))).toBe(true);
	});

	it("--phase-workers warns and skips non-numeric counts", () => {
		const overrides = buildWorkerOverrides({ phaseWorkers: "exec=abc,validate=4" });
		const phases = overrides.phases as Record<string, { workers: number }>;
		expect(phases.validate).toEqual({ workers: 4 });
		expect(phases.exec).toBeUndefined();
		const calls = logSpy.mock.calls.map((c) => String(c[0]));
		expect(calls.some((c) => c.includes('invalid count for "exec"'))).toBe(true);
	});

	it("--phase-workers exec=N overrides --exec-workers", () => {
		const overrides = buildWorkerOverrides({ execWorkers: "5", phaseWorkers: "exec=2" });
		const phases = overrides.phases as Record<string, { workers: number }>;
		expect(phases.exec).toEqual({ workers: 2 });
	});
});

describe("loadConfig with worker overrides", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `milhouse-workers-test-${Date.now()}`);
		mkdirSync(join(tempDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("--exec-workers override merges into config phases", async () => {
		const config = await loadConfig(tempDir, { phases: { exec: { workers: 10 } } } as any);
		expect(config.phases.exec.workers).toBe(10);
		// Other phases keep defaults
		expect(config.phases.validate.workers).toBe(5);
	});

	it("--phase-workers overrides merge into config phases", async () => {
		const config = await loadConfig(tempDir, {
			phases: { validate: { workers: 8 }, exec: { workers: 2 } },
		} as any);
		expect(config.phases.validate.workers).toBe(8);
		expect(config.phases.exec.workers).toBe(2);
		// Retries preserved from defaults
		expect(config.phases.validate.retries).toBe(2);
		expect(config.phases.exec.retries).toBe(3);
	});
});
