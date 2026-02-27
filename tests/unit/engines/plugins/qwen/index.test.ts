import { describe, expect, it } from "bun:test";
import { QwenPlugin } from "../../../../../src/engines/plugins/qwen/index";

/** Build a stream-json line. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Build a minimal Qwen execution request. */
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

describe("QwenPlugin", () => {
	const plugin = new QwenPlugin();

	describe("parseOutput - format detection", () => {
		it("selects stream-json parser for NDJSON starting with {", () => {
			const output = [
				line({ type: "system", subtype: "session_start", session_id: "s1", model: "qwen" }),
				line({
					type: "assistant",
					message: { content: [{ type: "text", text: "Hello" }] },
				}),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Hello");
		});

		it("selects JSON array parser for [ output", () => {
			const output = JSON.stringify([
				{ type: "system", subtype: "session_start", session_id: "s1", model: "qwen" },
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "Response" }] },
				},
				{ type: "result", session_id: "s1", duration_ms: 200 },
			]);
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Response");
		});

		it("selects single JSON parser for { output on single line", () => {
			const output = JSON.stringify({
				type: "result",
				result: "Done",
				duration_ms: 50,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Done");
		});

		it("falls back to text parser for plain text", () => {
			const output = "Just some plain text output";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
		});
	});

	describe("parseJsonArrayOutput", () => {
		it("parses system/session_start events", () => {
			const output = JSON.stringify([
				{ type: "system", subtype: "session_start", session_id: "s1", model: "qwen-max" },
				{ type: "result", session_id: "s1", duration_ms: 100 },
			]);
			const result = plugin.parseOutput(output);
			const initStep = result.steps.find((s) => s.content.includes("Session started"));
			expect(initStep).toBeDefined();
			expect(initStep!.metadata?.model).toBe("qwen-max");
		});

		it("parses assistant messages with content blocks", () => {
			const output = JSON.stringify([
				{
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "First part" },
							{ type: "text", text: "Second part" },
						],
					},
				},
				{ type: "result", session_id: "s1", duration_ms: 100 },
			]);
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("First part\nSecond part");
		});

		it("parses result with is_error flag", () => {
			const output = JSON.stringify([
				{ type: "result", is_error: true, session_id: "s1", duration_ms: 10 },
			]);
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Qwen execution failed");
		});

		it("uses result text when no assistant messages present", () => {
			const output = JSON.stringify([
				{ type: "result", result: "Fallback text", session_id: "s1", duration_ms: 50 },
			]);
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("Fallback text");
		});
	});

	describe("parseStreamJsonOutput", () => {
		it("parses session_start event", () => {
			const output = [
				line({ type: "system", subtype: "session_start", session_id: "s1", model: "qwen" }),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const initStep = result.steps.find((s) => s.content.includes("Session started"));
			expect(initStep).toBeDefined();
		});

		it("parses assistant messages", () => {
			const output = [
				line({
					type: "assistant",
					message: { content: [{ type: "text", text: "Answer" }] },
				}),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("Answer");
		});

		it("detects errors from is_error in result event", () => {
			const output = [
				line({ type: "system", subtype: "session_start" }),
				line({ type: "result", is_error: true, duration_ms: 5 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
		});

		it("parses tool_use events", () => {
			const output = [
				line({ type: "tool_use", tool: "file_read", path: "/tmp/test" }),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
			expect(toolStep!.content).toContain("file_read");
		});
	});

	describe("parseJsonOutput - single JSON", () => {
		it("parses successful result type", () => {
			const output = JSON.stringify({
				type: "result",
				result: "Completed",
				session_id: "s1",
				duration_ms: 300,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Completed");
			expect(result.duration).toBe(300);
		});

		it("parses error result with is_error", () => {
			const output = JSON.stringify({
				type: "result",
				is_error: true,
				result: "Error occurred",
				duration_ms: 5,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Qwen execution failed");
		});

		it("handles non-result JSON objects", () => {
			const output = JSON.stringify({
				response: "Some response",
				duration_ms: 100,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Some response");
		});
	});

	describe("buildArgs - approval mode mapping", () => {
		it("includes --yolo when autoApprove is not false", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--yolo");
		});

		it("maps 'default' approval mode", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false, mode: "default" }));
			expect(args).not.toContain("--yolo");
			expect(args).toContain("--approval-mode");
			expect(args).toContain("default");
		});

		it("maps 'auto_edit' approval mode", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false, mode: "auto_edit" }));
			expect(args).toContain("--approval-mode");
			expect(args).toContain("auto_edit");
		});

		it("maps 'full_auto' approval mode", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false, mode: "full_auto" }));
			expect(args).toContain("--approval-mode");
			expect(args).toContain("full_auto");
		});
	});

	describe("buildArgs - general", () => {
		it("includes -p with prompt", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("-p");
			const pIdx = args.indexOf("-p");
			expect(args[pIdx + 1]).toBe("test prompt");
		});

		it("includes --output-format stream-json by default", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--output-format");
			expect(args).toContain("stream-json");
		});

		it("includes --continue when continueSession is true", () => {
			const args = plugin.buildArgs(makeRequest({ continueSession: true }));
			expect(args).toContain("--continue");
		});

		it("includes --resume with session ID", () => {
			const args = plugin.buildArgs(makeRequest({ resumeSession: "session-abc" }));
			expect(args).toContain("--resume");
			expect(args).toContain("session-abc");
		});

		it("includes --debug when metadata.debug is true", () => {
			const args = plugin.buildArgs(makeRequest({ metadata: { debug: true } }));
			expect(args).toContain("--debug");
		});
	});

	describe("plugin properties", () => {
		it("has name 'qwen'", () => {
			expect(plugin.name).toBe("qwen");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("config has rate limit values", () => {
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(40);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(600);
			expect(plugin.config.rateLimit?.minTime).toBe(150);
		});
	});
});
