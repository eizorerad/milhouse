import { describe, expect, it } from "bun:test";
import { ClaudePlugin } from "../../../../../src/engines/plugins/claude/index";

/** Build a stream-json line. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Build a minimal Claude execution request. */
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

describe("ClaudePlugin", () => {
	describe("buildArgs", () => {
		it("includes default args (output-format, verbose, dangerously-skip-permissions)", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--output-format");
			expect(args).toContain("stream-json");
			expect(args).toContain("--verbose");
			expect(args).toContain("--dangerously-skip-permissions");
		});

		it("puts short prompt under MAX_ARG_PROMPT_LENGTH in -p flag", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ prompt: "short prompt" }));
			expect(args).toContain("-p");
			const pIdx = args.indexOf("-p");
			expect(args[pIdx + 1]).toBe("short prompt");
		});

		it("triggers stdin mode for prompts over MAX_ARG_PROMPT_LENGTH (12000)", () => {
			const plugin = new ClaudePlugin();
			const longPrompt = "x".repeat(12001);
			const args = plugin.buildArgs(makeRequest({ prompt: longPrompt }));
			// Should use stdin passthrough instruction
			const pIdx = args.indexOf("-p");
			expect(pIdx).toBeGreaterThanOrEqual(0);
			expect(args[pIdx + 1]).toContain("standard input");
			expect(plugin.usesStdinForPrompt()).toBe(true);
		});

		it("does not use stdin for exactly MAX_ARG_PROMPT_LENGTH prompt", () => {
			const plugin = new ClaudePlugin();
			const exactPrompt = "x".repeat(12000);
			plugin.buildArgs(makeRequest({ prompt: exactPrompt }));
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("includes --json-schema when jsonSchema is set", () => {
			const plugin = new ClaudePlugin();
			const schema = { type: "object", properties: { result: { type: "string" } } };
			const args = plugin.buildArgs(makeRequest({ jsonSchema: schema }));
			expect(args).toContain("--json-schema");
			const schemaIdx = args.indexOf("--json-schema");
			expect(JSON.parse(args[schemaIdx + 1])).toEqual(schema);
		});

		it("includes --append-system-prompt when systemPromptAppend is set", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ systemPromptAppend: "Be concise." }));
			expect(args).toContain("--append-system-prompt");
			const idx = args.indexOf("--append-system-prompt");
			expect(args[idx + 1]).toBe("Be concise.");
		});

		it("includes --include-partial-messages when set", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ includePartialMessages: true }));
			expect(args).toContain("--include-partial-messages");
		});

		it("includes --allowedTools with tool names", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ allowedTools: ["Read", "Grep", "Bash"] }));
			expect(args).toContain("--allowedTools");
			expect(args).toContain("Read");
			expect(args).toContain("Grep");
			expect(args).toContain("Bash");
		});

		it("includes --disallowedTools with tool names", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ disallowedTools: ["Write", "Edit"] }));
			expect(args).toContain("--disallowedTools");
			expect(args).toContain("Write");
			expect(args).toContain("Edit");
		});

		it("includes --tools as comma-separated list", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ tools: ["Read", "Grep"] }));
			expect(args).toContain("--tools");
			const toolsIdx = args.indexOf("--tools");
			expect(args[toolsIdx + 1]).toBe("Read,Grep");
		});

		it("includes --mcp-config path", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ mcpConfig: "/path/to/mcp.json" }));
			expect(args).toContain("--mcp-config");
			const idx = args.indexOf("--mcp-config");
			expect(args[idx + 1]).toBe("/path/to/mcp.json");
		});

		it("includes --agents config as JSON", () => {
			const plugin = new ClaudePlugin();
			const agents = {
				reviewer: {
					description: "Code reviewer",
					prompt: "Review code",
					tools: ["Read"],
					model: "sonnet",
				},
			};
			const args = plugin.buildArgs(makeRequest({ agents }));
			expect(args).toContain("--agents");
			const agentsIdx = args.indexOf("--agents");
			expect(JSON.parse(args[agentsIdx + 1])).toEqual(agents);
		});

		it("does not include --agents when agents object is empty", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ agents: {} }));
			expect(args).not.toContain("--agents");
		});

		it("includes --add-dir for additional directories", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ additionalDirs: ["/extra1", "/extra2"] }));
			expect(args).toContain("--add-dir");
			expect(args).toContain("/extra1");
			expect(args).toContain("/extra2");
		});

		describe("session management", () => {
			it("includes --session-id when sessionId is set", () => {
				const plugin = new ClaudePlugin();
				const uuid = "550e8400-e29b-41d4-a716-446655440000";
				const args = plugin.buildArgs(makeRequest({ sessionId: uuid }));
				expect(args).toContain("--session-id");
				const idx = args.indexOf("--session-id");
				expect(args[idx + 1]).toBe(uuid);
			});

			it("includes --continue when continueSession is true", () => {
				const plugin = new ClaudePlugin();
				const args = plugin.buildArgs(makeRequest({ continueSession: true }));
				expect(args).toContain("--continue");
			});

			it("does not include --continue when continueSession is false", () => {
				const plugin = new ClaudePlugin();
				const args = plugin.buildArgs(makeRequest({ continueSession: false }));
				expect(args).not.toContain("--continue");
			});

			it("includes --resume with session ID", () => {
				const plugin = new ClaudePlugin();
				const args = plugin.buildArgs(makeRequest({ resumeSession: "session-abc" }));
				expect(args).toContain("--resume");
				const idx = args.indexOf("--resume");
				expect(args[idx + 1]).toBe("session-abc");
			});
		});

		it("includes --debug as boolean", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ metadata: { debug: true } }));
			expect(args).toContain("--debug");
		});

		it("includes --debug with category string", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ metadata: { debug: "api,hooks" } }));
			expect(args).toContain("--debug");
			const debugIdx = args.indexOf("--debug");
			expect(args[debugIdx + 1]).toBe("api,hooks");
		});

		it("includes --model when modelOverride is set", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ modelOverride: "opus" }));
			expect(args).toContain("--model");
			expect(args).toContain("opus");
		});

		it("includes --max-turns when metadata.maxTurns is set", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ metadata: { maxTurns: 50 } }));
			expect(args).toContain("--max-turns");
			expect(args).toContain("50");
		});

		it("includes --max-budget-usd when set", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ metadata: { maxBudgetUsd: 5.0 } }));
			expect(args).toContain("--max-budget-usd");
			expect(args).toContain("5");
		});

		it("ignores maxTokens (Claude CLI does not support --max-tokens)", () => {
			const plugin = new ClaudePlugin();
			const args = plugin.buildArgs(makeRequest({ metadata: { maxTokens: 4096 } }));
			expect(args).not.toContain("--max-tokens");
			expect(args).not.toContain("4096");
		});
	});

	describe("usesStdinForPrompt", () => {
		it("returns false initially (before buildArgs)", () => {
			const plugin = new ClaudePlugin();
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("returns false after buildArgs with short prompt", () => {
			const plugin = new ClaudePlugin();
			plugin.buildArgs(makeRequest({ prompt: "short" }));
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("returns true after buildArgs with long prompt", () => {
			const plugin = new ClaudePlugin();
			plugin.buildArgs(makeRequest({ prompt: "x".repeat(13000) }));
			expect(plugin.usesStdinForPrompt()).toBe(true);
		});

		it("resets when buildArgs called again with short prompt", () => {
			const plugin = new ClaudePlugin();
			plugin.buildArgs(makeRequest({ prompt: "x".repeat(13000) }));
			expect(plugin.usesStdinForPrompt()).toBe(true);
			plugin.buildArgs(makeRequest({ prompt: "short" }));
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});
	});

	describe("parseOutput", () => {
		it("delegates to parseStreamJson and returns valid ExecutionResult", () => {
			const plugin = new ClaudePlugin();
			const output = [
				line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
				line({
					type: "result",
					result: "Final answer",
					usage: { input_tokens: 100, output_tokens: 50 },
				}),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
			expect(result.tokens).toEqual({ input: 100, output: 50 });
		});

		it("detects errors in stream-json output", () => {
			const plugin = new ClaudePlugin();
			const output = line({ type: "error", error: "API error" });
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("API error");
		});

		it("handles empty output", () => {
			const plugin = new ClaudePlugin();
			const result = plugin.parseOutput("");
			expect(result.success).toBe(true);
			expect(result.steps).toEqual([]);
		});

		it("extracts thinking steps", () => {
			const plugin = new ClaudePlugin();
			const output = line({
				type: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "Let me analyze..." },
						{ type: "text", text: "Here is the answer" },
					],
				},
			});
			const result = plugin.parseOutput(output);
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
			expect(thinkingStep!.content).toBe("Let me analyze...");
		});

		it("extracts tool_use steps with metadata", () => {
			const plugin = new ClaudePlugin();
			const output = line({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							name: "Read",
							id: "tool-1",
							input: { file_path: "/tmp/test.ts" },
						},
					],
				},
			});
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
			expect(toolStep!.metadata?.tool).toBe("Read");
			expect(toolStep!.metadata?.id).toBe("tool-1");
		});
	});

	describe("plugin properties", () => {
		it("has name 'claude'", () => {
			const plugin = new ClaudePlugin();
			expect(plugin.name).toBe("claude");
		});

		it("getEnv includes CI and NO_COLOR", () => {
			const plugin = new ClaudePlugin();
			const env = plugin.getEnv();
			expect(env.CI).toBe("true");
			expect(env.NO_COLOR).toBe("1");
		});

		it("config has rate limit values", () => {
			const plugin = new ClaudePlugin();
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(30);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(500);
			expect(plugin.config.rateLimit?.minTime).toBe(200);
		});

		it("config command is 'claude'", () => {
			const plugin = new ClaudePlugin();
			expect(plugin.config.command).toBe("claude");
		});
	});
});
