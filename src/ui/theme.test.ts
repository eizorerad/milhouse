import { describe, expect, test } from "bun:test";
import { box, stripAnsi, visibleLength } from "./theme.ts";

// ============================================================================
// stripAnsi
// ============================================================================

describe("stripAnsi", () => {
	test("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	test("strips a single color code", () => {
		expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
	});

	test("strips multiple color codes", () => {
		expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[0m")).toBe("bold red");
	});

	test("strips nested/sequential ANSI codes", () => {
		const input = "\x1b[32mhello \x1b[33mworld\x1b[0m foo\x1b[0m";
		expect(stripAnsi(input)).toBe("hello world foo");
	});

	test("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	test("handles string that is only ANSI codes", () => {
		expect(stripAnsi("\x1b[32m\x1b[0m")).toBe("");
	});
});

// ============================================================================
// visibleLength
// ============================================================================

describe("visibleLength", () => {
	test("returns correct length for plain text", () => {
		expect(visibleLength("hello")).toBe(5);
	});

	test("returns correct length for colored text", () => {
		expect(visibleLength("\x1b[32mhello\x1b[0m")).toBe(5);
	});

	test("returns correct length for text with multiple ANSI sequences", () => {
		expect(visibleLength("\x1b[1m\x1b[31mhi\x1b[0m \x1b[32mthere\x1b[0m")).toBe(8);
	});

	test("returns 0 for empty string", () => {
		expect(visibleLength("")).toBe(0);
	});

	test("returns 0 for string with only ANSI codes", () => {
		expect(visibleLength("\x1b[32m\x1b[0m")).toBe(0);
	});
});

// ============================================================================
// box.wrap — plain text (regression baseline)
// ============================================================================

describe("box.wrap with plain text", () => {
	test("wraps a single line with default width", () => {
		const result = box.wrap("hello");
		const lines = result.split("\n");
		// top + content + bottom = 3 lines
		expect(lines).toHaveLength(3);
		// top and bottom should have same length
		expect(lines[0].length).toBe(lines[2].length);
		// content line should contain the text
		expect(lines[1]).toContain("hello");
	});

	test("wraps multiple lines and aligns right borders", () => {
		const result = box.wrap("short\na longer line");
		const lines = result.split("\n");
		expect(lines).toHaveLength(4); // top + 2 content + bottom

		// All right-side │ characters should be in the same column
		const contentLines = lines.slice(1, 3);
		const rightBorderPositions = contentLines.map((l) => l.lastIndexOf("│"));
		expect(rightBorderPositions[0]).toBe(rightBorderPositions[1]);
	});

	test("respects explicit width parameter", () => {
		const result = box.wrap("hi", 60);
		const lines = result.split("\n");
		// top border: ┌ + 62 ─ + ┐ = 64 chars (width + 2 for padding spaces)
		expect(lines[0].length).toBe(64);
	});

	test("uses content width when it exceeds the width parameter", () => {
		const longLine = "a".repeat(70);
		const result = box.wrap(longLine, 50);
		const lines = result.split("\n");
		// Box should be sized to content (70), not the smaller width parameter
		expect(lines[0].length).toBe(74); // 70 + 2 padding + 2 border chars
	});
});

// ============================================================================
// box.wrap — ANSI-colored text (the actual bug fix)
// ============================================================================

describe("box.wrap with ANSI-colored text", () => {
	test("produces correctly aligned right-side borders", () => {
		const plain = "plain line";
		const colored = "\x1b[32mcolored line\x1b[0m";
		const result = box.wrap(`${plain}\n${colored}`);
		const lines = result.split("\n");

		// All right-side │ characters should be in the same visual column
		const contentLines = lines.slice(1, 3);
		const rightBorderVisualPositions = contentLines.map((l) => visibleLength(l));
		expect(rightBorderVisualPositions[0]).toBe(rightBorderVisualPositions[1]);
	});

	test("box width is determined by visible content width, not raw string length", () => {
		// This colored string has 12 visible chars but many more raw chars
		const colored = "\x1b[1m\x1b[32mhello world!\x1b[0m";
		const result = box.wrap(colored, 5);
		const lines = result.split("\n");
		// Top border should be based on visible length (12), not raw length
		// top: ┌ + (12+2) ─ + ┐ = 16 visible chars
		expect(lines[0].length).toBe(16);
	});

	test("lines with more ANSI codes are not over-padded", () => {
		const heavy = "\x1b[1m\x1b[4m\x1b[31mred\x1b[0m";
		const light = "red";
		const result = box.wrap(`${heavy}\n${light}`);
		const lines = result.split("\n");

		// Both content lines should have the same visible width
		const contentLines = lines.slice(1, 3);
		const visibleWidths = contentLines.map((l) => visibleLength(l));
		expect(visibleWidths[0]).toBe(visibleWidths[1]);
	});
});

// ============================================================================
// box.wrap — mixed lines
// ============================================================================

describe("box.wrap with mixed lines", () => {
	test("some lines colored, some plain — borders still align", () => {
		const result = box.wrap(
			"plain\n\x1b[32mgreen\x1b[0m\nanother plain\n\x1b[1m\x1b[34mbold blue\x1b[0m",
		);
		const lines = result.split("\n");
		expect(lines).toHaveLength(6); // top + 4 content + bottom

		// All content lines should have the same visible width
		const contentLines = lines.slice(1, 5);
		const visibleWidths = contentLines.map((l) => visibleLength(l));
		const allSame = visibleWidths.every((w) => w === visibleWidths[0]);
		expect(allSame).toBe(true);
	});
});

// ============================================================================
// box.wrap — edge cases
// ============================================================================

describe("box.wrap edge cases", () => {
	test("empty string", () => {
		const result = box.wrap("");
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		// Content line should still have borders
		expect(lines[1]).toMatch(/^│.*│$/);
	});

	test("single line", () => {
		const result = box.wrap("single");
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("single");
	});

	test("line with only ANSI codes (zero visible width)", () => {
		const result = box.wrap("\x1b[32m\x1b[0m", 10);
		const lines = result.split("\n");
		// Width should be the explicit parameter (10) since visible content is 0
		expect(lines[0].length).toBe(14); // 10 + 2 padding + 2 border chars
	});

	test("width parameter larger than content", () => {
		const result = box.wrap("hi", 80);
		const lines = result.split("\n");
		// Box should use the larger width parameter
		expect(lines[0].length).toBe(84); // 80 + 2 padding + 2 border chars
	});
});
