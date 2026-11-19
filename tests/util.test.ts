import { describe, expect, it } from "bun:test";
import { extractJson, mapPool, parseJson, sleep, tail } from "../src/util.ts";

describe("extractJson", () => {
	it("returns raw JSON as is", () => {
		expect(extractJson('{"a":1}')).toBe('{"a":1}');
		expect(extractJson("[1,2]")).toBe("[1,2]");
	});

	it("finds JSON inside a fenced block with prose around it", () => {
		const text = 'Here you go:\n```json\n{"items": [{"title": "x"}]}\n```\nDone.';
		expect(JSON.parse(extractJson(text) as string)).toEqual({ items: [{ title: "x" }] });
	});

	it("is not fooled by brackets and backticks inside strings", () => {
		const text = '{"code": "if (a[0]) { return `x`; } // ``` not a fence", "ok": true}';
		expect(JSON.parse(extractJson(text) as string).ok).toBe(true);
	});

	it("skips a bracket in prose and finds the real JSON after it", () => {
		const text = 'Use the {thing} like so: {"status": "CONFIRMED"}';
		expect(extractJson(text)).toBe('{"status": "CONFIRMED"}');
	});

	it("handles escaped quotes", () => {
		expect(JSON.parse(extractJson('{"a": "say \\"hi\\" }"}') as string).a).toBe('say "hi" }');
	});

	it("returns null when there is no JSON", () => {
		expect(extractJson("no json here")).toBeNull();
		expect(extractJson('{"broken": ')).toBeNull();
		expect(extractJson("")).toBeNull();
	});
});

describe("parseJson", () => {
	it("parses and returns the value", () => {
		expect(parseJson<{ a: number }>('x {"a": 1}', "Test").a).toBe(1);
	});

	it("throws a short, labelled error", () => {
		expect(() => parseJson("nothing", "Scan")).toThrow(/Scan: no JSON/);
	});
});

describe("mapPool", () => {
	it("keeps the input order and never exceeds the pool size", async () => {
		let running = 0;
		let peak = 0;
		const results = await mapPool([30, 10, 20, 5, 1], 2, async (ms, index) => {
			running++;
			peak = Math.max(peak, running);
			await sleep(ms);
			running--;
			return index;
		});
		expect(results).toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
	});

	it("handles an empty list and a pool size below one", async () => {
		expect(await mapPool([], 3, async (x) => x)).toEqual([]);
		expect(await mapPool([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
	});
});

describe("tail", () => {
	it("keeps short text and cuts long text from the front", () => {
		expect(tail("  short  ")).toBe("short");
		expect(tail("abcdef", 3)).toBe("...def");
	});
});
