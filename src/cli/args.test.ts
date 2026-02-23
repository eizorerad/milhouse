/**
 * @fileoverview Unit Tests for CLI Argument Parser
 *
 * Tests the parseArgs function and related parsing logic.
 *
 * @module cli/args.test
 */

import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";
import { DEFAULTS, resolveConfig } from "../config/define";

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

	describe("unsafe DoD checks flag", () => {
		test("defaults to false when not specified", () => {
			const result = parseArgs(["node", "milhouse"]);
			expect(result.options.unsafeDoDChecks).toBe(false);
		});

		test("sets to true when --unsafe-dod-checks is provided", () => {
			const result = parseArgs(["node", "milhouse", "--unsafe-dod-checks"]);
			expect(result.options.unsafeDoDChecks).toBe(true);
		});
	});

	describe("failFast parsing", () => {
		test("no flag: options.failFast is undefined, parsed failFast is true", () => {
			const result = parseArgs(["node", "milhouse"]);
			expect(result.options.failFast).toBeUndefined();
			expect(result.failFast).toBe(true);
		});

		test("--fail-fast: options.failFast is true, parsed failFast is true", () => {
			const result = parseArgs(["node", "milhouse", "--fail-fast"]);
			expect(result.options.failFast).toBe(true);
			expect(result.failFast).toBe(true);
		});

		test("--no-fail-fast: options.failFast is false, parsed failFast is false", () => {
			const result = parseArgs(["node", "milhouse", "--no-fail-fast"]);
			expect(result.options.failFast).toBe(false);
			expect(result.failFast).toBe(false);
		});

		test("--exec-fail-fast: options.failFast is true", () => {
			const result = parseArgs(["node", "milhouse", "--exec-fail-fast"]);
			expect(result.options.failFast).toBe(true);
		});

		test("DEFAULTS.failFast is true", () => {
			expect(DEFAULTS.failFast).toBe(true);
		});

		test("resolveConfig({}) returns failFast: true", () => {
			const resolved = resolveConfig({});
			expect(resolved.failFast).toBe(true);
		});

		test("resolveConfig({ failFast: false }) returns failFast: false", () => {
			const resolved = resolveConfig({ failFast: false });
			expect(resolved.failFast).toBe(false);
		});
	});
});
