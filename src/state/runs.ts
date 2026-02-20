/**
 * Runs management module
 *
 * Handles all run-related operations including:
 * - Run creation and deletion
 * - Run metadata management
 * - Run state directories
 * - Concurrent-safe updates with locking
 *
 * NOTE: The global `current_run` pointer has been removed.
 * All state operations should take an explicit `runId`.
 * The "latest run" is derived from the runs index (last entry).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateEvents } from "./events.ts";
import { AsyncMutex, withFileLock } from "./file-lock.ts";
import { loadJsonFile, saveJsonFile } from "./json-io.ts";
import {
	RUNS_FILES,
	type RunMeta,
	RunMetaSchema,
	type RunPhase,
	type RunsIndex,
	RunsIndexSchema,
	STATE_FILES,
} from "./types.ts";

import { MILHOUSE_DIR, getMilhouseDir } from "./paths.ts";

// ============================================================================
// RUNS DIRECTORY FUNCTIONS
// ============================================================================

/**
 * Get path to runs directory
 */
export function getRunsDir(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), RUNS_FILES.runsDir);
}

/**
 * Get path to runs index file
 */
export function getRunsIndexPath(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), RUNS_FILES.index);
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
 * Get path to a run's meta.json
 */
export function getRunMetaPath(runId: string, workDir = process.cwd()): string {
	return join(getRunDir(runId, workDir), RUNS_FILES.meta);
}

// ============================================================================
// RUNS INDEX FUNCTIONS
// ============================================================================

/**
 * Load runs index
 */
export function loadRunsIndex(workDir = process.cwd()): RunsIndex {
	const path = getRunsIndexPath(workDir);
	if (!existsSync(path)) {
		return { runs: [] };
	}
	return loadJsonFile(path, RunsIndexSchema, { runs: [] });
}

/**
 * Save runs index.
 * Strips any legacy `current_run` field before writing.
 */
export function saveRunsIndex(index: RunsIndex, workDir = process.cwd()): void {
	const path = getRunsIndexPath(workDir);
	// Strip current_run if present (legacy compat via passthrough)
	const { current_run: _stripped, ...clean } = index as RunsIndex & { current_run?: unknown };
	saveJsonFile(path, clean);
}

// ============================================================================
// RUN METADATA FUNCTIONS
// ============================================================================

/**
 * Load run metadata
 */
export function loadRunMeta(runId: string, workDir = process.cwd()): RunMeta | null {
	const path = getRunMetaPath(runId, workDir);
	if (!existsSync(path)) {
		return null;
	}
	return loadJsonFile(path, RunMetaSchema, null as unknown as RunMeta);
}

/**
 * Save run metadata
 */
export function saveRunMeta(meta: RunMeta, workDir = process.cwd()): void {
	const runDir = getRunDir(meta.id, workDir);
	if (!existsSync(runDir)) {
		mkdirSync(runDir, { recursive: true });
	}
	const path = getRunMetaPath(meta.id, workDir);
	saveJsonFile(path, meta);
}

// ============================================================================
// LATEST RUN FUNCTIONS (replaces current_run pointer)
// ============================================================================

/**
 * Get the latest run ID from the runs index.
 * Returns the most recently added run, or null if no runs exist.
 *
 * NOTE: This replaces the old current_run pointer. Instead of a mutable
 * global pointer, we derive the "current" run from the runs list order.
 */
export function getCurrentRunId(workDir = process.cwd()): string | null {
	const index = loadRunsIndex(workDir);
	if (index.runs.length === 0) return null;
	return index.runs[index.runs.length - 1].id;
}

/**
 * Get the latest run metadata.
 * Returns metadata for the most recently added run, or null if none.
 */
export function getCurrentRun(workDir = process.cwd()): RunMeta | null {
	const runId = getCurrentRunId(workDir);
	if (!runId) {
		return null;
	}
	return loadRunMeta(runId, workDir);
}

/**
 * Set the "current" run by moving it to the end of the runs list.
 * This replaces the old current_run pointer approach.
 */
export function setCurrentRun(runId: string, workDir = process.cwd()): boolean {
	const index = loadRunsIndex(workDir);

	// Verify run exists
	const runEntry = index.runs.find((r) => r.id === runId);
	if (!runEntry) {
		return false;
	}

	// Move the target run to the end of the list (making it "current")
	const filtered = index.runs.filter((r) => r.id !== runId);
	filtered.push(runEntry);
	saveRunsIndex({ ...index, runs: filtered }, workDir);
	return true;
}

// ============================================================================
// RUN ID GENERATION
// ============================================================================

/**
 * Generate a run ID with optional name hint
 */
export function generateRunId(nameHint?: string): string {
	const date = new Date();
	const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
	const random = Math.random().toString(36).substring(2, 6);

	if (nameHint) {
		// Sanitize name hint
		const sanitized = nameHint
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 20);
		return `run-${dateStr}-${sanitized}-${random}`;
	}

	return `run-${dateStr}-${random}`;
}

// ============================================================================
// RUN CRUD OPERATIONS
// ============================================================================

/**
 * Create a new run
 */
export function createRun(options: {
	scope?: string;
	name?: string;
	workDir?: string;
}): RunMeta {
	const workDir = options.workDir ?? process.cwd();
	const now = new Date().toISOString();

	// Generate run ID with name hint from scope
	const nameHint = options.name || options.scope?.split(/\s+/)[0];
	const runId = generateRunId(nameHint);

	// Create run metadata
	const meta: RunMeta = {
		id: runId,
		name: options.name,
		scope: options.scope,
		created_at: now,
		updated_at: now,
		phase: "scan",
		issues_found: 0,
		issues_validated: 0,
		tasks_total: 0,
		tasks_completed: 0,
		tasks_failed: 0,
	};

	// Create run directory structure
	const runDir = getRunDir(runId, workDir);
	const stateDir = getRunStateDir(runId, workDir);
	const plansDir = join(runDir, "plans");
	const probesDir = join(runDir, "probes");

	mkdirSync(stateDir, { recursive: true });
	mkdirSync(plansDir, { recursive: true });
	mkdirSync(probesDir, { recursive: true });

	// Save run metadata
	saveRunMeta(meta, workDir);

	// Update runs index — new run is appended at the end (making it "latest")
	const index = loadRunsIndex(workDir);
	index.runs.push({
		id: runId,
		name: options.name,
		scope: options.scope,
		created_at: now,
		phase: "scan",
	});
	saveRunsIndex(index, workDir);

	// Emit run:created event
	stateEvents.emitRunCreated(runId, options.scope, options.name);

	return meta;
}

/**
 * Delete a run
 */
export function deleteRun(runId: string, workDir = process.cwd()): boolean {
	const index = loadRunsIndex(workDir);

	// Check if run exists
	const runIndex = index.runs.findIndex((r) => r.id === runId);
	if (runIndex === -1) {
		return false;
	}

	// Remove from index
	index.runs.splice(runIndex, 1);

	saveRunsIndex(index, workDir);

	// Delete run directory
	const runDir = getRunDir(runId, workDir);
	if (existsSync(runDir)) {
		rmSync(runDir, { recursive: true, force: true });
	}

	return true;
}

/**
 * List all runs.
 * The last run in the list is considered "latest" (replaces is_current).
 */
export function listRuns(workDir = process.cwd()): Array<{
	id: string;
	name?: string;
	scope?: string;
	created_at: string;
	phase: RunPhase;
	is_current: boolean;
}> {
	const index = loadRunsIndex(workDir);
	const latestRunId = index.runs.length > 0 ? index.runs[index.runs.length - 1].id : null;

	return index.runs.map((run) => ({
		...run,
		is_current: run.id === latestRunId,
	}));
}

// ============================================================================
// RUN UPDATE FUNCTIONS
// ============================================================================

/**
 * Update run phase
 */
export function updateRunPhaseInMeta(
	runId: string,
	phase: RunPhase,
	workDir = process.cwd(),
): RunMeta | null {
	const meta = loadRunMeta(runId, workDir);
	if (!meta) {
		return null;
	}

	const previousPhase = meta.phase;
	const updated = { ...meta, phase, updated_at: new Date().toISOString() };
	saveRunMeta(updated, workDir);

	// Also update in index
	const index = loadRunsIndex(workDir);
	const runEntryIndex = index.runs.findIndex((r) => r.id === runId);
	if (runEntryIndex !== -1) {
		const updatedRuns = [...index.runs];
		updatedRuns[runEntryIndex] = { ...updatedRuns[runEntryIndex], phase };
		saveRunsIndex({ ...index, runs: updatedRuns }, workDir);
	}

	// Emit run:phase:changed event
	stateEvents.emitRunPhaseChanged(runId, phase, previousPhase);

	return updated;
}

/**
 * Update run statistics
 */
export function updateRunStats(
	runId: string,
	stats: Partial<
		Pick<
			RunMeta,
			"issues_found" | "issues_validated" | "tasks_total" | "tasks_completed" | "tasks_failed"
		>
	>,
	workDir = process.cwd(),
): RunMeta | null {
	const meta = loadRunMeta(runId, workDir);
	if (!meta) {
		return null;
	}

	const updated = { ...meta, ...stats, updated_at: new Date().toISOString() };
	saveRunMeta(updated, workDir);
	return updated;
}

// ============================================================================
// CONCURRENT-SAFE UPDATE WITH SIMPLE QUEUE LOCKING
// ============================================================================

/** In-process mutex for run meta updates */
const runMetaMutex = new AsyncMutex();

/** In-process mutex for runs index updates */
const runsIndexMutex = new AsyncMutex();

/**
 * Update run metadata with both in-memory and file-level locking.
 * In-memory mutex serializes within this process (p-limit concurrent calls).
 * File lock ensures cross-process safety (e.g., two terminals).
 */
export async function updateRunMetaWithLock(
	runId: string,
	update: Partial<Omit<RunMeta, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<RunMeta | null> {
	return runMetaMutex.run(async () => {
		const metaPath = getRunMetaPath(runId, workDir);
		return withFileLock(metaPath, () => {
			const meta = loadRunMeta(runId, workDir);
			if (!meta) return null;

			const updated = { ...meta, ...update, updated_at: new Date().toISOString() };
			saveRunMeta(updated, workDir);
			return updated;
		});
	});
}

/**
 * Update run phase with both in-memory and file-level locking.
 */
export async function updateRunPhaseInMetaWithLock(
	runId: string,
	phase: RunPhase,
	workDir = process.cwd(),
): Promise<RunMeta | null> {
	return runMetaMutex.run(async () => {
		const metaPath = getRunMetaPath(runId, workDir);
		return withFileLock(metaPath, async () => {
			const meta = loadRunMeta(runId, workDir);
			if (!meta) return null;

			const updated = { ...meta, phase, updated_at: new Date().toISOString() };
			saveRunMeta(updated, workDir);

			// Also update in index
			await saveRunsIndexWithLock((index) => {
				const idx = index.runs.findIndex((r) => r.id === runId);
				if (idx !== -1) {
					const updatedRuns = [...index.runs];
					updatedRuns[idx] = { ...updatedRuns[idx], phase };
					return { ...index, runs: updatedRuns };
				}
				return index;
			}, workDir);

			return updated;
		});
	});
}

/**
 * Update run statistics with locking.
 */
export async function updateRunStatsWithLock(
	runId: string,
	stats: Partial<
		Pick<
			RunMeta,
			"issues_found" | "issues_validated" | "tasks_total" | "tasks_completed" | "tasks_failed"
		>
	>,
	workDir = process.cwd(),
): Promise<RunMeta | null> {
	return updateRunMetaWithLock(runId, stats, workDir);
}

/**
 * Save runs index with locking.
 * Accepts an updater function that receives current index and returns updated index.
 */
export async function saveRunsIndexWithLock(
	updater: (index: RunsIndex) => RunsIndex,
	workDir = process.cwd(),
): Promise<void> {
	return runsIndexMutex.run(async () => {
		const indexPath = getRunsIndexPath(workDir);
		return withFileLock(indexPath, () => {
			const index = loadRunsIndex(workDir);
			const updated = updater(index);
			saveRunsIndex(updated, workDir);
		});
	});
}

// ============================================================================
// RUN STATE PATH HELPERS
// ============================================================================

/**
 * Check if runs are being used (vs legacy flat structure)
 */
export function hasRuns(workDir = process.cwd()): boolean {
	const index = loadRunsIndex(workDir);
	return index.runs.length > 0;
}

/**
 * Get state file path - supports both runs and legacy mode
 * If runs exist, uses the latest run's state directory
 * Otherwise, falls back to legacy .milhouse/state/ directory
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

	// Legacy fallback
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

	// Legacy fallback
	return join(getMilhouseDir(workDir), "plans");
}

// ============================================================================
// CLEANUP OLD RUNS
// ============================================================================

/**
 * Options for cleaning up old runs
 */
export interface CleanupOldRunsOptions {
	/** Delete runs older than this date */
	olderThan?: Date;
	/** Keep at least this many runs (most recent) */
	keepLast?: number;
	/** Working directory */
	workDir?: string;
	/** Dry run - don't actually delete, just return what would be deleted */
	dryRun?: boolean;
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
	/** Runs that were (or would be) deleted */
	deleted: Array<{ id: string; created_at: string; reason: string }>;
	/** Runs that were kept */
	kept: Array<{ id: string; created_at: string; reason: string }>;
	/** Total space freed in bytes (if available) */
	freedBytes?: number;
}

/**
 * Clean up old runs based on age and/or count
 *
 * @param options - Cleanup options
 * @returns Cleanup result with deleted and kept runs
 *
 * @example
 * // Delete runs older than 30 days, keeping at least 5
 * cleanupOldRuns({
 *   olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
 *   keepLast: 5,
 * });
 *
 * @example
 * // Dry run to see what would be deleted
 * const result = cleanupOldRuns({ keepLast: 3, dryRun: true });
 * console.log('Would delete:', result.deleted);
 */
export function cleanupOldRuns(options: CleanupOldRunsOptions = {}): CleanupResult {
	const workDir = options.workDir ?? process.cwd();

	const result: CleanupResult = {
		deleted: [],
		kept: [],
	};

	// Load runs index
	const index = loadRunsIndex(workDir);
	if (index.runs.length === 0) {
		return result;
	}

	// Sort runs by creation date (newest first)
	const sortedRuns = [...index.runs].sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
	);

	// Determine which runs to keep
	const runsToDelete: typeof sortedRuns = [];
	const runsToKeep: typeof sortedRuns = [];

	for (let i = 0; i < sortedRuns.length; i++) {
		const run = sortedRuns[i];
		const runDate = new Date(run.created_at);
		let shouldDelete = false;
		let reason = "";

		// Check keepLast constraint
		if (options.keepLast !== undefined) {
			// Count how many runs we're keeping so far
			const keptCount = runsToKeep.length;
			if (keptCount < options.keepLast) {
				runsToKeep.push(run);
				result.kept.push({
					id: run.id,
					created_at: run.created_at,
					reason: `within keepLast (${keptCount + 1}/${options.keepLast})`,
				});
				continue;
			}
		}

		// Check olderThan constraint
		if (options.olderThan !== undefined) {
			if (runDate < options.olderThan) {
				shouldDelete = true;
				reason = `older than ${options.olderThan.toISOString()}`;
			}
		}

		// If keepLast is set and we've already kept enough, delete the rest
		if (options.keepLast !== undefined && runsToKeep.length >= options.keepLast) {
			shouldDelete = true;
			reason = reason || `exceeds keepLast (${options.keepLast})`;
		}

		if (shouldDelete) {
			runsToDelete.push(run);
			result.deleted.push({ id: run.id, created_at: run.created_at, reason });
		} else {
			runsToKeep.push(run);
			result.kept.push({
				id: run.id,
				created_at: run.created_at,
				reason: "no cleanup criteria matched",
			});
		}
	}

	// If not a dry run, actually delete the runs
	if (!options.dryRun) {
		for (const run of runsToDelete) {
			deleteRun(run.id, workDir);
		}
	}

	return result;
}

/**
 * Parse a duration string like "30d", "2w", "6h" into milliseconds
 *
 * Supported units:
 * - d: days
 * - w: weeks
 * - h: hours
 * - m: minutes
 *
 * @param duration - Duration string (e.g., "30d", "2w")
 * @returns Duration in milliseconds
 */
export function parseDuration(duration: string): number {
	const match = duration.match(/^(\d+)([dwhmDWHM])$/);
	if (!match) {
		throw new Error(
			`Invalid duration format: ${duration}. Use format like "30d", "2w", "6h", "30m"`,
		);
	}

	const value = Number.parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		m: 60 * 1000, // minutes
		h: 60 * 60 * 1000, // hours
		d: 24 * 60 * 60 * 1000, // days
		w: 7 * 24 * 60 * 60 * 1000, // weeks
	};

	return value * multipliers[unit];
}

/**
 * Get a Date object for "X time ago"
 *
 * @param duration - Duration string (e.g., "30d" for 30 days ago)
 * @returns Date object
 */
export function getDateFromDuration(duration: string): Date {
	const ms = parseDuration(duration);
	return new Date(Date.now() - ms);
}
