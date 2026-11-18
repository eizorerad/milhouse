import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Progress, formatDuration, log, setVerbose } from "../src/ui.ts";

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
		const text = lines.join("\n");
		expect(text).toContain("… first");
		expect(text).toContain("+ first");
		expect(text).toContain("attempt 1/2 failed");
		expect(text).toMatch(/x second.*boom/);
	});
});
