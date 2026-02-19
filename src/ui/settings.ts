/**
 * @fileoverview Milhouse UI Settings Builder
 *
 * Builds display settings for the Milhouse CLI spinner and status output.
 * These settings provide visual feedback about the current execution mode.
 *
 * @module ui/settings
 *
 * @since 4.0.0
 *
 * @example
 * ```typescript
 * import { buildActiveSettings } from './settings';
 *
 * const settings = buildActiveSettings(options);
 * // Returns: ['fast', 'parallel', 'branch']
 * ```
 */

import type { RuntimeOptions } from "../cli/runtime-options.ts";

/**
 * Milhouse UI setting labels
 *
 * These labels are displayed in the CLI spinner to indicate
 * which options are currently active.
 */
export const MILHOUSE_SETTING_LABELS = {
	/** Fast mode (tests and lint skipped) */
	fast: "fast",
	/** Tests skipped */
	noTests: "no-tests",
	/** Lint skipped */
	noLint: "no-lint",
	/** Dry run mode */
	dryRun: "dry-run",
	/** Branch per task enabled */
	branch: "branch",
	/** PR creation enabled */
	pr: "pr",
	/** Parallel execution enabled */
	parallel: "parallel",
	/** Auto-commit disabled */
	noCommit: "no-commit",
	/** Verbose output enabled */
	verbose: "verbose",
} as const;

/**
 * Type for setting label keys
 */
export type MilhouseSettingKey = keyof typeof MILHOUSE_SETTING_LABELS;

/**
 * Build list of active settings for display in the spinner
 *
 * Analyzes the runtime options and returns a list of human-readable
 * setting labels that indicate which options are currently active.
 * These are displayed in the CLI spinner as tags like [fast], [parallel], etc.
 *
 * @param options - Runtime options from CLI
 * @returns Array of active setting labels
 *
 * @example
 * ```typescript
 * const options = { skipTests: true, skipLint: true, parallel: true };
 * const settings = buildActiveSettings(options);
 * // Returns: ['fast', 'parallel']
 * ```
 */
export function buildActiveSettings(options: RuntimeOptions): string[] {
	const activeSettings: string[] = [];

	// Fast mode (both tests and lint skipped)
	if (options.skipTests && options.skipLint) {
		activeSettings.push(MILHOUSE_SETTING_LABELS.fast);
	} else {
		if (options.skipTests) activeSettings.push(MILHOUSE_SETTING_LABELS.noTests);
		if (options.skipLint) activeSettings.push(MILHOUSE_SETTING_LABELS.noLint);
	}

	if (options.dryRun) activeSettings.push(MILHOUSE_SETTING_LABELS.dryRun);
	if (options.branchPerTask) activeSettings.push(MILHOUSE_SETTING_LABELS.branch);
	if (options.createPr) activeSettings.push(MILHOUSE_SETTING_LABELS.pr);
	if (options.parallel) activeSettings.push(MILHOUSE_SETTING_LABELS.parallel);
	if (!options.autoCommit) activeSettings.push(MILHOUSE_SETTING_LABELS.noCommit);

	return activeSettings;
}

/**
 * Format active settings for display
 *
 * Converts the active settings array into a formatted string
 * suitable for display in the CLI output.
 *
 * @param settings - Array of active setting labels
 * @returns Formatted string with bracketed settings
 *
 * @example
 * ```typescript
 * const formatted = formatActiveSettings(['fast', 'parallel']);
 * // Returns: '[fast] [parallel]'
 * ```
 */
export function formatActiveSettings(settings: string[]): string {
	if (settings.length === 0) {
		return "";
	}
	return settings.map((s) => `[${s}]`).join(" ");
}

/**
 * Check if a specific setting is active
 *
 * @param options - Runtime options from CLI
 * @param setting - Setting key to check
 * @returns True if the setting is active
 *
 * @example
 * ```typescript
 * if (isSettingActive(options, 'fast')) {
 *   console.log('Running in fast mode');
 * }
 * ```
 */
export function isSettingActive(options: RuntimeOptions, setting: MilhouseSettingKey): boolean {
	switch (setting) {
		case "fast":
			return options.skipTests && options.skipLint;
		case "noTests":
			return options.skipTests && !options.skipLint;
		case "noLint":
			return options.skipLint && !options.skipTests;
		case "dryRun":
			return options.dryRun;
		case "branch":
			return options.branchPerTask;
		case "pr":
			return options.createPr;
		case "parallel":
			return options.parallel;
		case "noCommit":
			return !options.autoCommit;
		case "verbose":
			return options.verbose;
		default:
			return false;
	}
}
