import { describe, expect, it } from "bun:test";
import {
	StreamJsonParser,
	extractFinalResult,
	extractThinking,
	extractToolCalls,
	isStreamJsonFormat,
	parseStreamJson,
} from "../../../../../src/engines/core/parsers/stream-json";

/** Build a stream-json line from a message object. */
function line(msg: Record<string, unknown>): string {
	return JSON.stringify(msg);
}

describe("parseStreamJson", () => {
	describe("message types", () => {
		it("parses assistant messages with text content", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Hello world" }],
				},
			});
			const result = parseStreamJson(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThanOrEqual(1);
			const textStep = result.steps.find(
				(s) => s.type === "result" && s.content === "Hello world",
			);
			expect(textStep).toBeDefined();
		});

		it("parses result messages with string result", () => {
			const output = line({
				type: "result",
				result: "Final answer",
				usage: { input_tokens: 100, output_tokens: 50 },
			});
			const result = parseStreamJson(output);
			expect(result.success).toBe(true);
			const resultStep = result.steps.find(
				(s) => s.type === "result" && s.content === "Final answer",
			);
			expect(resultStep).toBeDefined();
		});

		it("parses error messages", () => {
			const output = line({ type: "error", error: "Something went wrong" });
			const result = parseStreamJson(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Something went wrong");
			const errorStep = result.steps.find((s) => s.type === "error");
			expect(errorStep).toBeDefined();
			expect(errorStep!.content).toBe("Something went wrong");
		});

		it("parses system messages as result steps with isSystem metadata", () => {
			const msg = { type: "system", message: "init" };
			const output = line(msg);
			const result = parseStreamJson(output);
			expect(result.success).toBe(true);
			const systemStep = result.steps.find(
				(s) => s.metadata?.isSystem === true,
			);
			expect(systemStep).toBeDefined();
		});

		it("parses user messages and marks them as tool results", () => {
			const msg = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };
			const output = line(msg);
			const result = parseStreamJson(output);
			const userStep = result.steps.find(
				(s) => s.metadata?.isUserMessage === true,
			);
			expect(userStep).toBeDefined();
			expect(userStep!.metadata?.isToolResult).toBe(true);
		});
	});

	describe("content block types", () => {
		it("parses thinking blocks", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [{ type: "thinking", thinking: "Let me think..." }],
				},
			});
			const result = parseStreamJson(output);
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
			expect(thinkingStep!.content).toBe("Let me think...");
		});

		it("parses tool_use blocks with name, input, and id", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							name: "read_file",
							id: "tool-123",
							input: { path: "/tmp/test.txt" },
						},
					],
				},
			});
			const result = parseStreamJson(output);
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
			expect(toolStep!.metadata?.tool).toBe("read_file");
			expect(toolStep!.metadata?.id).toBe("tool-123");
			const parsed = JSON.parse(toolStep!.content);
			expect(parsed.name).toBe("read_file");
			expect(parsed.input.path).toBe("/tmp/test.txt");
		});

		it("parses tool_result blocks", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [
						{ type: "tool_result", content: "file contents here", id: "tool-123" },
					],
				},
			});
			const result = parseStreamJson(output);
			const toolResultStep = result.steps.find(
				(s) => s.metadata?.isToolResult === true,
			);
			expect(toolResultStep).toBeDefined();
			expect(toolResultStep!.content).toBe("file contents here");
		});

		it("parses text blocks", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Some text" }],
				},
			});
			const result = parseStreamJson(output);
			const textStep = result.steps.find(
				(s) => s.type === "result" && s.content === "Some text",
			);
			expect(textStep).toBeDefined();
		});

		it("handles multiple content blocks in one message", () => {
			const output = line({
				type: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "Analyzing..." },
						{ type: "text", text: "Here is the answer" },
						{ type: "tool_use", name: "bash", input: { cmd: "ls" } },
					],
				},
			});
			const result = parseStreamJson(output);
			expect(result.steps.length).toBe(3);
			expect(result.steps[0].type).toBe("thinking");
			expect(result.steps[1].type).toBe("result");
			expect(result.steps[2].type).toBe("tool_use");
		});
	});

	describe("structured_output extraction", () => {
		it("creates structured output step when structured_output is present", () => {
			const output = line({
				type: "result",
				result: "text response",
				structured_output: { findings: ["bug found"] },
			});
			const result = parseStreamJson(output);
			const structuredStep = result.steps.find(
				(s) => s.metadata?.isStructuredOutput === true,
			);
			expect(structuredStep).toBeDefined();
			expect(JSON.parse(structuredStep!.content)).toEqual({
				findings: ["bug found"],
			});
		});

		it("handles string structured_output directly", () => {
			const output = line({
				type: "result",
				result: "text response",
				structured_output: "raw string output",
			});
			const result = parseStreamJson(output);
			const structuredStep = result.steps.find(
				(s) => s.metadata?.isStructuredOutput === true,
			);
			expect(structuredStep).toBeDefined();
			expect(structuredStep!.content).toBe("raw string output");
		});

		it("does not create structured step when structured_output is null", () => {
			const output = line({
				type: "result",
				result: "text response",
				structured_output: null,
			});
			const result = parseStreamJson(output);
			const structuredStep = result.steps.find(
				(s) => s.metadata?.isStructuredOutput === true,
			);
			expect(structuredStep).toBeUndefined();
		});
	});

	describe("token aggregation", () => {
		it("sums input_tokens and output_tokens across multiple result messages", () => {
			const lines = [
				line({
					type: "result",
					result: "part 1",
					usage: { input_tokens: 100, output_tokens: 50 },
				}),
				line({
					type: "result",
					result: "part 2",
					usage: { input_tokens: 200, output_tokens: 75 },
				}),
			].join("\n");
			const result = parseStreamJson(lines);
			expect(result.tokens).toEqual({ input: 300, output: 125 });
		});

		it("returns undefined tokens when no usage data is present", () => {
			const output = line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
			const result = parseStreamJson(output);
			expect(result.tokens).toBeUndefined();
		});

		it("handles partial usage data (missing output_tokens)", () => {
			const output = line({
				type: "result",
				result: "answer",
				usage: { input_tokens: 100 },
			});
			const result = parseStreamJson(output);
			expect(result.tokens).toEqual({ input: 100, output: 0 });
		});
	});

	describe("error detection", () => {
		it("detects error from type === 'error'", () => {
			const output = line({ type: "error", error: "rate limit" });
			const result = parseStreamJson(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("rate limit");
		});

		it("detects error from error field on non-error type", () => {
			const output = line({ type: "result", error: "parse failure" });
			const result = parseStreamJson(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("parse failure");
		});

		it("uses 'Unknown error' when error field is missing on error type", () => {
			const output = line({ type: "error" });
			const result = parseStreamJson(output);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Unknown error");
		});
	});

	describe("malformed JSON recovery", () => {
		it("treats non-JSON lines as plain text result steps", () => {
			const output = "This is not JSON\nNeither is this";
			const result = parseStreamJson(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBe(2);
			expect(result.steps[0].content).toBe("This is not JSON");
			expect(result.steps[1].content).toBe("Neither is this");
		});

		it("handles mixed JSON and non-JSON lines", () => {
			const output = [
				"some preamble",
				line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
			].join("\n");
			const result = parseStreamJson(output);
			expect(result.steps.length).toBe(2);
			expect(result.steps[0].content).toBe("some preamble");
		});
	});

	describe("edge cases", () => {
		it("handles empty input", () => {
			const result = parseStreamJson("");
			expect(result.success).toBe(true);
			expect(result.steps).toEqual([]);
		});

		it("handles single-line input", () => {
			const output = line({ type: "result", result: "done" });
			const result = parseStreamJson(output);
			expect(result.success).toBe(true);
			expect(result.steps.length).toBeGreaterThanOrEqual(1);
		});

		it("handles blank lines between messages", () => {
			const output = [
				line({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }),
				"",
				"",
				line({ type: "result", result: "b" }),
			].join("\n");
			const result = parseStreamJson(output);
			// Only real message lines produce steps, blanks are skipped
			const contentSteps = result.steps.filter((s) => s.content === "a" || s.content === "b");
			expect(contentSteps.length).toBe(2);
		});

		it("sets duration to 0 (to be set by executor)", () => {
			const result = parseStreamJson(line({ type: "result", result: "ok" }));
			expect(result.duration).toBe(0);
		});

		it("preserves raw output in result", () => {
			const raw = line({ type: "result", result: "test" });
			const result = parseStreamJson(raw);
			expect(result.output).toBe(raw);
		});
	});
});

describe("extractToolCalls", () => {
	it("extracts tool calls from tool_use steps", () => {
		const steps = [
			{
				type: "tool_use" as const,
				content: JSON.stringify({ name: "read", input: { path: "/a" } }),
				timestamp: new Date().toISOString(),
				metadata: { id: "t1" },
			},
			{
				type: "result" as const,
				content: "not a tool",
				timestamp: new Date().toISOString(),
			},
		];
		const tools = extractToolCalls(steps);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("read");
		expect(tools[0].input).toEqual({ path: "/a" });
		expect(tools[0].id).toBe("t1");
	});

	it("returns empty array when no tool_use steps exist", () => {
		const steps = [
			{ type: "result" as const, content: "hi", timestamp: new Date().toISOString() },
		];
		expect(extractToolCalls(steps)).toEqual([]);
	});

	it("handles malformed tool_use content gracefully", () => {
		const steps = [
			{ type: "tool_use" as const, content: "not json", timestamp: new Date().toISOString() },
		];
		const tools = extractToolCalls(steps);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("unknown");
	});
});

describe("extractThinking", () => {
	it("extracts thinking content from thinking steps", () => {
		const steps = [
			{ type: "thinking" as const, content: "Step 1 reasoning", timestamp: new Date().toISOString() },
			{ type: "result" as const, content: "answer", timestamp: new Date().toISOString() },
			{ type: "thinking" as const, content: "Step 2 reasoning", timestamp: new Date().toISOString() },
		];
		const thinking = extractThinking(steps);
		expect(thinking).toEqual(["Step 1 reasoning", "Step 2 reasoning"]);
	});

	it("returns empty array when no thinking steps", () => {
		const steps = [
			{ type: "result" as const, content: "answer", timestamp: new Date().toISOString() },
		];
		expect(extractThinking(steps)).toEqual([]);
	});
});

describe("extractFinalResult", () => {
	it("prefers structured output over plain text", () => {
		const steps = [
			{
				type: "result" as const,
				content: '{"findings":["a"]}',
				timestamp: new Date().toISOString(),
				metadata: { isStructuredOutput: true },
			},
			{
				type: "result" as const,
				content: "plain text response",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe('{"findings":["a"]}');
	});

	it("falls back to last non-filtered result step when no structured output", () => {
		const steps = [
			{
				type: "result" as const,
				content: "first",
				timestamp: new Date().toISOString(),
			},
			{
				type: "result" as const,
				content: "last answer",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("last answer");
	});

	it("filters out tool result steps", () => {
		const steps = [
			{
				type: "result" as const,
				content: "tool output",
				timestamp: new Date().toISOString(),
				metadata: { isToolResult: true },
			},
			{
				type: "result" as const,
				content: "actual answer",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("actual answer");
	});

	it("filters out system message steps", () => {
		const steps = [
			{
				type: "result" as const,
				content: "system info",
				timestamp: new Date().toISOString(),
				metadata: { isSystem: true },
			},
			{
				type: "result" as const,
				content: "answer",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("answer");
	});

	it("filters out user message steps", () => {
		const steps = [
			{
				type: "result" as const,
				content: "user msg",
				timestamp: new Date().toISOString(),
				metadata: { isUserMessage: true },
			},
			{
				type: "result" as const,
				content: "answer",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("answer");
	});

	it("filters out internal message steps", () => {
		const steps = [
			{
				type: "result" as const,
				content: "internal",
				timestamp: new Date().toISOString(),
				metadata: { isInternal: true },
			},
			{
				type: "result" as const,
				content: "answer",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("answer");
	});

	it("returns null when no result steps exist", () => {
		const steps = [
			{ type: "thinking" as const, content: "hmm", timestamp: new Date().toISOString() },
		];
		expect(extractFinalResult(steps)).toBeNull();
	});

	it("returns null for empty steps array", () => {
		expect(extractFinalResult([])).toBeNull();
	});

	it("skips empty content steps", () => {
		const steps = [
			{
				type: "result" as const,
				content: "",
				timestamp: new Date().toISOString(),
			},
			{
				type: "result" as const,
				content: "actual",
				timestamp: new Date().toISOString(),
			},
		];
		const final = extractFinalResult(steps);
		expect(final).toBe("actual");
	});
});

describe("isStreamJsonFormat", () => {
	it("returns true for valid stream-json with type field", () => {
		const output = line({ type: "system", message: "init" });
		expect(isStreamJsonFormat(output)).toBe(true);
	});

	it("returns false for plain text", () => {
		expect(isStreamJsonFormat("Hello world")).toBe(false);
	});

	it("returns false for empty input", () => {
		expect(isStreamJsonFormat("")).toBe(false);
	});

	it("returns false for JSON without type field", () => {
		expect(isStreamJsonFormat('{"name":"test"}')).toBe(false);
	});

	it("returns true when first non-empty line is valid", () => {
		const output = `\n\n${line({ type: "assistant", message: { content: [] } })}`;
		expect(isStreamJsonFormat(output)).toBe(true);
	});
});

describe("StreamJsonParser", () => {
	it("emits steps for complete JSON lines", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		parser.feed(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\n");
		expect(steps.length).toBe(1);
		expect(steps[0].content).toBe("hi");
	});

	it("buffers incomplete lines until newline arrives", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		const full = line({ type: "result", result: "done" });
		// Feed in two chunks
		parser.feed(full.substring(0, 10));
		expect(steps.length).toBe(0);
		parser.feed(full.substring(10) + "\n");
		expect(steps.length).toBeGreaterThanOrEqual(1);
	});

	it("flush emits remaining buffer as plain text", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		parser.feed("incomplete data");
		expect(steps.length).toBe(0);
		parser.flush();
		expect(steps.length).toBe(1);
		expect(steps[0].content).toBe("incomplete data");
	});

	it("flush does nothing when buffer is empty", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		parser.flush();
		expect(steps.length).toBe(0);
	});

	it("handles multiple lines in a single chunk", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		const chunk = [
			line({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }),
			line({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } }),
		].join("\n") + "\n";
		parser.feed(chunk);
		expect(steps.length).toBe(2);
		expect(steps[0].content).toBe("a");
		expect(steps[1].content).toBe("b");
	});

	it("emits non-JSON lines as plain text result steps", () => {
		const steps: Array<{ type: string; content: string }> = [];
		const parser = new StreamJsonParser((step) => steps.push(step));
		parser.feed("not json\n");
		expect(steps.length).toBe(1);
		expect(steps[0].type).toBe("result");
		expect(steps[0].content).toBe("not json");
	});
});
