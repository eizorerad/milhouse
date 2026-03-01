/**
 * Unit tests for ANSI string utilities
 *
 * Tests stripAnsi() and truncateToWidth() for correct handling of ANSI
 * escape codes, visible length tracking, and color bleed prevention.
 *
 * @module tests/unit/utils/ansi-string
 */

import { describe, expect, it } from "bun:test";
import { stripAnsi, truncateToWidth } from "../../../src/utils/ansi-string";

describe("stripAnsi", () => {
	it("should pass plain text through unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("should strip a single color code", () => {
		expect(stripAnsi("\x1b[32mhello\x1b[0m")).toBe("hello");
	});

	it("should strip multiple color codes", () => {
		expect(stripAnsi("\x1b[32mhello \x1b[31mworld\x1b[0m")).toBe("hello world");
	});

	it("should strip nested/combined codes (bold + color)", () => {
		expect(stripAnsi("\x1b[1m\x1b[32mbold green\x1b[0m")).toBe("bold green");
	});

	it("should strip combined SGR parameters", () => {
		expect(stripAnsi("\x1b[1;32mbold green\x1b[0m")).toBe("bold green");
	});

	it("should strip reset sequence", () => {
		expect(stripAnsi("\x1b[0m")).toBe("");
	});

	it("should return empty string for empty input", () => {
		expect(stripAnsi("")).toBe("");
	});
});

describe("truncateToWidth", () => {
	it("should return plain text within width unchanged", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
	});

	it("should return plain text exactly at width unchanged", () => {
		expect(truncateToWidth("hello", 5)).toBe("hello");
	});

	it("should truncate plain text exceeding width with ellipsis", () => {
		const result = truncateToWidth("hello world", 8);
		const visible = stripAnsi(result);
		expect(visible.length).toBeLessThanOrEqual(8);
		expect(visible).toContain("…");
		expect(visible.startsWith("hello w")).toBe(true);
	});

	it("should return ANSI-colored text within width unchanged", () => {
		const input = "\x1b[32mhi\x1b[0m";
		expect(truncateToWidth(input, 10)).toBe(input);
	});

	it("should truncate ANSI-colored text at correct visible position", () => {
		const input = "\x1b[32mHello World\x1b[0m";
		const result = truncateToWidth(input, 8);
		const visible = stripAnsi(result);
		expect(visible.length).toBeLessThanOrEqual(8);
		expect(visible).toContain("…");
	});

	it("should handle mid-escape-sequence truncation without splitting the escape", () => {
		// "\x1b[32m" is 4 chars in raw string; visible text "AB" comes before next escape
		// If we naively sliced at 3 raw chars we'd split inside "\x1b[32m"
		const input = "\x1b[32mABCDEFGHIJ\x1b[0m";
		const result = truncateToWidth(input, 5);
		const visible = stripAnsi(result);
		expect(visible.length).toBeLessThanOrEqual(5);
		// No dangling incomplete escape sequences
		expect(result).not.toMatch(/\x1b\[[0-9;]*$/);
		expect(result).not.toMatch(/\x1b$/);
	});

	it("should handle truncation point at boundary between two escape sequences", () => {
		// Two color regions back-to-back, truncate in the second
		const input = "\x1b[32mAB\x1b[31mCDEFGH\x1b[0m";
		const result = truncateToWidth(input, 4);
		const visible = stripAnsi(result);
		expect(visible.length).toBeLessThanOrEqual(4);
		// No incomplete escapes
		expect(result).not.toMatch(/\x1b\[[0-9;]*$/);
	});

	it("should handle width of 1 (just ellipsis)", () => {
		const result = truncateToWidth("hello world", 1);
		const visible = stripAnsi(result);
		expect(visible).toBe("…");
	});

	it("should handle width of 0", () => {
		const result = truncateToWidth("hello", 0);
		const visible = stripAnsi(result);
		// maxWidth - 1 = -1, so loop won't execute, just get ellipsis
		expect(visible.length).toBeLessThanOrEqual(1);
	});

	it("should handle string with only ANSI codes and no visible characters", () => {
		const input = "\x1b[32m\x1b[0m";
		// Visible length is 0 which is <= any maxWidth, so returned unchanged
		expect(truncateToWidth(input, 5)).toBe(input);
	});

	it("should not return more visible chars than maxWidth", () => {
		const input = "\x1b[1m\x1b[32mThis is a bold green long string\x1b[0m";
		const result = truncateToWidth(input, 10);
		const visible = stripAnsi(result);
		expect(visible.length).toBeLessThanOrEqual(10);
	});
});
