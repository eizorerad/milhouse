/**
 * @fileoverview Directory Service
 *
 * Manages the Milhouse directory structure.
 * Handles creation, validation, and path resolution for all
 * Milhouse-related directories.
 *
 * @module services/config/DirectoryService
 * @since 5.0.0
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	DIRECTORIES,
	type DirectoryKey,
	MILHOUSE_DIR,
	PROBE_SUBDIRS,
	type ProbeSubdir,
	STATE_SUBDIRS,
	type StateSubdir,
	WORK_SUBDIRS,
	type WorkSubdir,
	getAllDirectoryRelativePaths,
	getProbeRelativePath,
	getRunRelativePath,
	getStateRelativePath,
	getWorkRelativePath,
} from "../../domain/config/directories.ts";
import type { DirectoryResult, IDirectoryService } from "./types.ts";

/**
 * Directory service class
 *
 * Manages the Milhouse directory structure with:
 * - Directory creation with proper permissions
 * - Structure validation
 * - Path resolution for all directory types
 */
export class DirectoryService implements IDirectoryService {
	/**
	 * Create the complete directory structure
	 *
	 * @param workDir - Working directory
	 * @returns Result with created/existing directories
	 */
	createDirectoryStructure(workDir = process.cwd()): DirectoryResult {
		const created: string[] = [];
		const existing: string[] = [];
		const rootDir = join(workDir, MILHOUSE_DIR);

		// Ensure root .milhouse/ directory exists first
		if (!existsSync(rootDir)) {
			mkdirSync(rootDir, { recursive: true });
			created.push(rootDir);
		} else {
			existing.push(rootDir);
		}

		// Create all subdirectories
		const allPaths = getAllDirectoryRelativePaths();
		for (const relativePath of allPaths) {
			const fullPath = join(workDir, relativePath);
			if (this.ensureDirectory(fullPath)) {
				created.push(fullPath);
			} else {
				existing.push(fullPath);
			}
		}

		return { created, existing };
	}

	/**
	 * Ensure a single directory exists
	 *
	 * @param path - Directory path
	 * @returns Whether the directory was created (false if existed)
	 */
	ensureDirectory(path: string): boolean {
		if (existsSync(path)) {
			return false;
		}
		mkdirSync(path, { recursive: true });
		return true;
	}

	/**
	 * Check if the complete directory structure exists
	 *
	 * @param workDir - Working directory
	 * @returns Whether all directories exist
	 */
	isDirectoryStructureComplete(workDir = process.cwd()): boolean {
		const rootDir = join(workDir, MILHOUSE_DIR);
		if (!existsSync(rootDir)) {
			return false;
		}

		const allPaths = getAllDirectoryRelativePaths();
		return allPaths.every((relativePath) => existsSync(join(workDir, relativePath)));
	}

	/**
	 * Get missing directories from the expected structure
	 *
	 * @param workDir - Working directory
	 * @returns Array of missing directory paths
	 */
	getMissingDirectories(workDir = process.cwd()): string[] {
		const missing: string[] = [];
		const rootDir = join(workDir, MILHOUSE_DIR);

		if (!existsSync(rootDir)) {
			missing.push(rootDir);
		}

		const allPaths = getAllDirectoryRelativePaths();
		for (const relativePath of allPaths) {
			const fullPath = join(workDir, relativePath);
			if (!existsSync(fullPath)) {
				missing.push(fullPath);
			}
		}

		return missing;
	}

	/**
	 * Get a specific directory path by type
	 *
	 * @param type - Directory type
	 * @param workDir - Working directory
	 * @returns Full path to the directory
	 */
	getDirectoryPath(type: string, workDir = process.cwd()): string {
		if (type in DIRECTORIES) {
			return join(workDir, DIRECTORIES[type as DirectoryKey]);
		}
		throw new Error(`Unknown directory type: ${type}`);
	}

	/**
	 * Get a probe subdirectory path
	 *
	 * @param probe - Probe subdirectory name
	 * @param workDir - Working directory
	 * @returns Full path to the probe directory
	 */
	getProbeDirectoryPath(probe: ProbeSubdir, workDir = process.cwd()): string {
		return join(workDir, getProbeRelativePath(probe));
	}

	/**
	 * Get a work subdirectory path
	 *
	 * @param subdir - Work subdirectory name
	 * @param workDir - Working directory
	 * @returns Full path to the work directory
	 */
	getWorkDirectoryPath(subdir: WorkSubdir, workDir = process.cwd()): string {
		return join(workDir, getWorkRelativePath(subdir));
	}

	/**
	 * Get a state subdirectory path
	 *
	 * @param subdir - State subdirectory name
	 * @param workDir - Working directory
	 * @returns Full path to the state directory
	 */
	getStateDirectoryPath(subdir: StateSubdir, workDir = process.cwd()): string {
		return join(workDir, getStateRelativePath(subdir));
	}

	/**
	 * Get a run directory path
	 *
	 * @param runId - Run identifier
	 * @param workDir - Working directory
	 * @returns Full path to the run directory
	 */
	getRunDirectoryPath(runId: string, workDir = process.cwd()): string {
		return join(workDir, getRunRelativePath(runId));
	}

	/**
	 * Create a run directory structure
	 *
	 * @param runId - Run identifier
	 * @param workDir - Working directory
	 * @returns Result with created/existing directories
	 */
	createRunDirectoryStructure(runId: string, workDir = process.cwd()): DirectoryResult {
		const created: string[] = [];
		const existing: string[] = [];

		const runDir = this.getRunDirectoryPath(runId, workDir);
		const subdirs = ["worktrees", "state", "logs", "artifacts"];

		// Create run directory
		if (this.ensureDirectory(runDir)) {
			created.push(runDir);
		} else {
			existing.push(runDir);
		}

		// Create subdirectories
		for (const subdir of subdirs) {
			const subdirPath = join(runDir, subdir);
			if (this.ensureDirectory(subdirPath)) {
				created.push(subdirPath);
			} else {
				existing.push(subdirPath);
			}
		}

		return { created, existing };
	}

	/**
	 * Get all directory paths that should exist in .milhouse/
	 *
	 * @param workDir - Working directory
	 * @returns Array of full paths
	 */
	getAllDirectoryPaths(workDir = process.cwd()): string[] {
		const paths: string[] = [];

		// Root directories from DIRECTORIES constant
		paths.push(join(workDir, DIRECTORIES.state));
		paths.push(join(workDir, DIRECTORIES.probes));
		paths.push(join(workDir, DIRECTORIES.plans));
		paths.push(join(workDir, DIRECTORIES.work));
		paths.push(join(workDir, DIRECTORIES.rules));
		paths.push(join(workDir, DIRECTORIES.runs));

		// Probe subdirectories
		for (const subdir of PROBE_SUBDIRS) {
			paths.push(this.getProbeDirectoryPath(subdir, workDir));
		}

		// Work subdirectories
		for (const subdir of WORK_SUBDIRS) {
			paths.push(this.getWorkDirectoryPath(subdir, workDir));
		}

		// State subdirectories
		for (const subdir of STATE_SUBDIRS) {
			paths.push(this.getStateDirectoryPath(subdir, workDir));
		}

		return paths;
	}
}

/**
 * Create a new directory service
 *
 * @returns New directory service instance
 */
export function createDirectoryService(): DirectoryService {
	return new DirectoryService();
}

/**
 * Default directory service instance
 */
let defaultDirectoryService: DirectoryService | null = null;

/**
 * Get the default directory service instance
 *
 * @returns Directory service instance
 */
export function getDirectoryService(): DirectoryService {
	if (!defaultDirectoryService) {
		defaultDirectoryService = createDirectoryService();
	}
	return defaultDirectoryService;
}

/**
 * Reset the default directory service (for testing)
 */
export function resetDirectoryService(): void {
	defaultDirectoryService = null;
}
