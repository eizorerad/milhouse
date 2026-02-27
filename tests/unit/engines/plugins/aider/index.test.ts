import { describe, expect, it } from "bun:test";
import { AiderPlugin } from "../../../../../src/engines/plugins/aider/index";

/** Build a minimal Aider execution request. */
function makeRequest(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "test prompt",
		workDir: "/tmp",
		timeout: 4000000,
		maxRetries: 3,
		streamOutput: false,
		...overrides,
	} as any;
}

describe("AiderPlugin", () => {
	const plugin = new AiderPlugin();

	describe("parseOutput - error detection", () => {
		it("detects 'Error: message' pattern", () => {
			const output = "Processing files...\nError: Could not connect to API\nDone.";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Could not connect to API");
			const errorStep = result.steps.find((s) => s.type === "error");
			expect(errorStep).toBeDefined();
		});

		it("detects 'error: message' pattern (lowercase)", () => {
			const output = "error: file not found";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("file not found");
		});

		it("detects 'FAILED' keyword", () => {
			const output = "Running tests...\nFAILED: 3 tests failed\nDone.";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("3 tests failed");
		});

		it("does not detect 'ERROR:' (all-caps without match in regex)", () => {
			// The regex pattern is /(?:Error|error|FAILED)[:\s]+(.+?)(?:\n|$)/
			// 'ERROR:' is NOT covered (case-sensitive match for Error/error/FAILED only).
			// This documents a gap in the current error detection logic.
			const output = "ERROR: something broke badly";
			const result = plugin.parseOutput(output);
			// The .includes("Error:") check won't match "ERROR:" either,
			// but .includes("FAILED") won't match. Let's check:
			// trimmed.includes("Error:") → false (case-sensitive)
			// trimmed.includes("error:") → false
			// trimmed.includes("FAILED") → false
			// So this will be treated as success - a gap in detection.
			expect(result.success).toBe(true);
			// Documenting: all-caps "ERROR:" is not detected by current code
		});

		it("captures first error line in multi-line error output", () => {
			const output = "Error: first problem\nError: second problem";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			// The regex matches the first occurrence
			expect(result.error).toBe("first problem");
		});

		it("handles 'Failed to apply changes' format", () => {
			// The includes check uses "Error:" and "error:" - "Failed" starts with capital F
			// but the pattern checks for "FAILED" specifically.
			// "Failed to apply changes" contains neither "Error:" nor "error:" nor "FAILED"
			// so it would NOT be detected as an error.
			const output = "Failed to apply changes to src/auth.ts";
			const result = plugin.parseOutput(output);
			// Documenting: "Failed to..." is not detected; only "FAILED" (all-caps) triggers detection.
			expect(result.success).toBe(true);
		});

		it("returns generic error when no message captured after marker", () => {
			// If somehow Error: is present but regex doesn't capture content
			const output = "Error:";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			// The regex match captures empty string after "Error:", fallback to "Aider execution failed"
			expect(result.error).toBeDefined();
		});
	});

	describe("parseOutput - commit detection", () => {
		it("extracts commit hash and message", () => {
			const output = "Applied changes to 2 files.\nCommit abc1234 fix: update auth module\nDone.";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			const commitStep = result.steps.find((s) => s.metadata?.commitHash);
			expect(commitStep).toBeDefined();
			expect(commitStep!.metadata?.commitHash).toBe("abc1234");
			expect(commitStep!.metadata?.commitMessage).toBe("fix: update auth module");
		});

		it("handles short commit hashes", () => {
			const output = "Commit abc12 short message";
			const result = plugin.parseOutput(output);
			const commitStep = result.steps.find((s) => s.metadata?.commitHash);
			expect(commitStep).toBeDefined();
			expect(commitStep!.metadata?.commitHash).toBe("abc12");
		});

		it("handles long commit hashes", () => {
			const output = "Commit abc1234567890def fix: something";
			const result = plugin.parseOutput(output);
			const commitStep = result.steps.find((s) => s.metadata?.commitHash);
			expect(commitStep).toBeDefined();
			expect(commitStep!.metadata?.commitHash).toBe("abc1234567890def");
		});
	});

	describe("parseOutput - file change detection", () => {
		it("detects Created file pattern", () => {
			const output = "Created src/new-file.ts\nDone.";
			const result = plugin.parseOutput(output);
			const fileStep = result.steps.find(
				(s) => s.type === "tool_use" && s.content.includes("Created"),
			);
			expect(fileStep).toBeDefined();
			expect(fileStep!.content).toContain("src/new-file.ts");
		});

		it("detects Modified file pattern", () => {
			const output = "Modified src/existing.ts\nDone.";
			const result = plugin.parseOutput(output);
			const fileStep = result.steps.find(
				(s) => s.type === "tool_use" && s.content.includes("Modified"),
			);
			expect(fileStep).toBeDefined();
		});

		it("detects Deleted file pattern", () => {
			const output = "Deleted src/old-file.ts";
			const result = plugin.parseOutput(output);
			const fileStep = result.steps.find(
				(s) => s.type === "tool_use" && s.content.includes("Deleted"),
			);
			expect(fileStep).toBeDefined();
		});

		it("detects multiple file changes", () => {
			const output = "Created src/a.ts\nModified src/b.ts\nDeleted src/c.ts";
			const result = plugin.parseOutput(output);
			const fileSteps = result.steps.filter((s) => s.type === "tool_use");
			expect(fileSteps.length).toBe(3);
		});
	});

	describe("parseOutput - successful output", () => {
		it("treats output with no error patterns as success", () => {
			const output = "Applied changes to 2 files.\nAll tests passed.";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("creates a single result step for plain output", () => {
			const output = "No changes needed.";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBe(1);
			expect(result.steps[0].type).toBe("result");
			expect(result.steps[0].content).toBe("No changes needed.");
		});
	});

	describe("parseOutput - empty output", () => {
		it("handles empty output with fallback result step", () => {
			const result = plugin.parseOutput("");
			expect(result.success).toBe(true);
			// Aider always adds a fallback result step with the trimmed output
			expect(result.steps.length).toBe(1);
			expect(result.steps[0].type).toBe("result");
			expect(result.steps[0].content).toBe("");
		});

		it("handles whitespace-only output with fallback result step", () => {
			const result = plugin.parseOutput("   \n\n  ");
			expect(result.success).toBe(true);
			expect(result.steps.length).toBe(1);
			expect(result.steps[0].content).toBe("");
		});
	});

	describe("parseOutput - lint and test results", () => {
		it("detects lint results", () => {
			const output = "Linting files...\nAll checks passed";
			const result = plugin.parseOutput(output);
			const lintStep = result.steps.find(
				(s) => s.content.includes("Lint"),
			);
			expect(lintStep).toBeDefined();
		});

		it("detects test results", () => {
			const output = "Testing complete\nAll tests passed";
			const result = plugin.parseOutput(output);
			const testStep = result.steps.find(
				(s) => s.content.includes("Tests") || s.content.includes("test"),
			);
			expect(testStep).toBeDefined();
		});
	});

	describe("buildArgs", () => {
		it("includes --message with prompt", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--message");
			const messageIdx = args.indexOf("--message");
			expect(args[messageIdx + 1]).toBe("test prompt");
		});

		it("includes --yes-always when autoApprove is not false", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--yes-always");
		});

		it("omits --yes-always when autoApprove is false", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false }));
			expect(args).not.toContain("--yes-always");
		});

		it("includes --no-stream when streamOutput is false", () => {
			const args = plugin.buildArgs(makeRequest({ streamOutput: false }));
			expect(args).toContain("--no-stream");
		});

		it("omits --no-stream when streamOutput is true", () => {
			const args = plugin.buildArgs(makeRequest({ streamOutput: true }));
			expect(args).not.toContain("--no-stream");
		});

		it("includes --model when modelOverride is set", () => {
			const args = plugin.buildArgs(makeRequest({ modelOverride: "gpt-4o" }));
			expect(args).toContain("--model");
			expect(args).toContain("gpt-4o");
		});

		it("includes --edit-format for mode mapping", () => {
			const args = plugin.buildArgs(makeRequest({ mode: "architect" }));
			expect(args).toContain("--edit-format");
			expect(args).toContain("architect");
		});

		it("includes metadata-driven flags", () => {
			const args = plugin.buildArgs(
				makeRequest({
					metadata: {
						dryRun: true,
						noAutoCommits: true,
						verbose: true,
						autoLint: true,
						lintCmd: "eslint .",
						autoTest: true,
						testCmd: "npm test",
						files: ["src/auth.ts", "src/user.ts"],
					},
				}),
			);
			expect(args).toContain("--dry-run");
			expect(args).toContain("--no-auto-commits");
			expect(args).toContain("--verbose");
			expect(args).toContain("--auto-lint");
			expect(args).toContain("--lint-cmd");
			expect(args).toContain("eslint .");
			expect(args).toContain("--auto-test");
			expect(args).toContain("--test-cmd");
			expect(args).toContain("npm test");
			expect(args).toContain("src/auth.ts");
			expect(args).toContain("src/user.ts");
		});

		it("includes --read for read-only files", () => {
			const args = plugin.buildArgs(
				makeRequest({ metadata: { readFiles: ["README.md", "docs/api.md"] } }),
			);
			const readIndices = args.reduce((acc: number[], val, idx) => {
				if (val === "--read") acc.push(idx);
				return acc;
			}, []);
			expect(readIndices.length).toBe(2);
			expect(args[readIndices[0] + 1]).toBe("README.md");
			expect(args[readIndices[1] + 1]).toBe("docs/api.md");
		});
	});

	describe("plugin properties", () => {
		it("has name 'aider'", () => {
			expect(plugin.name).toBe("aider");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("getEnv includes AIDER_YES_ALWAYS", () => {
			const env = plugin.getEnv();
			expect(env.AIDER_YES_ALWAYS).toBe("true");
			expect(env.AIDER_ANALYTICS).toBe("false");
			expect(env.AIDER_CHECK_UPDATE).toBe("false");
		});

		it("config has rate limit values", () => {
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(30);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(500);
			expect(plugin.config.rateLimit?.minTime).toBe(200);
		});
	});
});
