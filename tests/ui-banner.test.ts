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

	function getBoxLines(): string[] {
		return captureBanner().filter((line) => stripAnsi(line).trim().length > 0);
	}

	it("renders a boxed ASCII intro with consistent visible width", () => {
		const boxLines = getBoxLines();
		expect(boxLines.length).toBeGreaterThan(3);

		const widths = boxLines.map((l) => stripAnsi(l).length);
		for (const width of widths) {
			expect(width).toBe(widths[0]);
		}
	});

	it("wraps every interior content line with vertical borders", () => {
		const boxLines = getBoxLines();
		for (const contentLine of boxLines.slice(1, -1).map((line) => stripAnsi(line))) {
			expect(contentLine.startsWith("|")).toBe(true);
			expect(contentLine.endsWith("|")).toBe(true);
		}
	});

	it("uses matching top and bottom borders", () => {
		const boxLines = getBoxLines();
		const borderPattern = /^\+-+\+$/;
		expect(borderPattern.test(stripAnsi(boxLines[0]))).toBe(true);
		expect(borderPattern.test(stripAnsi(boxLines[boxLines.length - 1]))).toBe(true);
	});

	it("includes a MILHOUSE intro label", () => {
		const boxText = getBoxLines().map((line) => stripAnsi(line)).join("\n");
		expect(boxText.includes("MILHOUSE")).toBe(true);
	});
});
