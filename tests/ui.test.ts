import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Progress, formatDuration, log, setVerbose } from "../src/ui.ts";
import { isAscii, waitFor } from "./helpers.ts";

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

function mockStdout(key: "isTTY" | "columns", value: boolean | number) {
	const was = Object.getOwnPropertyDescriptor(process.stdout, key);
	Object.defineProperty(process.stdout, key, { value, writable: true, configurable: true });
	return () => {
		if (was) Object.defineProperty(process.stdout, key, was);
		else Reflect.deleteProperty(process.stdout, key);
	};
}

describe("Progress", () => {
	let written: string[];
	let restoreTTY: () => void;
	let restoreColumns: () => void;
	let oldTerm: string | undefined;
	let progress: Progress;

	beforeEach(() => {
		written = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		restoreTTY = mockStdout("isTTY", true);
		restoreColumns = mockStdout("columns", 80);
		oldTerm = process.env.TERM;
		process.env.TERM = "xterm";
	});

	afterEach(() => {
		progress.stop();
		restoreTTY();
		restoreColumns();
		if (oldTerm === undefined) Reflect.deleteProperty(process.env, "TERM");
		else process.env.TERM = oldTerm;
		spyOn(process.stdout, "write").mockRestore();
	});

	const frames = () =>
		written
			.filter((chunk) => chunk.startsWith("\r") && chunk !== "\r\x1b[K")
			.map((chunk) => stripVTControlCharacters(chunk.slice(1)));

	it("keeps untrusted names on one line", async () => {
		progress = new Progress("scan", 1);
		progress.begin("bad \u001b[2J\u001b]0;title\u0007\nname\tend");
		await waitFor(() => frames().length > 0, 1000);
		expect(frames()[0]).toContain("bad [2J]0;title name end");
		expect(written.join("")).not.toContain("\u001b[2J");
		expect(written.join("")).not.toContain("\u0007");
	});

	it("keeps five parallel jobs on one physical row, including after a resize", async () => {
		progress = new Progress("validate", 5);
		// Phases shorten titles, so two parallel jobs can have the same display name.
		const titles = [1, 1, 2, 3, 4].map((i) => `issue ${i}: ${"界".repeat(28)}`);
		for (const title of titles) progress.begin(title);
		await waitFor(() => frames().length >= 2, 1000);
		expect(frames().length).toBeGreaterThanOrEqual(2);
		for (const frame of frames()) {
			expect(frame).toContain("validate 0/5");
			expect(frame).toContain("5 running");
			expect(Bun.stringWidth(frame)).toBeLessThan(80);
		}
		for (const title of titles.slice(0, 4)) progress.end(title, true);
		written.length = 0;
		// The remaining title fits in JS characters here, but not in terminal columns.
		process.stdout.columns = 66;
		await waitFor(() => frames().length > 0, 1000);
		expect(frames()[0]).toContain("validate 4/5");
		expect(Bun.stringWidth(frames()[0])).toBeLessThan(66);
		written.length = 0;
		process.stdout.columns = 6;
		await waitFor(() => frames().length > 0, 1000);
		expect(frames()[0]).toContain("4/5");
		expect(Bun.stringWidth(frames()[0])).toBeLessThan(6);
		progress.end(titles[4], true);
		expect(lines.map(stripVTControlCharacters)).toEqual(titles.map((title) => `  + ${title}`));
	});

	it.each([
		["piped output", false, 80, "xterm"],
		["a dumb terminal", true, 80, "dumb"],
		["an unknown width", true, 0, "xterm"],
	] as const)("prints plain events without redraws for %s", async (_, tty, columns, term) => {
		process.stdout.isTTY = tty;
		process.stdout.columns = columns;
		process.env.TERM = term;
		progress = new Progress("exec", 2);
		progress.begin("first");
		await Bun.sleep(160);
		progress.end("first", true);
		progress.begin("second");
		progress.note("second: attempt 1/2 failed: boom");
		progress.end("second", false, "boom");
		progress.stop();
		expect(written).toEqual([]);
		// CI=true makes picocolors emit colors even without a terminal.
		const text = stripVTControlCharacters(lines.join("\n"));
		expect(text).toContain("... first");
		expect(text).toContain("+ first");
		expect(text).toContain("attempt 1/2 failed");
		expect(text).toMatch(/x second.*boom/);
		expect(isAscii(text)).toBe(true); // for terminals without UTF-8
	});
});
