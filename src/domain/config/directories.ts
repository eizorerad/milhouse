/**
 * @fileoverview Domain Config Directories
 *
 * Directory and file path constants for Milhouse.
 * This module contains pure constants with NO external dependencies.
 *
 * @module domain/config/directories
 * @since 5.0.0
 */

/**
 * Root Milhouse directory name
 */
export const MILHOUSE_DIR = ".milhouse";

/**
 * Configuration file name
 */
export const CONFIG_FILE = "config.yaml";

/**
 * Progress file name
 */
export const PROGRESS_FILE = "progress.txt";

/**
 * State subdirectory name
 */
export const STATE_DIR = "state";

/**
 * Probes subdirectory name
 */
export const PROBES_DIR = "probes";

/**
 * Plans subdirectory name
 */
export const PLANS_DIR = "plans";

/**
 * Work subdirectory name
 */
export const WORK_DIR = "work";

/**
 * Rules subdirectory name
 */
export const RULES_DIR = "rules";

/**
 * Runs subdirectory name
 */
export const RUNS_DIR = "runs";

/**
 * Full directory structure paths relative to project root
 */
export const DIRECTORIES = {
	/** Root .milhouse directory */
	root: MILHOUSE_DIR,
	/** State directory for runtime state */
	state: `${MILHOUSE_DIR}/${STATE_DIR}`,
	/** Probes directory for probe outputs */
	probes: `${MILHOUSE_DIR}/${PROBES_DIR}`,
	/** Plans directory for execution plans */
	plans: `${MILHOUSE_DIR}/${PLANS_DIR}`,
	/** Work directory for temporary files */
	work: `${MILHOUSE_DIR}/${WORK_DIR}`,
	/** Rules directory for rule files */
	rules: `${MILHOUSE_DIR}/${RULES_DIR}`,
	/** Runs directory for run isolation */
	runs: `${MILHOUSE_DIR}/${RUNS_DIR}`,
} as const;

/**
 * Probe subdirectories within the probes/ folder
 */
export const PROBE_SUBDIRS = ["compose", "postgres", "redis", "storage", "deps", "repro"] as const;

/**
 * Work subdirectories within the work/ folder
 */
export const WORK_SUBDIRS = ["branches", "worktrees"] as const;

/**
 * State subdirectories within the state/ folder
 */
export const STATE_SUBDIRS = ["issues", "tasks", "evidence"] as const;

/**
 * Type for directory keys
 */
export type DirectoryKey = keyof typeof DIRECTORIES;

/**
 * Type for probe subdirectory names
 */
export type ProbeSubdir = (typeof PROBE_SUBDIRS)[number];

/**
 * Type for work subdirectory names
 */
export type WorkSubdir = (typeof WORK_SUBDIRS)[number];

/**
 * Type for state subdirectory names
 */
export type StateSubdir = (typeof STATE_SUBDIRS)[number];

/**
 * Get the relative path for a directory
 *
 * @param key - Directory key
 * @returns Relative path from project root
 */
export function getDirectoryRelativePath(key: DirectoryKey): string {
	return DIRECTORIES[key];
}

/**
 * Get the relative path for a probe subdirectory
 *
 * @param probe - Probe subdirectory name
 * @returns Relative path from project root
 */
export function getProbeRelativePath(probe: ProbeSubdir): string {
	return `${DIRECTORIES.probes}/${probe}`;
}

/**
 * Get the relative path for a work subdirectory
 *
 * @param subdir - Work subdirectory name
 * @returns Relative path from project root
 */
export function getWorkRelativePath(subdir: WorkSubdir): string {
	return `${DIRECTORIES.work}/${subdir}`;
}

/**
 * Get the relative path for a state subdirectory
 *
 * @param subdir - State subdirectory name
 * @returns Relative path from project root
 */
export function getStateRelativePath(subdir: StateSubdir): string {
	return `${DIRECTORIES.state}/${subdir}`;
}

/**
 * Get the relative path for a run directory
 *
 * @param runId - Run identifier
 * @returns Relative path from project root
 */
export function getRunRelativePath(runId: string): string {
	return `${DIRECTORIES.runs}/${runId}`;
}

/**
 * Get the relative path for a run's worktree directory
 *
 * @param runId - Run identifier
 * @param taskId - Task identifier
 * @returns Relative path from project root
 */
export function getRunWorktreeRelativePath(runId: string, taskId: string): string {
	return `${DIRECTORIES.runs}/${runId}/worktrees/${taskId}`;
}

/**
 * Get all directory paths that should exist in .milhouse/
 *
 * @returns Array of relative paths
 */
export function getAllDirectoryRelativePaths(): string[] {
	const paths: string[] = [];

	// Root directories from DIRECTORIES constant
	paths.push(DIRECTORIES.state);
	paths.push(DIRECTORIES.probes);
	paths.push(DIRECTORIES.plans);
	paths.push(DIRECTORIES.work);
	paths.push(DIRECTORIES.rules);
	paths.push(DIRECTORIES.runs);

	// Probe subdirectories
	for (const subdir of PROBE_SUBDIRS) {
		paths.push(getProbeRelativePath(subdir));
	}

	// Work subdirectories
	for (const subdir of WORK_SUBDIRS) {
		paths.push(getWorkRelativePath(subdir));
	}

	// State subdirectories
	for (const subdir of STATE_SUBDIRS) {
		paths.push(getStateRelativePath(subdir));
	}

	return paths;
}

/**
 * Get the config file relative path
 *
 * @returns Relative path to config file
 */
export function getConfigFileRelativePath(): string {
	return `${MILHOUSE_DIR}/${CONFIG_FILE}`;
}

/**
 * Get the progress file relative path
 *
 * @returns Relative path to progress file
 */
export function getProgressFileRelativePath(): string {
	return `${MILHOUSE_DIR}/${PROGRESS_FILE}`;
}
