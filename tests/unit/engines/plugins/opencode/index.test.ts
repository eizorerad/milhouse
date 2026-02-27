import { describe, expect, it } from "bun:test";
import { OpencodePlugin } from "../../../../../src/engines/plugins/opencode/index";

/** Build a minimal Opencode execution request. */
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

describe("OpencodePlugin", () => {
	const plugin = new OpencodePlugin();

	describe("buildArgs", () => {
		it("starts with run subcommand", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[0]).toBe("run");
		});

		it("includes --model with provider/model format", () => {
			const args = plugin.buildArgs(
				makeRequest({ modelOverride: "anthropic/claude-3-opus" }),
			);
			expect(args).toContain("--model");
			expect(args).toContain("anthropic/claude-3-opus");
		});

		it("includes --continue when continueSession is true", () => {
			const args = plugin.buildArgs(makeRequest({ continueSession: true }));
			expect(args).toContain("--continue");
		});

		it("includes --session with session ID", () => {
			const uuid = "550e8400-e29b-41d4-a716-446655440000";
			const args = plugin.buildArgs(makeRequest({ sessionId: uuid }));
			expect(args).toContain("--session");
			const idx = args.indexOf("--session");
			expect(args[idx + 1]).toBe(uuid);
		});

		it("includes --session for resumeSession", () => {
			const args = plugin.buildArgs(makeRequest({ resumeSession: "session-456" }));
			expect(args).toContain("--session");
			expect(args).toContain("session-456");
		});

		it("includes --agent when agents config provided", () => {
			const args = plugin.buildArgs(
				makeRequest({
					agents: {
						reviewer: {
							description: "Code reviewer",
							prompt: "Review code",
						},
					},
				}),
			);
			expect(args).toContain("--agent");
			expect(args).toContain("reviewer");
		});

		it("does not include --agent when agents is empty", () => {
			const args = plugin.buildArgs(makeRequest({ agents: {} }));
			expect(args).not.toContain("--agent");
		});

		it("includes --format json when jsonSchema is set", () => {
			const args = plugin.buildArgs(
				makeRequest({ jsonSchema: { type: "object" } }),
			);
			expect(args).toContain("--format");
			expect(args).toContain("json");
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
			const result = plugin.parseOutput("error: API failure");
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
		it("has name 'opencode'", () => {
			expect(plugin.name).toBe("opencode");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("config command is 'opencode'", () => {
			expect(plugin.config.command).toBe("opencode");
		});

		it("getEnv includes CI and NO_COLOR", () => {
			const env = plugin.getEnv();
			expect(env.CI).toBe("true");
			expect(env.NO_COLOR).toBe("1");
		});

		it("config has rate limit values", () => {
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(60);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(1000);
			expect(plugin.config.rateLimit?.minTime).toBe(100);
		});
	});
});
