import { describe, expect, it } from "bun:test";
import { GeminiPlugin } from "../../../../../src/engines/plugins/gemini/index";

/** Build a stream-json line. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Build a minimal Gemini execution request. */
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

describe("GeminiPlugin", () => {
	const plugin = new GeminiPlugin();

	describe("parseOutput - format detection", () => {
		it("detects stream-json with 0-line preamble", () => {
			const output = [
				line({ type: "init", session_id: "s1", model: "gemini-3-pro-preview" }),
				line({ type: "message", role: "assistant", content: "Hello", delta: false }),
				line({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 5 } }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
			// Should have init step (thinking)
			const initStep = result.steps.find((s) => s.content.includes("Session started"));
			expect(initStep).toBeDefined();
		});

		it("detects stream-json with 5-line preamble (boundary of probe window)", () => {
			const preamble = Array.from({ length: 5 }, (_, i) => `preamble line ${i}`).join("\n");
			const jsonLines = [
				line({ type: "init", session_id: "s1", model: "gemini-3" }),
				line({ type: "message", role: "assistant", content: "answer", delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const output = `${preamble}\n${jsonLines}`;
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			// Should still detect and parse the stream-json portion
			const messageStep = result.steps.find(
				(s) => s.type === "result" && s.content === "answer",
			);
			expect(messageStep).toBeDefined();
		});

		it("detects stream-json with 6+ line preamble (over-boundary)", () => {
			// The probe window is firstJsonLineIndex + 5, starting from first JSON line.
			// Even with 6+ preamble lines, if the first JSON line has {type} it should work.
			const preamble = Array.from({ length: 8 }, (_, i) => `preamble line ${i}`).join("\n");
			const jsonLines = [
				line({ type: "init", session_id: "s1", model: "gemini-3" }),
				line({ type: "message", role: "assistant", content: "answer", delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const output = `${preamble}\n${jsonLines}`;
			const result = plugin.parseOutput(output);
			// The findIndex finds the first { line, probe window starts there.
			// Since the first JSON line has "type", it should still be detected.
			expect(result.success).toBe(true);
			const messageStep = result.steps.find(
				(s) => s.type === "result" && s.content === "answer",
			);
			expect(messageStep).toBeDefined();
		});

		it("detects single JSON object format", () => {
			const output = JSON.stringify({
				response: "Here is the fix",
				stats: {
					models: {
						"gemini-3": { api: { totalLatencyMs: 1234 } },
					},
				},
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.duration).toBe(1234);
			const resultStep = result.steps.find((s) => s.content === "Here is the fix");
			expect(resultStep).toBeDefined();
		});

		it("falls back to plain text", () => {
			const output = "This is plain text output with no JSON structure";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
		});

		it("handles empty input", () => {
			const result = plugin.parseOutput("");
			expect(result.success).toBe(true);
			expect(result.steps).toEqual([]);
		});

		it("handles whitespace-only input", () => {
			const result = plugin.parseOutput("   \n\n  ");
			expect(result.success).toBe(true);
		});
	});

	describe("parseStreamJsonOutput - delta vs non-delta messages", () => {
		it("marks delta messages as thinking and non-delta as result", () => {
			const output = [
				line({ type: "message", role: "assistant", content: "partial...", delta: true }),
				line({ type: "message", role: "assistant", content: "Full response", delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const thinkingSteps = result.steps.filter(
				(s) => s.type === "thinking" && s.metadata?.isDelta === true,
			);
			expect(thinkingSteps.length).toBeGreaterThanOrEqual(1);

			const resultSteps = result.steps.filter(
				(s) => s.type === "result" && s.metadata?.isDelta === false,
			);
			expect(resultSteps.length).toBeGreaterThanOrEqual(1);
		});

		it("prefers last non-delta message for final output", () => {
			const output = [
				line({ type: "message", role: "assistant", content: "chunk1", delta: true }),
				line({ type: "message", role: "assistant", content: "chunk2", delta: true }),
				line({ type: "message", role: "assistant", content: "Complete answer", delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("Complete answer");
		});

		it("falls back to joined messages when no non-delta message exists", () => {
			const output = [
				line({ type: "message", role: "assistant", content: "chunk1", delta: true }),
				line({ type: "message", role: "assistant", content: "chunk2", delta: true }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("chunk1\nchunk2");
		});
	});

	describe("parseStreamJsonOutput - JSON-in-last-message override", () => {
		it("uses last message if it starts with [", () => {
			const jsonArr = JSON.stringify([{ finding: "bug" }]);
			const output = [
				line({ type: "message", role: "assistant", content: "Let me analyze...", delta: false }),
				line({ type: "message", role: "assistant", content: jsonArr, delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe(jsonArr);
		});

		it("uses last message if it starts with {", () => {
			const jsonObj = JSON.stringify({ result: "fix applied" });
			const output = [
				line({ type: "message", role: "assistant", content: "Working on it...", delta: false }),
				line({ type: "message", role: "assistant", content: jsonObj, delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe(jsonObj);
		});
	});

	describe("parseStreamJsonOutput - error detection", () => {
		it("detects error from event.type === 'error'", () => {
			const output = [
				line({ type: "init", session_id: "s1" }),
				line({ type: "error", message: "API rate limit exceeded" }),
				line({ type: "result", status: "error" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toContain("rate limit");
		});

		it("detects error from result status !== success", () => {
			const output = [
				line({ type: "init", session_id: "s1" }),
				line({ type: "result", status: "error", stats: {} }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
		});

		it("uses 'Unknown error' when error message is missing", () => {
			const output = [
				line({ type: "error" }),
				line({ type: "result", status: "error" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown error");
		});
	});

	describe("parseStreamJsonOutput - token extraction", () => {
		it("extracts input and output tokens from result stats", () => {
			const output = [
				line({ type: "message", role: "assistant", content: "hi", delta: false }),
				line({
					type: "result",
					status: "success",
					stats: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
				}),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.tokens).toEqual({ input: 100, output: 50 });
		});

		it("returns zero tokens when stats are missing", () => {
			const output = [
				line({ type: "message", role: "assistant", content: "hi", delta: false }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.tokens).toEqual({ input: 0, output: 0 });
		});
	});

	describe("parseStreamJsonOutput - tool events", () => {
		it("parses tool_use events", () => {
			const output = [
				line({
					type: "tool_use",
					tool_name: "read_file",
					tool_id: "t1",
					parameters: { path: "/tmp/test.txt" },
				}),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
			expect(toolStep!.content).toContain("read_file");
			expect(toolStep!.metadata?.toolName).toBe("read_file");
		});

		it("parses tool_result events with success status", () => {
			const output = [
				line({ type: "tool_result", tool_id: "t1", status: "success", output: "file contents" }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const resultStep = result.steps.find(
				(s) => s.metadata?.isToolResult === true && s.metadata?.status === "success",
			);
			expect(resultStep).toBeDefined();
			expect(resultStep!.type).toBe("result");
		});

		it("parses tool_result events with error status", () => {
			const output = [
				line({ type: "tool_result", tool_id: "t1", status: "error", output: "permission denied" }),
				line({ type: "result", status: "success" }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const errorStep = result.steps.find(
				(s) => s.metadata?.isToolResult === true && s.metadata?.status === "error",
			);
			expect(errorStep).toBeDefined();
			expect(errorStep!.type).toBe("error");
		});
	});

	describe("parseJsonOutput - single JSON format", () => {
		it("extracts response and duration from stats.models", () => {
			const output = JSON.stringify({
				response: "The answer",
				stats: {
					models: {
						"gemini-3": { api: { totalLatencyMs: 2500 } },
					},
				},
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("The answer");
			expect(result.duration).toBe(2500);
		});

		it("sums durations from multiple models", () => {
			const output = JSON.stringify({
				response: "combined",
				stats: {
					models: {
						"gemini-3": { api: { totalLatencyMs: 1000 } },
						"gemini-2": { api: { totalLatencyMs: 500 } },
					},
				},
			});
			const result = plugin.parseOutput(output);
			expect(result.duration).toBe(1500);
		});

		it("extracts tool stats", () => {
			const output = JSON.stringify({
				response: "done",
				stats: {
					tools: { totalCalls: 5, totalSuccess: 4, totalFail: 1 },
				},
			});
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
			expect(toolStep!.content).toContain("5");
		});

		it("detects error field", () => {
			const output = JSON.stringify({
				error: { message: "API key invalid" },
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("API key invalid");
		});

		it("falls back to text parser on invalid JSON", () => {
			// Looks like JSON but isn't fully valid (wrapped with extra text)
			const output = "{not really json{{}";
			const result = plugin.parseOutput(output);
			// Should not throw, falls back to text
			expect(result.steps.length).toBeGreaterThanOrEqual(0);
		});
	});

	describe("buildArgs", () => {
		it("includes output format and prompt as positional arg", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--output-format");
			expect(args).toContain("stream-json");
			// Prompt should be the last arg
			expect(args[args.length - 1]).toBe("test prompt");
		});

		it("includes --yolo when autoApprove is not false", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--yolo");
		});

		it("omits --yolo and sets approval mode when autoApprove is false", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false, mode: "auto_edit" }));
			expect(args).not.toContain("--yolo");
			expect(args).toContain("--approval-mode");
			expect(args).toContain("auto_edit");
		});

		it("includes --model when modelOverride is set", () => {
			const args = plugin.buildArgs(makeRequest({ modelOverride: "gemini-3-pro-preview" }));
			expect(args).toContain("--model");
			expect(args).toContain("gemini-3-pro-preview");
		});

		it("includes --resume when resumeSession is set", () => {
			const args = plugin.buildArgs(makeRequest({ resumeSession: "session-123" }));
			expect(args).toContain("--resume");
			expect(args).toContain("session-123");
		});

		it("includes --debug when metadata.debug is true", () => {
			const args = plugin.buildArgs(makeRequest({ metadata: { debug: true } }));
			expect(args).toContain("--debug");
		});

		it("includes --sandbox when metadata.sandbox is true", () => {
			const args = plugin.buildArgs(makeRequest({ metadata: { sandbox: true } }));
			expect(args).toContain("--sandbox");
		});

		it("includes allowed tools", () => {
			const args = plugin.buildArgs(
				makeRequest({ allowedTools: ["read_file", "run_shell_command"] }),
			);
			expect(args).toContain("--allowed-tools");
			expect(args).toContain("read_file");
			expect(args).toContain("run_shell_command");
		});
	});

	describe("plugin properties", () => {
		it("has name 'gemini'", () => {
			expect(plugin.name).toBe("gemini");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
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
