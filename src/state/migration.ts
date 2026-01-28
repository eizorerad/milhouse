/**
 * Migration module
 *
 * Handles migrating legacy state structures to the new runs-based system.
 * This module provides utilities for upgrading from the flat .milhouse/state/
 * structure to the run-based .milhouse/runs/<run-id>/ structure.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta } from "./types.ts";
import {
	createRun,
	getRunDir,
	getRunStateDir,
	loadRunsIndex,
} from "./runs.ts";

// ============================================================================
// INTERNAL UTILITIES
// ============================================================================

const MILHOUSE_DIR = ".milhouse";

/**
 * Get the full path to the milhouse directory
 */
function getMilhouseDir(workDir = process.cwd()): string {
	return join(workDir, MILHOUSE_DIR);
}

/**
 * Get path to plans directory (legacy)
 */
function getPlansDir(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "plans");
}

// ============================================================================
// MIGRATION FUNCTIONS
// ============================================================================

/**
 * Migrate legacy state to a new run
 *
 * This is useful when user has existing .milhouse/state/ and wants to use runs.
 * It copies all state files from the legacy location to a new run directory.
 *
 * @param options - Migration options
 * @returns The created run metadata, or null if no legacy state exists
 */
export function migrateLegacyToRun(
	options: {
		scope?: string;
		name?: string;
		workDir?: string;
	} = {},
): RunMeta | null {
	const workDir = options.workDir ?? process.cwd();
	const legacyStateDir = join(getMilhouseDir(workDir), "state");

	// Check if legacy state exists
	if (!existsSync(legacyStateDir)) {
		return null;
	}

	// Check if legacy has any content
	const files = readdirSync(legacyStateDir);
	if (files.length === 0) {
		return null;
	}

	// Create new run
	const run = createRun({
		scope: options.scope || "migrated from legacy",
		name: options.name || "legacy-migration",
		workDir,
	});

	// Copy legacy files to run state directory
	const runStateDir = getRunStateDir(run.id, workDir);

	for (const file of files) {
		const srcPath = join(legacyStateDir, file);
		const destPath = join(runStateDir, file);

		if (existsSync(srcPath)) {
			const content = readFileSync(srcPath, "utf-8");
			writeFileSync(destPath, content);
		}
	}

	// Copy plans if exist
	const legacyPlansDir = getPlansDir(workDir);
	if (existsSync(legacyPlansDir)) {
		const runPlansDir = join(getRunDir(run.id, workDir), "plans");
		const planFiles = readdirSync(legacyPlansDir);

		for (const file of planFiles) {
			const srcPath = join(legacyPlansDir, file);
			const destPath = join(runPlansDir, file);

			if (existsSync(srcPath)) {
				const content = readFileSync(srcPath, "utf-8");
				writeFileSync(destPath, content);
			}
		}
	}

	// Copy probes if exist
	const legacyProbesDir = join(getMilhouseDir(workDir), "probes");
	if (existsSync(legacyProbesDir)) {
		const runProbesDir = join(getRunDir(run.id, workDir), "probes");
		copyDirectoryRecursive(legacyProbesDir, runProbesDir);
	}

	return run;
}

/**
 * Copy a directory recursively
 */
function copyDirectoryRecursive(src: string, dest: string): void {
	if (!existsSync(src)) {
		return;
	}

	if (!existsSync(dest)) {
		mkdirSync(dest, { recursive: true });
	}

	const entries = readdirSync(src, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);

		if (entry.isDirectory()) {
			copyDirectoryRecursive(srcPath, destPath);
		} else {
			const content = readFileSync(srcPath, "utf-8");
			writeFileSync(destPath, content);
		}
	}
}

/**
 * Check if legacy state exists
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns true if legacy state directory exists and has files
 */
export function hasLegacyState(workDir = process.cwd()): boolean {
	const legacyStateDir = join(getMilhouseDir(workDir), "state");

	if (!existsSync(legacyStateDir)) {
		return false;
	}

	const files = readdirSync(legacyStateDir);
	return files.length > 0;
}

/**
 * Get legacy state file paths
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns Array of file paths in legacy state directory
 */
export function getLegacyStateFiles(workDir = process.cwd()): string[] {
	const legacyStateDir = join(getMilhouseDir(workDir), "state");

	if (!existsSync(legacyStateDir)) {
		return [];
	}

	return readdirSync(legacyStateDir).map((f) => join(legacyStateDir, f));
}

/**
 * Clean up legacy state after migration
 *
 * WARNING: This permanently deletes the legacy state directory.
 * Only call this after confirming migration was successful.
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns true if cleanup was performed
 */
export function cleanupLegacyState(workDir = process.cwd()): boolean {
	const legacyStateDir = join(getMilhouseDir(workDir), "state");

	if (!existsSync(legacyStateDir)) {
		return false;
	}

	rmSync(legacyStateDir, { recursive: true, force: true });
	return true;
}

/**
 * Migrate state from one run to another
 *
 * This is useful for creating a new run based on an existing run's state.
 *
 * @param sourceRunId - The run to copy from
 * @param options - Options for the new run
 * @param workDir - Working directory (defaults to cwd)
 * @returns The created run metadata, or null if source run doesn't exist
 */
export function cloneRunState(
	sourceRunId: string,
	options: {
		scope?: string;
		name?: string;
	} = {},
	workDir = process.cwd(),
): RunMeta | null {
	const sourceStateDir = getRunStateDir(sourceRunId, workDir);

	if (!existsSync(sourceStateDir)) {
		return null;
	}

	// Create new run
	const run = createRun({
		scope: options.scope || `cloned from ${sourceRunId}`,
		name: options.name,
		workDir,
	});

	// Copy state files
	const destStateDir = getRunStateDir(run.id, workDir);
	const files = readdirSync(sourceStateDir);

	for (const file of files) {
		const srcPath = join(sourceStateDir, file);
		const destPath = join(destStateDir, file);

		if (existsSync(srcPath)) {
			const content = readFileSync(srcPath, "utf-8");
			writeFileSync(destPath, content);
		}
	}

	// Copy plans
	const sourcePlansDir = join(getRunDir(sourceRunId, workDir), "plans");
	if (existsSync(sourcePlansDir)) {
		const destPlansDir = join(getRunDir(run.id, workDir), "plans");
		copyDirectoryRecursive(sourcePlansDir, destPlansDir);
	}

	return run;
}

/**
 * Get migration status
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns Object describing migration status
 */
export function getMigrationStatus(workDir = process.cwd()): {
	hasLegacy: boolean;
	hasRuns: boolean;
	legacyFileCount: number;
	runCount: number;
	recommendation: string;
} {
	const hasLegacy = hasLegacyState(workDir);
	const legacyFiles = getLegacyStateFiles(workDir);
	const index = loadRunsIndex(workDir);

	let recommendation: string;
	if (hasLegacy && index.runs.length === 0) {
		recommendation = "Run 'milhouse migrate' to convert legacy state to a run";
	} else if (hasLegacy && index.runs.length > 0) {
		recommendation = "Both legacy and runs exist. Consider cleaning up legacy state.";
	} else if (!hasLegacy && index.runs.length === 0) {
		recommendation = "No state found. Start with 'milhouse scan --scope \"...\"'";
	} else {
		recommendation = "Using runs-based state management. No migration needed.";
	}

	return {
		hasLegacy,
		hasRuns: index.runs.length > 0,
		legacyFileCount: legacyFiles.length,
		runCount: index.runs.length,
		recommendation,
	};
}
