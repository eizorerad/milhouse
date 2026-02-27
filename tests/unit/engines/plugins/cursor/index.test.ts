import { describe, expect, it } from "bun:test";
import { CursorPlugin } from "../../../../../src/engines/plugins/cursor/index";

/** Build a stream-json line. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Build a minimal Cursor execution request. */
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

describe("CursorPlugin", () => {
	const plugin = new CursorPlugin();

	describe("parseOutput - stream-json format", () => {
		it("parses system/init event", () => {
			const output = [
				line({ type: "system", subtype: "init", session_id: "s1", model: "gpt-5" }),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			const initStep = result.steps.find((s) => s.content.includes("Session initialized"));
			expect(initStep).toBeDefined();
			expect(initStep!.metadata?.model).toBe("gpt-5");
		});

		it("parses assistant message with text content", () => {
			const output = [
				line({
					type: "assistant",
					message: { content: [{ type: "text", text: "Here is the fix" }] },
				}),
				line({ type: "result", session_id: "s1", duration_ms: 200 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			expect(result.output).toBe("Here is the fix");
		});

		it("parses result event with is_error flag", () => {
			const output = [
				line({ type: "result", is_error: true, duration_ms: 50 }),
			].join("\n");
			// Need multiline starting with { to trigger stream-json path
			const multilineOutput = `${line({ type: "system", subtype: "init" })}\n${line({ type: "result", is_error: true, duration_ms: 50 })}`;
			const result = plugin.parseOutput(multilineOutput);
			expect(result.success).toBe(false);
		});

		it("parses tool_call events with started/completed subtypes", () => {
			const output = [
				line({
					type: "tool_call",
					subtype: "started",
					call_id: "c1",
					tool_call: { readToolCall: { path: "/tmp/test" } },
				}),
				line({
					type: "tool_call",
					subtype: "completed",
					call_id: "c1",
					tool_call: { writeToolCall: { path: "/tmp/out" } },
				}),
				line({ type: "result", session_id: "s1", duration_ms: 100 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolSteps = result.steps.filter((s) => s.type === "tool_use");
			expect(toolSteps.length).toBe(2);
			expect(toolSteps[0].content).toContain("started");
			expect(toolSteps[0].content).toContain("read");
			expect(toolSteps[1].content).toContain("completed");
			expect(toolSteps[1].content).toContain("write");
		});
	});

	describe("extractToolName", () => {
		it("maps readToolCall to 'read'", () => {
			const output = [
				line({
					type: "tool_call",
					subtype: "started",
					call_id: "c1",
					tool_call: { readToolCall: {} },
				}),
				line({ type: "result", duration_ms: 0 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep!.content).toContain("read");
		});

		it("maps writeToolCall to 'write'", () => {
			const output = [
				line({
					type: "tool_call",
					subtype: "started",
					call_id: "c1",
					tool_call: { writeToolCall: {} },
				}),
				line({ type: "result", duration_ms: 0 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep!.content).toContain("write");
		});

		it("extracts function.name", () => {
			const output = [
				line({
					type: "tool_call",
					subtype: "started",
					call_id: "c1",
					tool_call: { function: { name: "search_files" } },
				}),
				line({ type: "result", duration_ms: 0 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep!.content).toContain("search_files");
		});

		it("uses first-key fallback for unknown tool calls", () => {
			const output = [
				line({
					type: "tool_call",
					subtype: "started",
					call_id: "c1",
					tool_call: { customTool: { arg: "val" } },
				}),
				line({ type: "result", duration_ms: 0 }),
			].join("\n");
			const result = plugin.parseOutput(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep!.content).toContain("customTool");
		});
	});

	describe("parseOutput - JSON format", () => {
		it("parses successful result JSON", () => {
			const output = JSON.stringify({
				type: "result",
				subtype: "success",
				result: "Done",
				session_id: "s1",
				duration_ms: 500,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.output).toBe("Done");
			expect(result.duration).toBe(500);
		});

		it("parses error JSON with is_error flag", () => {
			const output = JSON.stringify({
				is_error: true,
				error: "API failure",
				duration_ms: 10,
			});
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("API failure");
		});
	});

	describe("parseOutput - text fallback", () => {
		it("falls back to text parsing for plain text", () => {
			const output = "Plain text output";
			const result = plugin.parseOutput(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThan(0);
		});
	});

	describe("buildArgs", () => {
		it("includes -p flag for print mode", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("-p");
		});

		it("includes --output-format stream-json by default", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("--output-format");
			expect(args).toContain("stream-json");
		});

		it("includes -f for auto-approve by default", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args).toContain("-f");
		});

		it("omits -f when autoApprove is false", () => {
			const args = plugin.buildArgs(makeRequest({ autoApprove: false }));
			expect(args).not.toContain("-f");
		});

		it("includes --mode when mode is set", () => {
			const args = plugin.buildArgs(makeRequest({ mode: "ask" }));
			expect(args).toContain("--mode");
			expect(args).toContain("ask");
		});

		it("includes -m for model override", () => {
			const args = plugin.buildArgs(makeRequest({ modelOverride: "gpt-5" }));
			expect(args).toContain("-m");
			expect(args).toContain("gpt-5");
		});

		it("includes prompt as last positional arg", () => {
			const args = plugin.buildArgs(makeRequest());
			expect(args[args.length - 1]).toBe("test prompt");
		});
	});

	describe("plugin properties", () => {
		it("has name 'cursor'", () => {
			expect(plugin.name).toBe("cursor");
		});

		it("usesStdinForPrompt returns false", () => {
			expect(plugin.usesStdinForPrompt()).toBe(false);
		});

		it("config command is 'agent'", () => {
			expect(plugin.config.command).toBe("agent");
		});
	});
});
