/**
 * Tests for git log parsing utilities.
 */

import { describe, expect, it } from "bun:test";
import { parseTaskNumbersFromLog } from "../src/git.ts";

describe("parseTaskNumbersFromLog", () => {
	it("parses multiple task commits correctly", () => {
		const log = [
			"abc1234 [P-abc123] Task 1: Add utility function",
			"def5678 [P-abc123] Task 2: Update tests",
			"ghi9012 [P-abc123] Task 3: Fix linting",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 2, 3]));
	});

	it("ignores unrelated commits", () => {
		const log = [
			"abc1234 [P-abc123] Task 1: Add utility function",
			"def5678 Merge branch 'main'",
			"ghi9012 fix: unrelated commit",
			"jkl3456 [P-abc123] Task 3: Fix linting",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 3]));
	});

	it("handles empty log", () => {
		expect(parseTaskNumbersFromLog("")).toEqual(new Set());
	});

	it("handles duplicate task numbers", () => {
		const log = [
			"abc1234 [P-abc123] Task 2: First attempt",
			"def5678 [P-abc123] Task 2: Second attempt",
			"ghi9012 [P-abc123] Task 1: Done",
		].join("\n");
		const result = parseTaskNumbersFromLog(log);
		expect(result).toEqual(new Set([1, 2]));
	});
});
