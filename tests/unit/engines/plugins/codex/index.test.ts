import { describe, expect, it } from "bun:test";
import { CodexPlugin } from "../../../../../src/engines/plugins/codex/index";

/** Build a minimal Codex execution request. */
function makeRequest(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "test prompt",
		workDir: "/tmp",
		timeout: 4000000,
		maxRetries: 3,
		streamOutput: true,
		...overrides,
	} as any;
}

describe("CodexPlugin", () => {
	const plugin = new CodexPlugin();

	describe("buildArgs", () => {
		it("starts with exec subcommand", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[0]).toBe("exec");
		});

		it("includes --model when modelOverride is set", () => {
			const args = plugin.buildArgs(makeRequest({ modelOverride: "o3-mini" }));
			expect(args).toContain("--model");
			expect(args).toContain("o3-mini");
		});

		it("includes --cd with workDir", () => {
			const args = plugin.buildArgs(makeRequest({ workDir: "/my/project" }));
			expect(args).toContain("--cd");
			expect(args).toContain("/my/project");
		});

		it("includes --json when jsonSchema is set", () => {
			const args = plugin.buildArgs(
				makeRequest({ jsonSchema: { type: "object" } }),
			);
			expect(args).toContain("--json");
		});

		it("does not include --json when jsonSchema is not set", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).not.toContain("--json");
		});

		it("includes --add-dir for each additional directory", () => {
			const args = plugin.buildArgs(
				makeRequest({ additionalDirs: ["/extra1", "/extra2"] }),
			);
			const addDirIndices = args.reduce((acc: number[], val, idx) => {
				if (val === "--add-dir") acc.push(idx);
				return acc;
			}, []);
			expect(addDirIndices.length).toBe(2);
			expect(args[addDirIndices[0] + 1]).toBe("/extra1");
			expect(args[addDirIndices[1] + 1]).toBe("/extra2");
		});

		it("includes --sandbox read-only when disallowedTools present", () => {
			const args = plugin.buildArgs(
				makeRequest({ disallowedTools: ["shell"] }),
			);
			expect(args).toContain("--sandbox");
			const sandboxIdx = args.indexOf("--sandbox");
			expect(args[sandboxIdx + 1]).toBe("read-only");
		});

		it("includes --sandbox workspace-write when allowedTools present (no disallowed)", () => {
			const args = plugin.buildArgs(
				makeRequest({ allowedTools: ["read", "write"] }),
			);
			expect(args).toContain("--sandbox");
			const sandboxIdx = args.indexOf("--sandbox");
			expect(args[sandboxIdx + 1]).toBe("workspace-write");
		});

		it("prefers read-only sandbox when both allowed and disallowed tools present", () => {
			const args = plugin.buildArgs(
				makeRequest({
					allowedTools: ["read"],
					disallowedTools: ["shell"],
				}),
			);
			const sandboxIdx = args.indexOf("--sandbox");
			expect(args[sandboxIdx + 1]).toBe("read-only");
		});

		it("includes --last when continueSession is true", () => {
			const args = plugin.buildArgs(makeRequest({ continueSession: true }));
			expect(args).toContain("--last");
		});

		it("includes resume subcommand for resumeSession", () => {
			const args = plugin.buildArgs(makeRequest({ resumeSession: "session-123" }));
			// resume is spliced at index 1 (after exec)
			expect(args[1]).toBe("resume");
			expect(args).toContain("session-123");
		});

		it("includes prompt as last positional arg", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[args.length - 1]).toBe("test prompt");
		});
	});

	describe("parseOutput", () => {
		it("delegates to parseTextOutput for plain text", () => {
			const result = plugin.parseOutput("Some text output\nresult: done");
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
		});

		it("detects errors via text parser patterns", () => {
			const result = plugin.parseOutput("error: something broke");
			expect(result.success).toBe(false);
		});

		it("produces valid ExecutionResult structure", () => {
			const result = plugin.parseOutput("hello world");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("output");
			expect(result).toHaveProperty("steps");
			expect(result).toHaveProperty("duration");
			expect(Array.isArray(result.steps)).toBe(true);
		});

		it("handles empty output", () => {
			const result = plugin.parseOutput("");
			expect(result.success).toBe(true);
		});
	});

	describe("plugin properties", () => {
		it("has name 'codex'", () => {
			expect(plugin.name).toBe("codex");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("config command is 'codex'", () => {
			expect(plugin.config.command).toBe("codex");
		});

		it("getEnv includes CI and NO_COLOR", () => {
			const env = plugin.getEnv();
			expect(env.CI).toBe("true");
			expect(env.NO_COLOR).toBe("1");
		});

		it("config has rate limit values", () => {
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(30);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(500);
			expect(plugin.config.rateLimit?.minTime).toBe(200);
		});
	});
});
