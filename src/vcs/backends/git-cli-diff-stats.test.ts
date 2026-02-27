import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as gitCli from "./git-cli";
import { ok } from "../types";

const CORRECT_EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf899d69f8255809c";

describe("getCommitDiffStats", () => {
	let runGitCommandSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		runGitCommandSpy?.mockRestore();
	});

	test("uses correct 40-character empty tree hash when first diff fails", async () => {
		const capturedArgs: string[][] = [];

		runGitCommandSpy = spyOn(gitCli, "runGitCommand").mockImplementation(async (args: string[]) => {
			capturedArgs.push([...args]);

			// First call: commitHash~1 diff fails with non-zero exit code
			if (args[2]?.includes("~1")) {
				return ok({
					exitCode: 128,
					stdout: "",
					stderr: "unknown revision",
					timedOut: false,
					duration: 10,
				});
			}

			// Second call: fallback with empty tree hash — return valid stats
			return ok({
				exitCode: 0,
				stdout: " 3 files changed, 10 insertions(+), 2 deletions(-)\n",
				stderr: "",
				timedOut: false,
				duration: 10,
			});
		});

		await gitCli.getCommitDiffStats("/tmp/repo", "abc123");

		// Verify the fallback call was made
		expect(capturedArgs.length).toBe(2);

		// The second call should use the correct empty tree hash
		const fallbackArgs = capturedArgs[1];
		expect(fallbackArgs).toContain(CORRECT_EMPTY_TREE_HASH);

		// Verify the hash is exactly 40 characters
		const hashArg = fallbackArgs.find((arg) => arg.length === 40 && /^[0-9a-f]+$/.test(arg));
		expect(hashArg).toBe(CORRECT_EMPTY_TREE_HASH);
	});

	test("returns parsed stats from fallback empty tree diff", async () => {
		runGitCommandSpy = spyOn(gitCli, "runGitCommand").mockImplementation(async (args: string[]) => {
			if (args[2]?.includes("~1")) {
				return ok({
					exitCode: 128,
					stdout: "",
					stderr: "unknown revision",
					timedOut: false,
					duration: 10,
				});
			}
			return ok({
				exitCode: 0,
				stdout: " 5 files changed, 20 insertions(+), 8 deletions(-)\n",
				stderr: "",
				timedOut: false,
				duration: 10,
			});
		});

		const result = await gitCli.getCommitDiffStats("/tmp/repo", "abc123");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.filesChanged).toBe(5);
			expect(result.value.insertions).toBe(20);
			expect(result.value.deletions).toBe(8);
		}
	});
});
