import { beforeEach, describe, expect, it } from "bun:test";
import type { EngineResult, Issue, IssueGroup, PhaseResult } from "../src/types.ts";

function makeIssueGroup(issueId: string): IssueGroup {
	return {
		issueId,
		issue: { id: issueId } as Issue,
		tasks: [],
	};
}

function makePhaseResult(issueId: string, success: boolean): PhaseResult {
	return {
		item: makeIssueGroup(issueId),
		result: null,
		success,
		tokens: { response: "", inputTokens: 0, outputTokens: 0 } as EngineResult,
	};
}

/** Create a mock ReadableStream that yields the given text. */
function mockStream(text: string) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("mergeCompletedBranches", () => {
	let gitCalls: string[][];
	let spawnResults: Map<string, { exitCode: number }>;
	let originalSpawn: typeof Bun.spawn;

	beforeEach(() => {
		gitCalls = [];
		spawnResults = new Map();
		originalSpawn = Bun.spawn;

		// @ts-expect-error — mocking Bun.spawn
		Bun.spawn = (cmd: string[], _opts?: unknown) => {
			const args = cmd.slice(1); // strip "git"
			gitCalls.push(args);

			// Determine exit code based on merge command + branch
			const key = args.join(" ");
			const entry = spawnResults.get(key);
			const exitCode = entry?.exitCode ?? 0;

			return {
				stdout: mockStream(""),
				stderr: mockStream(""),
				exited: Promise.resolve(exitCode),
			};
		};
	});

	// Restore after each test
	function restore() {
		Bun.spawn = originalSpawn;
	}

	it("deletes all branches when all merges succeed", async () => {
		const { mergeCompletedBranches } = await import("../src/git.ts");
		const results = [makePhaseResult("issue-1", true), makePhaseResult("issue-2", true)];

		await mergeCompletedBranches(results, "/fake/dir");
		restore();

		const merges = gitCalls.filter((c) => c[0] === "merge");
		const deletes = gitCalls.filter((c) => c[0] === "branch" && c[1] === "-D");

		expect(merges).toHaveLength(2);
		expect(deletes).toHaveLength(2);
		expect(deletes.map((c) => c[2])).toEqual(["mh/issue-1", "mh/issue-2"]);
	});

	it("only deletes successfully merged branches when some fail", async () => {
		// Make merge of issue-2 fail
		spawnResults.set("merge --no-ff mh/issue-2 -m Merge mh/issue-2", { exitCode: 1 });

		const { mergeCompletedBranches } = await import("../src/git.ts");
		const results = [
			makePhaseResult("issue-1", true),
			makePhaseResult("issue-2", true),
			makePhaseResult("issue-3", true),
		];

		await mergeCompletedBranches(results, "/fake/dir");
		restore();

		const deletes = gitCalls.filter((c) => c[0] === "branch" && c[1] === "-D");
		const deletedBranches = deletes.map((c) => c[2]);

		expect(deletedBranches).toContain("mh/issue-1");
		expect(deletedBranches).toContain("mh/issue-3");
		expect(deletedBranches).not.toContain("mh/issue-2");

		// Verify merge --abort was called for the failed branch
		const aborts = gitCalls.filter((c) => c[0] === "merge" && c[1] === "--abort");
		expect(aborts).toHaveLength(1);
	});

	it("deletes no branches when all merges fail", async () => {
		spawnResults.set("merge --no-ff mh/issue-1 -m Merge mh/issue-1", { exitCode: 1 });
		spawnResults.set("merge --no-ff mh/issue-2 -m Merge mh/issue-2", { exitCode: 1 });

		const { mergeCompletedBranches } = await import("../src/git.ts");
		const results = [makePhaseResult("issue-1", true), makePhaseResult("issue-2", true)];

		await mergeCompletedBranches(results, "/fake/dir");
		restore();

		const deletes = gitCalls.filter((c) => c[0] === "branch" && c[1] === "-D");
		expect(deletes).toHaveLength(0);

		// Both should have had merge --abort called
		const aborts = gitCalls.filter((c) => c[0] === "merge" && c[1] === "--abort");
		expect(aborts).toHaveLength(2);
	});
});
