/**
 * Tests for printBanner alignment and stripAnsi helper.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { printBanner, stripAnsi } from "../src/ui.ts";

describe("stripAnsi", () => {
	it("removes basic SGR escape codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
	});

	it("removes bold and color reset codes", () => {
		expect(stripAnsi("\x1b[1m\x1b[38;2;124;58;237mHELLO\x1b[39m\x1b[22m")).toBe("HELLO");
	});

	it("returns plain strings unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("removes multiple escape sequences", () => {
		expect(stripAnsi("\x1b[1mA\x1b[0m \x1b[32mB\x1b[0m")).toBe("A B");
	});
});

describe("printBanner", () => {
	function captureBanner(): string[] {
		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		printBanner();
		spy.mockRestore();
		return lines;
	}

	it("renders box lines with equal visible length", () => {
		const lines = captureBanner();
		// Filter out empty lines
		const boxLines = lines.filter((l) => stripAnsi(l).trim().length > 0);
		expect(boxLines.length).toBe(3);

		const widths = boxLines.map((l) => stripAnsi(l).length);
		expect(widths[0]).toBe(widths[1]);
		expect(widths[1]).toBe(widths[2]);
	});

	it("content line starts and ends with |", () => {
		const lines = captureBanner();
		const boxLines = lines.filter((l) => stripAnsi(l).trim().length > 0);
		const contentLine = stripAnsi(boxLines[1]);
		expect(contentLine.startsWith("|")).toBe(true);
		expect(contentLine.endsWith("|")).toBe(true);
	});

	it("border lines match +---+ pattern", () => {
		const lines = captureBanner();
		const boxLines = lines.filter((l) => stripAnsi(l).trim().length > 0);
		const borderPattern = /^\+-+\+$/;
		expect(borderPattern.test(stripAnsi(boxLines[0]))).toBe(true);
		expect(borderPattern.test(stripAnsi(boxLines[2]))).toBe(true);
	});
});
