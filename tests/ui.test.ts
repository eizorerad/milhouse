import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Progress, formatDuration, log, setVerbose } from "../src/ui.ts";
import { isAscii } from "./helpers.ts";

let lines: string[];

beforeEach(() => {
	lines = [];
	spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
	spyOn(console, "error").mockImplementation(
		(...args: unknown[]) => void lines.push(args.join(" ")),
	);
});

afterEach(() => {
	spyOn(console, "log").mockRestore();
	spyOn(console, "error").mockRestore();
	setVerbose(false);
});

describe("formatDuration", () => {
	it("formats seconds, minutes and hours", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(-5)).toBe("0s");
		expect(formatDuration(59_000)).toBe("59s");
		expect(formatDuration(61_000)).toBe("1m 1s");
		expect(formatDuration(3_660_000)).toBe("1h 1m");
	});
});

/** Control characters other than tab and newline: what could drive a terminal. */
const hasControlCharacters = (text: string): boolean =>
	[...text].some((c) => {
		const code = c.codePointAt(0) ?? 0;
		return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159);
	});

describe("log (text from agents, git and the repository is not trusted)", () => {
	it("never lets a terminal escape sequence through, whichever level prints it", () => {
		const hostile = "bad \u001b[2J\u001b]0;title\u0007 text\u0085";
		log.info(hostile);
		log.success(hostile);
		log.warn(hostile);
		log.error(hostile);
		const progress = new Progress("exec", 1);
		progress.begin("item");
		progress.note(hostile);
		progress.end("item", false, hostile);
		progress.stop();
		for (const line of lines) {
			const plain = stripVTControlCharacters(line); // only the colours Milhouse adds itself may remain
			expect(hasControlCharacters(plain)).toBe(false);
		}
		expect(lines.join("\n")).toContain("bad ");
	});
});

describe("log", () => {
	it("prints debug lines only in verbose mode", () => {
		log.debug("hidden");
		expect(lines).toEqual([]);
		setVerbose(true);
		log.debug("shown");
		expect(lines.join("")).toContain("shown");
	});

	it("prints every level", () => {
		log.info("a");
		log.success("b");
		log.warn("c");
		log.error("d");
		log.phase("exec");
		expect(lines.join("\n")).toMatch(/a[\s\S]*b[\s\S]*c[\s\S]*d[\s\S]*EXEC/);
	});
});

describe("Progress (not a terminal)", () => {
	it("prints plain lines for starts, results and notes", () => {
		const progress = new Progress("exec", 2);
		progress.begin("first");
		progress.end("first", true);
		progress.begin("second");
		progress.note("second: attempt 1/2 failed: boom");
		progress.end("second", false, "boom");
		progress.stop();
		// CI=true makes picocolors emit colors even without a terminal.
		const text = stripVTControlCharacters(lines.join("\n"));
		expect(text).toContain("... first");
		expect(text).toContain("+ first");
		expect(text).toContain("attempt 1/2 failed");
		expect(text).toMatch(/x second.*boom/);
		expect(isAscii(text)).toBe(true); // for terminals without UTF-8
	});
});
