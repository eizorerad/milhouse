/**
 * Tests for AI merge resolver — prompt, git helpers, resolve flow.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { buildResolvePrompt } from "../src/prompts/resolve.ts";

// ─── Prompt Tests ───────────────────────────────────────────────────────────

describe("buildResolvePrompt", () => {
	it("includes branch name and conflict files", () => {
		const prompt = buildResolvePrompt("mh/issue-1", ["src/ui.ts", "src/pipeline.ts"]);
		expect(prompt).toContain("mh/issue-1");
		expect(prompt).toContain("src/ui.ts");
		expect(prompt).toContain("src/pipeline.ts");
	});

	it("includes merge resolver role", () => {
		const prompt = buildResolvePrompt("mh/test", ["file.ts"]);
		expect(prompt).toContain("Merge Resolver");
	});

	it("includes protocol steps", () => {
		const prompt = buildResolvePrompt("mh/test", ["a.ts"]);
		expect(prompt).toContain("git diff");
		expect(prompt).toContain("git add");
		expect(prompt).toContain("git commit --no-edit");
	});

	it("includes rules about not dropping changes", () => {
		const prompt = buildResolvePrompt("mh/test", ["a.ts"]);
		expect(prompt).toContain("NEVER drop changes");
	});
});

// ─── Git Helper Tests ───────────────────────────────────────────────────────

describe("listUnmergedBranches", () => {
	let gitCalls: string[][];
	let originalSpawn: typeof Bun.spawn;
	let spawnOutput: string;

	function mockStream(text: string) {
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		});
	}

	beforeEach(() => {
		gitCalls = [];
		spawnOutput = "";
		originalSpawn = Bun.spawn;
		// @ts-expect-error — mocking Bun.spawn
		Bun.spawn = (cmd: string[], _opts?: unknown) => {
			gitCalls.push(cmd.slice(1));
			return {
				stdout: mockStream(spawnOutput),
				stderr: mockStream(""),
				exited: Promise.resolve(0),
			};
		};
	});

	function restore() {
		Bun.spawn = originalSpawn;
	}

	it("parses branch list output", async () => {
		spawnOutput = "  mh/issue-1\n  mh/issue-2\n";
		const { listUnmergedBranches } = await import("../src/git.ts");
		const branches = await listUnmergedBranches("/fake");
		restore();

		expect(branches).toEqual(["mh/issue-1", "mh/issue-2"]);
	});

	it("returns empty array when no branches", async () => {
		spawnOutput = "";
		const { listUnmergedBranches } = await import("../src/git.ts");
		const branches = await listUnmergedBranches("/fake");
		restore();

		expect(branches).toEqual([]);
	});
});

describe("isWorkingTreeDirty", () => {
	let originalSpawn: typeof Bun.spawn;
	let spawnOutput: string;

	function mockStream(text: string) {
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		});
	}

	beforeEach(() => {
		spawnOutput = "";
		originalSpawn = Bun.spawn;
		// @ts-expect-error — mocking Bun.spawn
		Bun.spawn = (_cmd: string[], _opts?: unknown) => ({
			stdout: mockStream(spawnOutput),
			stderr: mockStream(""),
			exited: Promise.resolve(0),
		});
	});

	function restore() {
		Bun.spawn = originalSpawn;
	}

	it("returns true when there are uncommitted changes", async () => {
		spawnOutput = " M src/ui.ts\n";
		const { isWorkingTreeDirty } = await import("../src/git.ts");
		const dirty = await isWorkingTreeDirty("/fake");
		restore();
		expect(dirty).toBe(true);
	});

	it("returns false when working tree is clean", async () => {
		spawnOutput = "";
		const { isWorkingTreeDirty } = await import("../src/git.ts");
		const dirty = await isWorkingTreeDirty("/fake");
		restore();
		expect(dirty).toBe(false);
	});
});

// ─── MergeAttempt type tests ────────────────────────────────────────────────

import type { MergeAttempt } from "../src/resolve.ts";

describe("MergeAttempt shape", () => {
	it("clean merge attempt has no conflict files", () => {
		const attempt: MergeAttempt = {
			branch: "mh/test",
			status: "clean",
			conflictFiles: [],
		};
		expect(attempt.status).toBe("clean");
		expect(attempt.conflictFiles).toEqual([]);
	});

	it("resolved attempt includes conflict files and resolution", () => {
		const resolved: MergeAttempt = {
			branch: "mh/test",
			status: "resolved",
			conflictFiles: ["a.ts"],
			resolution: "Combined both changes",
		};
		expect(resolved.conflictFiles).toEqual(["a.ts"]);
		expect(resolved.resolution).toContain("Combined");
	});

	it("failed attempt has no resolution", () => {
		const failed: MergeAttempt = {
			branch: "mh/test",
			status: "failed",
			conflictFiles: ["x.ts", "y.ts"],
		};
		expect(failed.status).toBe("failed");
		expect(failed.resolution).toBeUndefined();
	});
});
