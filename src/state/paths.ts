/**
 * Centralized path resolution for state files
 * This module handles run-aware path resolution to support isolated runs
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_FILES, type RunsIndex, RunsIndexSchema, STATE_FILES } from "./types.ts";

export const MILHOUSE_DIR = ".milhouse";

/**
 * Get the full path to the milhouse directory
 */
export function getMilhouseDir(workDir = process.cwd()): string {
	return join(workDir, MILHOUSE_DIR);
}

/**
 * Get path to runs index file
 */
function getRunsIndexPath(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), RUNS_FILES.index);
}

/**
 * Load runs index (minimal implementation to avoid circular deps)
 */
function loadRunsIndex(workDir = process.cwd()): RunsIndex {
	const path = getRunsIndexPath(workDir);
	if (!existsSync(path)) {
		return { current_run: null, runs: [] };
	}
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		return RunsIndexSchema.parse(parsed);
	} catch {
		return { current_run: null, runs: [] };
	}
}

/**
 * Get current active run ID
 */
export function getCurrentRunId(workDir = process.cwd()): string | null {
	const index = loadRunsIndex(workDir);
	return index.current_run;
}

/**
 * Get path to runs directory
 */
export function getRunsDir(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), RUNS_FILES.runsDir);
}

/**
 * Get path to a specific run directory
 */
export function getRunDir(runId: string, workDir = process.cwd()): string {
	return join(getRunsDir(workDir), runId);
}

/**
 * Get path to a run's state directory
 */
export function getRunStateDir(runId: string, workDir = process.cwd()): string {
	return join(getRunDir(runId, workDir), "state");
}

/**
 * Get state file path - supports both runs and legacy mode
 * If a run is active, uses run-specific state directory
 * Otherwise, falls back to legacy .milhouse/state/ directory
 *
 * @param file - The state file key (issues, tasks, graph, executions, run)
 * @param workDir - Working directory
 * @returns Full path to the state file
 */
export function getStatePathForCurrentRun(
	file: keyof typeof STATE_FILES,
	workDir = process.cwd(),
): string {
	const currentRunId = getCurrentRunId(workDir);

	if (currentRunId) {
		// Use run-specific state directory
		return join(getRunStateDir(currentRunId, workDir), STATE_FILES[file]);
	}

	// Legacy fallback - no active run
	return join(getMilhouseDir(workDir), "state", STATE_FILES[file]);
}

/**
 * Get plans directory for current run
 */
export function getPlansPathForCurrentRun(workDir = process.cwd()): string {
	const currentRunId = getCurrentRunId(workDir);

	if (currentRunId) {
		return join(getRunDir(currentRunId, workDir), "plans");
	}

	return join(getMilhouseDir(workDir), "plans");
}

/**
 * Get probes directory for current run
 */
export function getProbesPathForCurrentRun(probeType: string, workDir = process.cwd()): string {
	const currentRunId = getCurrentRunId(workDir);

	if (currentRunId) {
		return join(getRunDir(currentRunId, workDir), "probes", probeType);
	}

	return join(getMilhouseDir(workDir), "probes", probeType);
}
