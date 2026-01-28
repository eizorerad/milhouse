/**
 * Plan Store Module
 *
 * Provides a run-aware API for all plan operations.
 * When there's an active run, all plans are read/written in `.milhouse/runs/<runId>/plans`.
 * The `.milhouse/plans` directory becomes only a view/export (symlink or copy).
 *
 * @module state/plan-store
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { MILHOUSE_DIR, PLANS_DIR } from "../domain/config/directories.ts";
import { createLogger } from "../observability/logger.ts";
import { StateWriteError } from "./errors.ts";
import { getCurrentRunId, getRunDir } from "./paths.ts";

// ============================================================================
// METADATA HEADER GENERATION
// ============================================================================

/**
 * Options for creating plan metadata headers
 */
export interface PlanMetadataOptions {
	/** Issue ID for WBS plans */
	issueId?: string;
	/** Custom scope description */
	scope?: string;
}

/**
 * Creates a metadata header for plan artifacts.
 *
 * The header is in HTML comment format so it doesn't render in markdown viewers
 * but is still visible in raw files for traceability.
 *
 * @param workDir - Working directory (defaults to process.cwd())
 * @param options - Optional metadata options (issueId, scope)
 * @returns Metadata header string with trailing newline
 *
 * @example
 * // Basic usage
 * const header = createPlanMetadataHeader(workDir);
 * // Returns:
 * // <!-- Run ID: run_2024-01-27_12-30-45 -->
 * // <!-- Generated: 2024-01-27T12:30:45.000Z -->
 *
 * @example
 * // With issue ID for WBS plans
 * const header = createPlanMetadataHeader(workDir, { issueId: 'ISS-001' });
 * // Returns:
 * // <!-- Run ID: run_2024-01-27_12-30-45 -->
 * // <!-- Generated: 2024-01-27T12:30:45.000Z -->
 * // <!-- Issue: ISS-001 -->
 */
export function createPlanMetadataHeader(
	workDir = process.cwd(),
	options?: PlanMetadataOptions,
): string {
	const runId = getCurrentRunId(workDir) || "no-run";
	const generated = new Date().toISOString();

	const lines: string[] = [
		`<!-- Run ID: ${runId} -->`,
		`<!-- Generated: ${generated} -->`,
	];

	if (options?.issueId) {
		lines.push(`<!-- Issue: ${options.issueId} -->`);
	}

	if (options?.scope) {
		lines.push(`<!-- Scope: ${options.scope} -->`);
	}

	return lines.join("\n") + "\n\n";
}

// Create a logger for plan store operations
const log = createLogger("plan-store");

// ============================================================================
// CORE PATH RESOLUTION
// ============================================================================

/**
 * Get the current plans directory based on active run state.
 *
 * Returns run-scoped dir (.milhouse/runs/<runId>/plans) when active run exists,
 * otherwise returns legacy .milhouse/plans
 *
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns Full path to the current plans directory
 */
export function getCurrentPlansDir(workDir = process.cwd()): string {
	const currentRunId = getCurrentRunId(workDir);

	if (currentRunId) {
		const runPlansDir = join(getRunDir(currentRunId, workDir), "plans");
		log.debug({ runId: currentRunId, plansDir: runPlansDir }, "Using run-scoped plans directory");
		return runPlansDir;
	}

	const legacyPlansDir = join(workDir, MILHOUSE_DIR, PLANS_DIR);
	log.debug({ plansDir: legacyPlansDir }, "Using legacy plans directory (no active run)");
	return legacyPlansDir;
}

/**
 * Get the legacy plans directory path (always .milhouse/plans)
 *
 * @param workDir - Working directory (defaults to process.cwd())
 * @returns Full path to the legacy plans directory
 */
export function getLegacyPlansDir(workDir = process.cwd()): string {
	return join(workDir, MILHOUSE_DIR, PLANS_DIR);
}

/**
 * Creates the plans directory if it doesn't exist.
 *
 * @param workDir - Working directory (defaults to process.cwd())
 */
export function ensurePlansDirExists(workDir = process.cwd()): void {
	const plansDir = getCurrentPlansDir(workDir);
	if (!existsSync(plansDir)) {
		mkdirSync(plansDir, { recursive: true });
		log.debug({ plansDir }, "Created plans directory");
	}
}

// ============================================================================
// GENERIC FILE OPERATIONS
// ============================================================================

/**
 * Writes a file to the current plans directory.
 *
 * @param workDir - Working directory
 * @param filename - Name of the file to write
 * @param content - Content to write
 * @returns Full path to the written file
 * @throws StateWriteError if write fails
 */
export function writePlanFile(workDir: string, filename: string, content: string): string {
	ensurePlansDirExists(workDir);
	const plansDir = getCurrentPlansDir(workDir);
	const filePath = join(plansDir, filename);

	try {
		writeFileSync(filePath, content, "utf-8");
		log.debug({ filePath, filename }, "Wrote plan file");
		return filePath;
	} catch (error) {
		throw new StateWriteError(`Failed to write plan file: ${filename}`, {
			filePath,
			cause: error instanceof Error ? error : new Error(String(error)),
		});
	}
}

/**
 * Reads a file from the current plans directory.
 *
 * @param workDir - Working directory
 * @param filename - Name of the file to read
 * @returns File content or null if not found
 */
export function readPlanFile(workDir: string, filename: string): string | null {
	const plansDir = getCurrentPlansDir(workDir);
	const filePath = join(plansDir, filename);

	if (!existsSync(filePath)) {
		log.debug({ filePath, filename }, "Plan file not found");
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		log.debug({ filePath, filename }, "Read plan file");
		return content;
	} catch (error) {
		log.warn({ filePath, filename, error }, "Failed to read plan file");
		return null;
	}
}

/**
 * Checks if a plan file exists in the current plans directory.
 *
 * @param workDir - Working directory
 * @param filename - Name of the file to check
 * @returns true if file exists
 */
export function planFileExists(workDir: string, filename: string): boolean {
	const plansDir = getCurrentPlansDir(workDir);
	const filePath = join(plansDir, filename);
	return existsSync(filePath);
}

/**
 * Lists all files in the current plans directory.
 *
 * @param workDir - Working directory
 * @returns Array of filenames
 */
export function listPlanFiles(workDir: string): string[] {
	const plansDir = getCurrentPlansDir(workDir);
	if (!existsSync(plansDir)) {
		return [];
	}

	try {
		return readdirSync(plansDir).filter((file) => {
			const filePath = join(plansDir, file);
			return existsSync(filePath) && !lstatSync(filePath).isDirectory();
		});
	} catch {
		return [];
	}
}

// ============================================================================
// SPECIFIC PLAN FILE OPERATIONS
// ============================================================================

/**
 * Writes an issue WBS plan markdown file.
 *
 * @param workDir - Working directory
 * @param issueId - Issue identifier
 * @param markdown - Markdown content
 * @returns Full path to the written file
 */
export function writeIssueWbsPlan(workDir: string, issueId: string, markdown: string): string {
	const filename = `plan_${issueId}.md`;
	return writePlanFile(workDir, filename, markdown);
}

/**
 * Reads an issue WBS plan markdown file.
 *
 * @param workDir - Working directory
 * @param issueId - Issue identifier
 * @returns Markdown content or null if not found
 */
export function readIssueWbsPlan(workDir: string, issueId: string): string | null {
	const filename = `plan_${issueId}.md`;
	return readPlanFile(workDir, filename);
}

/**
 * Writes an issue WBS JSON file.
 *
 * @param workDir - Working directory
 * @param issueId - Issue identifier
 * @param json - JSON object to write
 * @returns Full path to the written file
 */
export function writeIssueWbsJson(workDir: string, issueId: string, json: object): string {
	const filename = `wbs_${issueId}.json`;
	const content = JSON.stringify(json, null, 2);
	return writePlanFile(workDir, filename, content);
}

/**
 * Reads an issue WBS JSON file.
 *
 * @param workDir - Working directory
 * @param issueId - Issue identifier
 * @returns Parsed JSON object or null if not found
 */
export function readIssueWbsJson(workDir: string, issueId: string): object | null {
	const filename = `wbs_${issueId}.json`;
	const content = readPlanFile(workDir, filename);
	if (!content) {
		return null;
	}

	try {
		return JSON.parse(content);
	} catch (error) {
		log.warn({ filename, error }, "Failed to parse WBS JSON");
		return null;
	}
}

/**
 * Writes the problem brief markdown file.
 *
 * @param workDir - Working directory
 * @param markdown - Markdown content
 * @returns Full path to the written file
 */
export function writeProblemBrief(workDir: string, markdown: string): string {
	return writePlanFile(workDir, "problem_brief.md", markdown);
}

/**
 * Reads the problem brief markdown file.
 *
 * @param workDir - Working directory
 * @returns Markdown content or null if not found
 */
export function readProblemBrief(workDir: string): string | null {
	return readPlanFile(workDir, "problem_brief.md");
}

/**
 * Writes the execution plan markdown file.
 *
 * @param workDir - Working directory
 * @param markdown - Markdown content
 * @returns Full path to the written file
 */
export function writeExecutionPlan(workDir: string, markdown: string): string {
	return writePlanFile(workDir, "execution_plan.md", markdown);
}

/**
 * Reads the execution plan markdown file.
 *
 * @param workDir - Working directory
 * @returns Markdown content or null if not found
 */
export function readExecutionPlan(workDir: string): string | null {
	return readPlanFile(workDir, "execution_plan.md");
}

// ============================================================================
// VIEW SYNCHRONIZATION
// ============================================================================

/**
 * Check if symlinks are supported on the current platform.
 *
 * @param workDir - Working directory to test in
 * @returns true if symlinks are supported
 */
function isSymlinkSupported(workDir: string): boolean {
	const testDir = join(workDir, MILHOUSE_DIR);
	const testLink = join(testDir, ".symlink-test");
	const testTarget = join(testDir, ".symlink-test-target");

	try {
		// Ensure test directory exists
		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		// Create a test target directory
		if (!existsSync(testTarget)) {
			mkdirSync(testTarget, { recursive: true });
		}

		// Try to create a symlink
		if (existsSync(testLink)) {
			unlinkSync(testLink);
		}
		symlinkSync(testTarget, testLink, "dir");

		// Cleanup
		unlinkSync(testLink);
		rmSync(testTarget, { recursive: true, force: true });

		return true;
	} catch {
		// Cleanup on failure
		try {
			if (existsSync(testLink)) {
				unlinkSync(testLink);
			}
			if (existsSync(testTarget)) {
				rmSync(testTarget, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup errors
		}
		return false;
	}
}

/**
 * Syncs .milhouse/plans to reflect current run's plans.
 *
 * - On Unix/macOS: creates symlink to runs/<runId>/plans
 * - On Windows/no symlink support: copies files
 *
 * This function is idempotent and safe (uses tmp dir + rename for atomic copy).
 *
 * @param workDir - Working directory (defaults to process.cwd())
 */
export function syncLegacyPlansView(workDir = process.cwd()): void {
	const currentRunId = getCurrentRunId(workDir);

	// If no active run, nothing to sync
	if (!currentRunId) {
		log.debug("No active run, skipping legacy plans view sync");
		return;
	}

	const runPlansDir = join(getRunDir(currentRunId, workDir), "plans");
	const legacyPlansDir = getLegacyPlansDir(workDir);

	// Ensure run plans directory exists
	if (!existsSync(runPlansDir)) {
		mkdirSync(runPlansDir, { recursive: true });
	}

	log.debug({ runId: currentRunId, runPlansDir, legacyPlansDir }, "Syncing legacy plans view");

	// Check if symlinks are supported
	const symlinkSupported = isSymlinkSupported(workDir);

	if (symlinkSupported) {
		syncWithSymlink(runPlansDir, legacyPlansDir, workDir);
	} else {
		syncWithCopy(runPlansDir, legacyPlansDir, workDir);
	}
}

/**
 * Sync legacy plans view using symlink strategy.
 *
 * @param runPlansDir - Source directory (run's plans)
 * @param legacyPlansDir - Target directory (legacy plans view)
 * @param workDir - Working directory for relative path calculation
 */
function syncWithSymlink(runPlansDir: string, legacyPlansDir: string, workDir: string): void {
	// Calculate relative path from legacy plans dir to run plans dir
	const legacyParent = join(legacyPlansDir, "..");
	const relativePath = relative(legacyParent, runPlansDir);

	// Check current state of legacy plans dir
	if (existsSync(legacyPlansDir)) {
		try {
			const stats = lstatSync(legacyPlansDir);

			if (stats.isSymbolicLink()) {
				// Check if symlink points to correct target
				const currentTarget = readlinkSync(legacyPlansDir);
				if (currentTarget === relativePath || currentTarget === runPlansDir) {
					log.debug(
						{ legacyPlansDir, target: currentTarget },
						"Symlink already points to correct target",
					);
					return;
				}

				// Symlink points to wrong target, remove it
				log.debug(
					{ legacyPlansDir, currentTarget, newTarget: relativePath },
					"Updating symlink to new target",
				);
				unlinkSync(legacyPlansDir);
			} else if (stats.isDirectory()) {
				// Regular directory exists, remove it
				log.debug({ legacyPlansDir }, "Removing existing directory to create symlink");
				rmSync(legacyPlansDir, { recursive: true, force: true });
			} else {
				// Some other file type, remove it
				unlinkSync(legacyPlansDir);
			}
		} catch (error) {
			log.warn(
				{ legacyPlansDir, error },
				"Error checking legacy plans dir state, attempting to recreate",
			);
			try {
				rmSync(legacyPlansDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}
	}

	// Ensure parent directory exists
	const parentDir = join(legacyPlansDir, "..");
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true });
	}

	// Create symlink
	try {
		symlinkSync(relativePath, legacyPlansDir, "dir");
		log.info({ legacyPlansDir, target: relativePath }, "Created symlink for legacy plans view");
	} catch (error) {
		log.warn(
			{ legacyPlansDir, target: relativePath, error },
			"Failed to create symlink, falling back to copy",
		);
		syncWithCopy(runPlansDir, legacyPlansDir, workDir);
	}
}

/**
 * Sync legacy plans view using atomic copy strategy.
 *
 * Uses tmp directory + rename for atomic operation.
 *
 * @param runPlansDir - Source directory (run's plans)
 * @param legacyPlansDir - Target directory (legacy plans view)
 * @param _workDir - Working directory (unused but kept for consistency)
 */
function syncWithCopy(runPlansDir: string, legacyPlansDir: string, _workDir: string): void {
	// Create temporary directory for atomic copy
	const tmpDir = `${legacyPlansDir}.tmp.${Date.now()}`;

	try {
		// Create tmp directory
		mkdirSync(tmpDir, { recursive: true });

		// Copy all files from run plans to tmp
		if (existsSync(runPlansDir)) {
			const files = readdirSync(runPlansDir);
			for (const file of files) {
				const srcPath = join(runPlansDir, file);
				const dstPath = join(tmpDir, file);

				// Only copy files, not directories
				if (!lstatSync(srcPath).isDirectory()) {
					copyFileSync(srcPath, dstPath);
				}
			}
		}

		// Atomic swap: remove old, rename tmp to target
		if (existsSync(legacyPlansDir)) {
			// Check if it's a symlink first
			try {
				const stats = lstatSync(legacyPlansDir);
				if (stats.isSymbolicLink()) {
					unlinkSync(legacyPlansDir);
				} else {
					rmSync(legacyPlansDir, { recursive: true, force: true });
				}
			} catch {
				rmSync(legacyPlansDir, { recursive: true, force: true });
			}
		}

		// Rename tmp to target
		renameSync(tmpDir, legacyPlansDir);

		log.info({ legacyPlansDir, source: runPlansDir }, "Copied plans to legacy view (atomic)");
	} catch (error) {
		// Cleanup tmp on failure
		try {
			if (existsSync(tmpDir)) {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup errors
		}

		throw new StateWriteError("Failed to sync legacy plans view", {
			filePath: legacyPlansDir,
			cause: error instanceof Error ? error : new Error(String(error)),
		});
	}
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if there are plans in the current plans directory.
 *
 * @param workDir - Working directory
 * @returns true if plans exist
 */
export function hasPlans(workDir: string): boolean {
	const files = listPlanFiles(workDir);
	return files.length > 0;
}

/**
 * Check if there are legacy plans that could be imported.
 *
 * @param workDir - Working directory
 * @returns true if legacy plans exist and current run has no plans
 */
export function hasLegacyPlansToImport(workDir: string): boolean {
	const currentRunId = getCurrentRunId(workDir);
	if (!currentRunId) {
		return false;
	}

	const runPlansDir = join(getRunDir(currentRunId, workDir), "plans");
	const legacyPlansDir = getLegacyPlansDir(workDir);

	// Check if legacy dir exists and is not a symlink
	if (!existsSync(legacyPlansDir)) {
		return false;
	}

	try {
		const stats = lstatSync(legacyPlansDir);
		if (stats.isSymbolicLink()) {
			return false;
		}
	} catch {
		return false;
	}

	// Check if legacy has files
	const legacyFiles = readdirSync(legacyPlansDir).filter((f) => {
		const p = join(legacyPlansDir, f);
		return existsSync(p) && !lstatSync(p).isDirectory();
	});

	if (legacyFiles.length === 0) {
		return false;
	}

	// Check if run plans dir is empty or doesn't exist
	if (!existsSync(runPlansDir)) {
		return true;
	}

	const runFiles = readdirSync(runPlansDir).filter((f) => {
		const p = join(runPlansDir, f);
		return existsSync(p) && !lstatSync(p).isDirectory();
	});

	return runFiles.length === 0;
}

/**
 * Import legacy plans into the current run.
 *
 * @param workDir - Working directory
 * @returns Number of files imported
 */
export function importLegacyPlans(workDir: string): number {
	const currentRunId = getCurrentRunId(workDir);
	if (!currentRunId) {
		log.warn("No active run, cannot import legacy plans");
		return 0;
	}

	const runPlansDir = join(getRunDir(currentRunId, workDir), "plans");
	const legacyPlansDir = getLegacyPlansDir(workDir);

	if (!existsSync(legacyPlansDir)) {
		return 0;
	}

	// Check if legacy dir is a symlink (already synced)
	try {
		const stats = lstatSync(legacyPlansDir);
		if (stats.isSymbolicLink()) {
			log.debug("Legacy plans dir is already a symlink, skipping import");
			return 0;
		}
	} catch {
		return 0;
	}

	// Ensure run plans dir exists
	if (!existsSync(runPlansDir)) {
		mkdirSync(runPlansDir, { recursive: true });
	}

	// Copy files from legacy to run
	let imported = 0;
	const files = readdirSync(legacyPlansDir);

	for (const file of files) {
		const srcPath = join(legacyPlansDir, file);
		const dstPath = join(runPlansDir, file);

		try {
			const stats = lstatSync(srcPath);
			if (!stats.isDirectory()) {
				copyFileSync(srcPath, dstPath);
				imported++;
				log.debug({ file, from: srcPath, to: dstPath }, "Imported legacy plan file");
			}
		} catch (error) {
			log.warn({ file, error }, "Failed to import legacy plan file");
		}
	}

	// Create marker file
	if (imported > 0) {
		const markerPath = join(runPlansDir, ".imported-from-legacy.json");
		const marker = {
			imported_at: new Date().toISOString(),
			files_imported: imported,
			source: legacyPlansDir,
		};
		writeFileSync(markerPath, JSON.stringify(marker, null, 2));
		log.info({ imported, runId: currentRunId }, "Imported legacy plans into current run");
	}

	return imported;
}
