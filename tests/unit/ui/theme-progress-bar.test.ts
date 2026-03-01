import { describe, expect, it } from "bun:test";
import { progressBar } from "../../../src/ui/theme";

// Strip ANSI escape codes so assertions are color-independent
const stripAnsi = (str: string) => str.replace(/\u001B\[[0-9;]*m/g, "");

describe("progressBar", () => {
	it("should return a dim empty bar when total is 0", () => {
		const bar = stripAnsi(progressBar(0, 0));
		// Should be all empty blocks with no percentage / NaN
		expect(bar).toContain("░");
		expect(bar).not.toContain("NaN");
		expect(bar).not.toContain("Infinity");
		expect(bar).not.toContain("%");
	});

	it("should show 50% for half progress at default width", () => {
		const bar = stripAnsi(progressBar(5, 10));
		expect(bar).toContain("█");
		expect(bar).toContain("░");
		expect(bar).toContain("50%");
	});

	it("should show 0% with all empty blocks for 0/N", () => {
		const bar = stripAnsi(progressBar(0, 10, 10));
		expect(bar).toContain("░".repeat(10));
		expect(bar).toContain("0%");
		expect(bar).not.toContain("█");
	});

	it("should show 100% with all filled blocks for N/N", () => {
		const bar = stripAnsi(progressBar(10, 10, 10));
		expect(bar).toContain("█".repeat(10));
		expect(bar).toContain("100%");
		expect(bar).not.toContain("░");
	});
});
