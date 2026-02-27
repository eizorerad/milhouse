import { describe, expect, it } from "bun:test";
import { DroidPlugin } from "../../../../../src/engines/plugins/droid/index";

/** Build a stream-json line. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Build a minimal Droid execution request. */
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

describe("DroidPlugin", () => {
	const plugin = new DroidPlugin();

	describe("buildArgs - autonomy level mapping", () => {
		it("maps 'safe' to 'low'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "safe" }));
			expect(args).toContain("--auto");
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("low");
		});

		it("maps 'dev' to 'medium'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "dev" }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("medium");
		});

		it("maps 'prod' to 'high'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "prod" }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("high");
		});

		it("defaults to 'low' when no mode specified", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("low");
		});

		it("maps 'readonly' to 'readonly'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "readonly" }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("readonly");
		});

		it("maps 'development' to 'medium'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "development" }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("medium");
		});

		it("maps 'production' to 'high'", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: true, mode: "production" }));
			const autoIdx = args.indexOf("--auto");
			expect(args[autoIdx + 1]).toBe("high");
		});

		it("does not include --auto when autoApprove is not set", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).not.toContain("--auto");
		});
	});

	describe("buildArgs - general", () => {
		it("starts with exec subcommand", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[0]).toBe("exec");
		});

		it("includes --output-format stream-json by default", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--output-format");
			expect(args).toContain("stream-json");
		});

		it("includes --cwd with workDir", () => {
			const args = plugin.buildArgs(makeRequest({ workDir: "/my/project" }));
			expect(args).toContain("--cwd");
			expect(args).toContain("/my/project");
		});

		it("includes -m for model override", () => {
			const args = plugin.buildArgs(makeRequest({ modelOverride: "claude-sonnet" }));
			expect(args).toContain("-m");
			expect(args).toContain("claude-sonnet");
		});

		it("includes --enabled-tools as comma-separated", () => {
			const args = plugin.buildArgs(makeRequest({ allowedTools: ["read", "write"] }));
			expect(args).toContain("--enabled-tools");
			const idx = args.indexOf("--enabled-tools");
			expect(args[idx + 1]).toBe("read,write");
		});

		it("includes --disabled-tools as comma-separated", () => {
			const args = plugin.buildArgs(makeRequest({ disallowedTools: ["shell"] }));
			expect(args).toContain("--disabled-tools");
			const idx = args.indexOf("--disabled-tools");
			expect(args[idx + 1]).toBe("shell");
		});

		it("includes prompt as last positional arg", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[args.length - 1]).toBe("test prompt");
		});
	});

	describe("parseOutput - stream-json format", () => {
		it("parses message events", () => {
			const output = [
				line({ type: "system", subtype: "init", session_id: "s1", model: "claude" }),
				line({ type: "message", role: "assistant", text: "Hello" }),
				line({ type: "completion", session_id: "s1", durationMs: 200 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Hello");
		});

		it("parses tool_call events", () => {
			const output = [
				line({ type: "tool_call", toolName: "read_file", toolId: "t1", id: "c1" }),
				line({ type: "completion", session_id: "s1", durationMs: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use" && s.content.includes("read_file"));
			expect(toolStep).toBeDefined();
			expect(toolStep!.metadata?.toolName).toBe("read_file");
		});

		it("parses tool_result events with isError tracking", () => {
			const output = [
				line({ type: "tool_result", toolId: "t1", id: "c1", isError: true, value: "not found" }),
				line({ type: "completion", session_id: "s1", durationMs: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolResultStep = result.steps.find(
				(s) => s.type === "tool_use" && s.metadata?.isError === true,
			);
			expect(toolResultStep).toBeDefined();
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("parses completion event with finalText", () => {
			const output = [
				line({ type: "completion", session_id: "s1", durationMs: 300, finalText: "Summary" }),
			].join("\n");
			// Need multiline for stream-json detection
			const multiline = `${line({ type: "system", subtype: "init" })}\n${line({ type: "completion", session_id: "s1", durationMs: 300, finalText: "Summary" })}`;
			const result = plugin.parseOutput(multiline);
			expect(result.output).toContain("Summary");
		});

		it("tool_result with isError produces success=false", () => {
			const output = [
				line({ type: "system", subtype: "init", session_id: "s1", model: "claude" }),
				line({ type: "tool_call", toolName: "write_file", toolId: "t1", id: "c1" }),
				line({ type: "tool_result", toolId: "t1", id: "c1", isError: true, value: "permission denied" }),
				line({ type: "completion", session_id: "s1", durationMs: 150 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("completion with isError produces success=false", () => {
			const output = [
				line({ type: "system", subtype: "init", session_id: "s1", model: "claude" }),
				line({ type: "message", role: "assistant", text: "Attempting task" }),
				line({ type: "completion", session_id: "s1", durationMs: 100, isError: true }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
		});

		it("normal execution without errors produces success=true", () => {
			const output = [
				line({ type: "system", subtype: "init", session_id: "s1", model: "claude" }),
				line({ type: "tool_call", toolName: "read_file", toolId: "t1", id: "c1" }),
				line({ type: "tool_result", toolId: "t1", id: "c1", isError: false, value: "file contents" }),
				line({ type: "message", role: "assistant", text: "Done" }),
				line({ type: "completion", session_id: "s1", durationMs: 500 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});
	});

	describe("parseOutput - JSON format", () => {
		it("parses successful result", () => {
			const output = JSON.stringify({
				type: "result",
				result: "All done",
				duration_ms: 500,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("All done");
		});

		it("parses error result with is_error", () => {
			const output = JSON.stringify({
				type: "result",
				is_error: true,
				result: "Failed",
				duration_ms: 10,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
		});
	});

	describe("parseOutput - text fallback", () => {
		it("falls back to text parsing for plain text", () => {
			const result = plugin.parseOutput("Plain text output here");
			expect(result.success).toBe(true);
		});
	});

	describe("plugin properties", () => {
		it("has name 'droid'", () => {
			expect(plugin.name).toBe("droid");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("config command is 'droid'", () => {
			expect(plugin.config.command).toBe("droid");
		});

		it("config has rate limit values", () => {
			expect(plugin.config.rateLimit?.maxPerMinute).toBe(30);
			expect(plugin.config.rateLimit?.maxPerHour).toBe(500);
		});
	});
});
