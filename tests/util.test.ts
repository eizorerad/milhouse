/**
 * Tests for utility functions.
 */

import { describe, expect, it } from "bun:test";
import { extractJson, generateId, now } from "../src/util.ts";

describe("extractJson", () => {
	it("extracts from ```json code block", () => {
		const input = "Here's the result:\n\n```json\n{\"key\": \"value\"}\n```\n\nDone.";
		expect(extractJson(input)).toBe('{"key": "value"}');
	});

	it("extracts from ``` code block", () => {
		const input = "```\n[1, 2, 3]\n```";
		expect(extractJson(input)).toBe("[1, 2, 3]");
	});

	it("extracts raw JSON object", () => {
		expect(extractJson('{"a": 1}')).toBe('{"a": 1}');
	});

	it("extracts raw JSON array", () => {
		expect(extractJson("[1, 2]")).toBe("[1, 2]");
	});

	it("handles nested JSON", () => {
		const input = '{"a": {"b": [1, 2]}, "c": 3}';
		expect(extractJson(input)).toBe(input);
	});

	it("returns null for no JSON", () => {
		expect(extractJson("No JSON here.")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(extractJson("")).toBeNull();
	});

	it("ignores non-JSON code blocks", () => {
		const input = "```\nhello world\n```";
		expect(extractJson(input)).toBeNull();
	});

	it("handles square brackets inside string values", () => {
		const input = '{"msg": "use arr[0]"}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles curly braces inside string values", () => {
		const input = '{"msg": "obj{key}"}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles escaped quotes inside string values", () => {
		const input = '{"msg": "say \\"hi\\""}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles array with string elements containing brackets", () => {
		const input = '["arr[0]", "obj{x}"]';
		expect(extractJson(input)).toBe(input);
	});

	it("handles top-level closing delimiters inside string values", () => {
		const input = '{"msg": "}"}';
		expect(extractJson(input)).toBe(input);
	});

	it("handles top-level closing delimiters inside array strings", () => {
		const input = '["]"]';
		expect(extractJson(input)).toBe(input);
	});
});

describe("generateId", () => {
	it("generates with default prefix", () => {
		const id = generateId();
		expect(id).toMatch(/^P-[a-z0-9]+-[a-z0-9]+$/);
	});

	it("generates with custom prefix", () => {
		const id = generateId("T");
		expect(id.startsWith("T-")).toBe(true);
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateId()));
		expect(ids.size).toBe(100);
	});
});

describe("now", () => {
	it("returns ISO string", () => {
		const ts = now();
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});
