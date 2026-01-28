/**
 * @fileoverview Unit Tests for Config Types Module
 *
 * Tests that RuntimeOptions is properly re-exported and consistent
 * across different import paths.
 *
 * @module config/types.test
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPTIONS as ConfigDefaultOptions,
	type RuntimeOptions as ConfigRuntimeOptions,
} from "./types.ts";
import {
	DEFAULT_OPTIONS as CliDefaultOptions,
	type RuntimeOptions as CliRuntimeOptions,
} from "../cli/runtime-options.ts";

describe("RuntimeOptions type consistency", () => {
	test("config/types.ts re-exports RuntimeOptions from cli/runtime-options.ts", () => {
		// Both DEFAULT_OPTIONS should be the exact same object reference
		// since config/types.ts now re-exports from cli/runtime-options.ts
		expect(ConfigDefaultOptions).toBe(CliDefaultOptions);
	});

	test("DEFAULT_OPTIONS has required fields", () => {
		// Verify all required fields exist
		expect(ConfigDefaultOptions).toHaveProperty("skipTests");
		expect(ConfigDefaultOptions).toHaveProperty("skipLint");
		expect(ConfigDefaultOptions).toHaveProperty("aiEngine");
		expect(ConfigDefaultOptions).toHaveProperty("dryRun");
		expect(ConfigDefaultOptions).toHaveProperty("maxIterations");
		expect(ConfigDefaultOptions).toHaveProperty("maxRetries");
		expect(ConfigDefaultOptions).toHaveProperty("retryDelay");
		expect(ConfigDefaultOptions).toHaveProperty("verbose");
		expect(ConfigDefaultOptions).toHaveProperty("branchPerTask");
		expect(ConfigDefaultOptions).toHaveProperty("baseBranch");
		expect(ConfigDefaultOptions).toHaveProperty("createPr");
		expect(ConfigDefaultOptions).toHaveProperty("draftPr");
		expect(ConfigDefaultOptions).toHaveProperty("autoCommit");
		expect(ConfigDefaultOptions).toHaveProperty("parallel");
		expect(ConfigDefaultOptions).toHaveProperty("maxParallel");
		expect(ConfigDefaultOptions).toHaveProperty("prdSource");
		expect(ConfigDefaultOptions).toHaveProperty("prdFile");
		expect(ConfigDefaultOptions).toHaveProperty("prdIsFolder");
		expect(ConfigDefaultOptions).toHaveProperty("githubRepo");
		expect(ConfigDefaultOptions).toHaveProperty("githubLabel");
		expect(ConfigDefaultOptions).toHaveProperty("browserEnabled");
		expect(ConfigDefaultOptions).toHaveProperty("skipProbes");
		expect(ConfigDefaultOptions).toHaveProperty("maxValidationRetries");
		expect(ConfigDefaultOptions).toHaveProperty("retryUnvalidated");
		expect(ConfigDefaultOptions).toHaveProperty("retryDelayValidation");
	});

	test("DEFAULT_OPTIONS has correct default values", () => {
		expect(ConfigDefaultOptions.skipTests).toBe(false);
		expect(ConfigDefaultOptions.skipLint).toBe(false);
		expect(ConfigDefaultOptions.aiEngine).toBe("claude");
		expect(ConfigDefaultOptions.dryRun).toBe(false);
		expect(ConfigDefaultOptions.maxIterations).toBe(0);
		expect(ConfigDefaultOptions.maxRetries).toBe(3);
		expect(ConfigDefaultOptions.retryDelay).toBe(5000);
		expect(ConfigDefaultOptions.verbose).toBe(false);
		expect(ConfigDefaultOptions.branchPerTask).toBe(false);
		expect(ConfigDefaultOptions.baseBranch).toBe("");
		expect(ConfigDefaultOptions.createPr).toBe(false);
		expect(ConfigDefaultOptions.draftPr).toBe(false);
		expect(ConfigDefaultOptions.autoCommit).toBe(true);
		expect(ConfigDefaultOptions.parallel).toBe(false);
		expect(ConfigDefaultOptions.maxParallel).toBe(4);
		expect(ConfigDefaultOptions.prdSource).toBe("markdown");
		expect(ConfigDefaultOptions.prdFile).toBe("PRD.md");
		expect(ConfigDefaultOptions.prdIsFolder).toBe(false);
		expect(ConfigDefaultOptions.githubRepo).toBe("");
		expect(ConfigDefaultOptions.githubLabel).toBe("");
		expect(ConfigDefaultOptions.browserEnabled).toBe("auto");
		expect(ConfigDefaultOptions.skipProbes).toBe(false);
		expect(ConfigDefaultOptions.maxValidationRetries).toBe(2);
		expect(ConfigDefaultOptions.retryUnvalidated).toBe(true);
		expect(ConfigDefaultOptions.retryDelayValidation).toBe(2000);
	});

	test("RuntimeOptions type is assignable between import paths", () => {
		// This test verifies type compatibility at compile time
		// If config/types.ts properly re-exports from cli/runtime-options.ts,
		// these assignments should work without type errors
		const cliOptions: CliRuntimeOptions = { ...CliDefaultOptions };
		const configOptions: ConfigRuntimeOptions = cliOptions;

		// And vice versa
		const configOptions2: ConfigRuntimeOptions = { ...ConfigDefaultOptions };
		const cliOptions2: CliRuntimeOptions = configOptions2;

		// Both should have same values
		expect(configOptions).toEqual(cliOptions);
		expect(cliOptions2).toEqual(configOptions2);
	});
});
