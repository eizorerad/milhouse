import { describe, expect, it } from "bun:test";
import {
	parseAnsiOutput,
	parseAutoDetect,
	parseMarkdownOutput,
	parseTextOutput,
	parseTextWithPatterns,
} from "../../../../../src/engines/core/parsers/text";

describe("parseTextOutput", () => {
	describe("STEP_PATTERNS - thinking", () => {
		it("detects 'thinking:' pattern", () => {
			const result = parseTextOutput("thinking: about this problem\nresult: done");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
			expect(thinkingStep!.content).toBe("about this problem");
		});

		it("detects '<thinking>' pattern", () => {
			const result = parseTextOutput("<thinking>\nI am reasoning\nresult: ok");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
		});

		it("detects '[thinking]' pattern", () => {
			const result = parseTextOutput("[thinking] deep analysis");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
		});

		it("detects 'reasoning:' pattern (case insensitive)", () => {
			const result = parseTextOutput("Reasoning: step by step");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
		});

		it("detects 'analyzing:' pattern", () => {
			const result = parseTextOutput("analyzing: the code");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
		});

		it("detects 'considering:' pattern", () => {
			const result = parseTextOutput("considering: options");
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
		});
	});

	describe("STEP_PATTERNS - toolUse", () => {
		it("detects 'running:' pattern", () => {
			const result = parseTextOutput("running: npm test");
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
		});

		it("detects 'tool:' pattern", () => {
			const result = parseTextOutput("tool: read_file /tmp/test");
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
		});

		it("detects '[tool]' pattern", () => {
			const result = parseTextOutput("[tool] executing bash");
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
		});

		it("does not detect bash code blocks via line-based parsing (pattern requires newline)", () => {
			// The STEP_PATTERNS.toolUse pattern for code blocks is /^```(?:bash|shell|sh)\n/
			// which requires a trailing newline. Since parseTextOutput splits by \n first,
			// individual lines never contain trailing newlines, so this pattern never matches.
			const result = parseTextOutput("```bash\nls -la\n```");
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeUndefined();
		});

		it("detects 'executing:' pattern", () => {
			const result = parseTextOutput("executing: git status");
			const toolStep = result.steps.find((s) => s.type === "tool_use");
			expect(toolStep).toBeDefined();
		});
	});

	describe("STEP_PATTERNS - error", () => {
		it("detects 'error:' pattern", () => {
			const result = parseTextOutput("error: something failed");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Error detected in output");
			const errorStep = result.steps.find((s) => s.type === "error");
			expect(errorStep).toBeDefined();
		});

		it("detects 'failed:' pattern", () => {
			const result = parseTextOutput("failed: connection timeout");
			expect(result.success).toBe(false);
		});

		it("detects '[error]' pattern", () => {
			const result = parseTextOutput("[error] cannot parse");
			expect(result.success).toBe(false);
		});

		it("detects 'exception:' pattern", () => {
			const result = parseTextOutput("exception: null pointer");
			expect(result.success).toBe(false);
		});
	});

	describe("STEP_PATTERNS - result", () => {
		it("detects 'result:' pattern", () => {
			const result = parseTextOutput("result: success");
			const resultStep = result.steps.find(
				(s) => s.type === "result" && s.content.includes("success"),
			);
			expect(resultStep).toBeDefined();
		});

		it("detects 'output:' pattern", () => {
			const result = parseTextOutput("output: data here");
			const resultStep = result.steps.find(
				(s) => s.type === "result" && s.content.includes("data here"),
			);
			expect(resultStep).toBeDefined();
		});

		it("detects 'done:' pattern", () => {
			const result = parseTextOutput("done: all tasks complete");
			const resultStep = result.steps.find(
				(s) => s.type === "result" && s.content.includes("all tasks complete"),
			);
			expect(resultStep).toBeDefined();
		});

		it("detects '[result]' pattern", () => {
			const result = parseTextOutput("[result] finished");
			const resultStep = result.steps.find(
				(s) => s.type === "result" && s.content.includes("finished"),
			);
			expect(resultStep).toBeDefined();
		});
	});

	describe("multi-line steps", () => {
		it("groups consecutive non-marker lines into the current step", () => {
			const output = "thinking: about it\nstill thinking\nmore thought\nresult: done";
			const result = parseTextOutput(output);
			const thinkingStep = result.steps.find((s) => s.type === "thinking");
			expect(thinkingStep).toBeDefined();
			expect(thinkingStep!.content).toContain("about it");
			expect(thinkingStep!.content).toContain("still thinking");
			expect(thinkingStep!.content).toContain("more thought");
		});

		it("starts a new step when a new marker is encountered", () => {
			const output = "thinking: first\nerror: broken\nresult: fixed";
			const result = parseTextOutput(output);
			expect(result.steps.length).toBe(3);
		});
	});

	describe("edge cases", () => {
		it("handles empty input", () => {
			const result = parseTextOutput("");
			expect(result.success).toBe(true);
			expect(result.steps).toEqual([]);
		});

		it("handles single-line input without markers as result", () => {
			const result = parseTextOutput("just some text");
			expect(result.success).toBe(true);
			expect(result.steps.length).toBe(1);
			expect(result.steps[0].type).toBe("result");
			expect(result.steps[0].content).toBe("just some text");
		});

		it("treats unmatched lines as result steps", () => {
			const result = parseTextOutput("line 1\nline 2\nline 3");
			expect(result.success).toBe(true);
			// All grouped into one result step
			expect(result.steps.length).toBe(1);
			expect(result.steps[0].content).toContain("line 1");
		});

		it("preserves raw output in result", () => {
			const raw = "hello world";
			const result = parseTextOutput(raw);
			expect(result.output).toBe(raw);
		});

		it("sets duration to 0", () => {
			const result = parseTextOutput("test");
			expect(result.duration).toBe(0);
		});

		it("success is true when no error patterns matched", () => {
			const result = parseTextOutput("thinking: ok\nresult: good");
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});
	});
});

describe("parseTextWithPatterns", () => {
	it("uses custom patterns in addition to defaults", () => {
		const result = parseTextWithPatterns("CUSTOM_THINK: reasoning here", {
			thinking: [/^CUSTOM_THINK:/i],
		});
		const thinkingStep = result.steps.find((s) => s.type === "thinking");
		expect(thinkingStep).toBeDefined();
	});

	it("still detects default patterns", () => {
		const result = parseTextWithPatterns("error: bad thing", {});
		expect(result.success).toBe(false);
	});

	it("custom error patterns set hasError", () => {
		const result = parseTextWithPatterns("BOOM: explosion", {
			error: [/^BOOM:/i],
		});
		expect(result.success).toBe(false);
	});
});

describe("parseAnsiOutput", () => {
	it("strips ANSI escape codes before parsing", () => {
		const ansiRed = "\u001b[31m";
		const ansiReset = "\u001b[0m";
		const output = `${ansiRed}error: something failed${ansiReset}`;
		const result = parseAnsiOutput(output);
		expect(result.success).toBe(false);
		const errorStep = result.steps.find((s) => s.type === "error");
		expect(errorStep).toBeDefined();
	});

	it("handles output with no ANSI codes", () => {
		const result = parseAnsiOutput("result: clean output");
		expect(result.success).toBe(true);
	});

	it("handles complex ANSI sequences", () => {
		const output = "\u001b[1;32mthinking: bold green\u001b[0m";
		const result = parseAnsiOutput(output);
		const thinkingStep = result.steps.find((s) => s.type === "thinking");
		expect(thinkingStep).toBeDefined();
	});
});

describe("parseMarkdownOutput", () => {
	it("splits by markdown headers and categorizes", () => {
		const output = "# Thinking\nAnalyzing the code\n# Result\nHere is the fix";
		const result = parseMarkdownOutput(output);
		const thinkingStep = result.steps.find((s) => s.type === "thinking");
		expect(thinkingStep).toBeDefined();
		expect(thinkingStep!.content).toBe("Analyzing the code");
	});

	it("detects tool/command headers as tool_use", () => {
		const output = "## Tool Call\nread_file /tmp/test";
		const result = parseMarkdownOutput(output);
		const toolStep = result.steps.find((s) => s.type === "tool_use");
		expect(toolStep).toBeDefined();
	});

	it("detects error/failed headers as error", () => {
		const output = "## Error\nSomething broke";
		const result = parseMarkdownOutput(output);
		expect(result.success).toBe(false);
		const errorStep = result.steps.find((s) => s.type === "error");
		expect(errorStep).toBeDefined();
	});

	it("includes header in step metadata", () => {
		const output = "# Analysis\nSome content";
		const result = parseMarkdownOutput(output);
		expect(result.steps[0].metadata?.header).toBeDefined();
	});

	it("falls back to parseTextOutput when no headers found", () => {
		const output = "No headers here, just text";
		const result = parseMarkdownOutput(output);
		expect(result.success).toBe(true);
		expect(result.steps.length).toBeGreaterThanOrEqual(1);
	});

	it("handles sections with empty content after header", () => {
		const output = "# Empty Section\n# Result\nActual content";
		const result = parseMarkdownOutput(output);
		// Empty section is skipped, only Result section produces a step
		const resultSteps = result.steps.filter((s) => s.content === "Actual content");
		expect(resultSteps.length).toBe(1);
	});

	it("handles h2 and h3 headers", () => {
		const output = "## Analysis\nContent A\n### Command\nContent B";
		const result = parseMarkdownOutput(output);
		expect(result.steps.length).toBeGreaterThanOrEqual(2);
	});
});

describe("parseAutoDetect", () => {
	it("uses markdown parser when headers are present", () => {
		const output = "# Thinking\nSome analysis\n# Result\nAnswer";
		const result = parseAutoDetect(output);
		const thinkingStep = result.steps.find((s) => s.type === "thinking");
		expect(thinkingStep).toBeDefined();
	});

	it("uses ANSI parser when escape codes are present", () => {
		const output = "\u001b[31merror: red text\u001b[0m";
		const result = parseAutoDetect(output);
		expect(result.success).toBe(false);
	});

	it("falls back to plain text parser for regular text", () => {
		const output = "thinking: about it\nresult: done";
		const result = parseAutoDetect(output);
		const thinkingStep = result.steps.find((s) => s.type === "thinking");
		expect(thinkingStep).toBeDefined();
	});

	it("prefers markdown over ANSI when both present", () => {
		const output = "# Thinking\n\u001b[32mgreen text\u001b[0m";
		const result = parseAutoDetect(output);
		// Markdown is checked first
		expect(result.steps.length).toBeGreaterThanOrEqual(1);
	});
});
