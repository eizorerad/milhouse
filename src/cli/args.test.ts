/**
 * @fileoverview Unit Tests for CLI Argument Parser
 *
 * Tests the parseArgs function and related parsing logic.
 *
 * @module cli/args.test
 */

import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	describe("severity parsing", () => {
		test("parses valid severity levels", () => {
			const result = parseArgs(["node", "milhouse", "--severity", "CRITICAL,HIGH"]);

			expect(result.options.severityFilter).toEqual(["CRITICAL", "HIGH"]);
		});

		test("parses all valid severity levels", () => {
			const result = parseArgs(["node", "milhouse", "--severity", "CRITICAL,HIGH,MEDIUM,LOW"]);

			expect(result.options.severityFilter).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
		});

		test("handles case-insensitive input", () => {
			const result = parseArgs(["node", "milhouse", "--severity", "critical,high"]);

			expect(result.options.severityFilter).toEqual(["CRITICAL", "HIGH"]);
		});

		test("filters out invalid severity values", () => {
			const result = parseArgs(["node", "milhouse", "--severity", "CRITICAL,INVALID,HIGH,BOGUS"]);

			expect(result.options.severityFilter).toEqual(["CRITICAL", "HIGH"]);
		});

		test("returns undefined for all invalid values", () => {
			const result = parseArgs(["node", "milhouse", "--severity", "INVALID,BOGUS,FAKE"]);

			expect(result.options.severityFilter).toBeUndefined();
		});

		test("handles empty string", () => {
			const result = parseArgs(["node", "milhouse", "--severity", ""]);

			expect(result.options.severityFilter).toBeUndefined();
		});

		test("handles whitespace in values", () => {
			const result = parseArgs(["node", "milhouse", "--severity", " CRITICAL , HIGH "]);

			expect(result.options.severityFilter).toEqual(["CRITICAL", "HIGH"]);
		});
	});

	describe("min-severity parsing", () => {
		test("parses valid single severity level", () => {
			const result = parseArgs(["node", "milhouse", "--min-severity", "HIGH"]);

			expect(result.options.minSeverity).toBe("HIGH");
		});

		test("handles case-insensitive input", () => {
			const result = parseArgs(["node", "milhouse", "--min-severity", "critical"]);

			expect(result.options.minSeverity).toBe("CRITICAL");
		});

		test("returns undefined for invalid value", () => {
			const result = parseArgs(["node", "milhouse", "--min-severity", "INVALID"]);

			expect(result.options.minSeverity).toBeUndefined();
		});
	});

	describe("issue IDs parsing", () => {
		test("parses comma-separated issue IDs", () => {
			const result = parseArgs(["node", "milhouse", "--issues", "P-001,P-002,P-003"]);

			expect(result.options.issueIds).toEqual(["P-001", "P-002", "P-003"]);
		});

		test("handles whitespace in issue IDs", () => {
			const result = parseArgs(["node", "milhouse", "--issues", " P-001 , P-002 "]);

			expect(result.options.issueIds).toEqual(["P-001", "P-002"]);
		});

		test("filters empty values", () => {
			const result = parseArgs(["node", "milhouse", "--issues", "P-001,,P-002,"]);

			expect(result.options.issueIds).toEqual(["P-001", "P-002"]);
		});
	});

	describe("maxValidationRetries parsing", () => {
		test("defaults to 2 when not specified", () => {
			const result = parseArgs(["node", "milhouse"]);

			expect(result.options.maxValidationRetries).toBe(2);
		});

		test("parses positive integer values", () => {
			const result = parseArgs(["node", "milhouse", "--max-validation-retries", "5"]);

			expect(result.options.maxValidationRetries).toBe(5);
		});

		test("allows zero value to disable retries", () => {
			const result = parseArgs(["node", "milhouse", "--max-validation-retries", "0"]);

			expect(result.options.maxValidationRetries).toBe(0);
		});

		test("parses string '0' as integer 0", () => {
			const result = parseArgs(["node", "milhouse", "--max-validation-retries", "0"]);

			expect(result.options.maxValidationRetries).toBe(0);
			expect(typeof result.options.maxValidationRetries).toBe("number");
		});
	});
});
