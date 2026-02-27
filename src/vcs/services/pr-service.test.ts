/**
 * @fileoverview Unit Tests for VCS PR Service — shell option
 *
 * Tests that the execCommand helper passes shell: true to spawn(),
 * ensuring .cmd/.bat shims are resolved on Windows.
 *
 * @module vcs/services/pr-service.test
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { PrService } from "./pr-service";

describe("PrService execCommand shell option", () => {
	let spawnSpy: ReturnType<typeof spyOn>;
	let prService: PrService;

	beforeEach(() => {
		prService = new PrService();
		spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() => {
			const child = new EventEmitter();
			const stdout = new Readable({ read() {} });
			const stderr = new Readable({ read() {} });
			Object.assign(child, { stdout, stderr, stdin: null, pid: 12345 });

			process.nextTick(() => {
				stdout.push(null);
				stderr.push(null);
				child.emit("close", 0);
			});

			return child;
		}) as unknown as typeof childProcess.spawn);
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("spawn is called with shell: true in options", async () => {
		await prService.isGhAvailable();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const opts = spawnSpy.mock.calls[0][2] as childProcess.SpawnOptions;
		expect(opts.shell).toBe(true);
	});

	test("spawn receives correct command, args, and cwd", async () => {
		await prService.isGhAvailable();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const [command, args, opts] = spawnSpy.mock.calls[0] as [
			string,
			string[],
			childProcess.SpawnOptions,
		];
		expect(command).toBe("gh");
		expect(args).toEqual(["auth", "status"]);
		expect(opts.cwd).toBe(process.cwd());
	});
});
