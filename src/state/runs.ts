/**
 * Runs management module
 *
 * Handles all run-related operations including:
 * - Run creation and deletion
 * - Run metadata management
 * - Current run tracking
 * - Run state directories
 * - Concurrent-safe updates with locking
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logStateError, StateParseError } from "./errors.ts";
import { stateEvents } from "./events.ts";
import {
	RUNS_FILES,
	type RunMeta,
	RunMetaSchema,
	type RunPhase,
	type RunsIndex,
	RunsIndexSchema,
	STATE_FILES,
} from "./types.ts";

// ============================================================================
// INTERNAL UTILITIES (shared with manager.ts)
// ============================================================================

const MILHOUSE_DIR = ".milhouse";

/**
 * Get the full path to the milhouse directory
 */
function getMilhouseDir(workDir = process.cwd()): string {
	return join(workDir, MILHOUSE_DIR);
}

/**
 * Load JSON file with schema validation
 */
function loadJsonFile<T>(
	filePath: string,
	schema: { parse: (data: unknown) => T },
	defaultValue: T,
): T {
	if (!existsSync(filePath)) {
		return defaultValue;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		return schema.parse(parsed);
	} catch (error) {
		// Log the error with context instead of silently swallowing
		const stateError = new StateParseError(
			`Failed to load or parse state file: ${filePath}`,
			{
				filePath,
				cause: error instanceof Error ? error : new Error(String(error)),
			},
		);
		logStateError(stateError, "debug");
		return defaultValue;
	}
}

/**
 * Save JSON file
 */
function saveJsonFile(filePath: string, data: unknown): void {
	const dir = join(filePath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(filePath, JSON.stringify(data, null, 2));
}

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
		return { current_run: null, runs: [] };
	}
	return loadJsonFile(path, RunsIndexSchema, { current_run: null, runs: [] });
}

/**
 * Save runs index
 */
export function saveRunsIndex(index: RunsIndex, workDir = process.cwd()): void {
	const path = getRunsIndexPath(workDir);
	saveJsonFile(path, index);
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
// CURRENT RUN FUNCTIONS
// ============================================================================

/**
 * Get current active run ID
 */
export function getCurrentRunId(workDir = process.cwd()): string | null {
	const index = loadRunsIndex(workDir);
	return index.current_run;
}

/**
 * Get current active run metadata
 */
export function getCurrentRun(workDir = process.cwd()): RunMeta | null {
	const runId = getCurrentRunId(workDir);
	if (!runId) {
		return null;
	}
	return loadRunMeta(runId, workDir);
}

/**
 * Set current active run
 */
export function setCurrentRun(runId: string, workDir = process.cwd()): boolean {
	const index = loadRunsIndex(workDir);

	// Verify run exists
	if (!index.runs.find((r) => r.id === runId)) {
		return false;
	}

	saveRunsIndex({ ...index, current_run: runId }, workDir);
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

	// Update runs index
	const index = loadRunsIndex(workDir);
	index.runs.push({
		id: runId,
		name: options.name,
		scope: options.scope,
		created_at: now,
		phase: "scan",
	});
	index.current_run = runId;
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

	// If this was current run, set to null or last run
	if (index.current_run === runId) {
		index.current_run = index.runs.length > 0 ? index.runs[index.runs.length - 1].id : null;
	}

	saveRunsIndex(index, workDir);

	// Delete run directory
	const runDir = getRunDir(runId, workDir);
	if (existsSync(runDir)) {
		rmSync(runDir, { recursive: true, force: true });
	}

	return true;
}

/**
 * List all runs
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

	return index.runs.map((run) => ({
		...run,
		is_current: run.id === index.current_run,
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

/**
 * Simple queue-based lock for concurrent run meta updates
 * Used when multiple agents may update run state around the same time
 */
let runMetaLockPromise: Promise<void> | null = null;

/**
 * Simple queue-based lock for concurrent runs index updates
 */
let runsIndexLockPromise: Promise<void> | null = null;

/**
 * Update run metadata with simple locking
 * This ensures atomic read-modify-write even when called concurrently
 *
 * Note: This uses in-memory queue locking which is safe for single-process
 * concurrent operations (like p-limit based parallel execution)
 */
export async function updateRunMetaWithLock(
	runId: string,
	update: Partial<Omit<RunMeta, "id" | "created_at">>,
	workDir = process.cwd(),
): Promise<RunMeta | null> {
	// Queue this update behind any pending updates
	const waitForLock = async (): Promise<void> => {
		while (runMetaLockPromise) {
			await runMetaLockPromise;
		}
	};

	await waitForLock();

	// Acquire lock
	let releaseLock!: () => void;
	runMetaLockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});

	try {
		const meta = loadRunMeta(runId, workDir);
		if (!meta) {
			return null;
		}

		const updated = { ...meta, ...update, updated_at: new Date().toISOString() };
		saveRunMeta(updated, workDir);
		return updated;
	} finally {
		// Release lock
		runMetaLockPromise = null;
		releaseLock?.();
	}
}

/**
 * Update run phase with locking
 * This is the concurrent-safe version of updateRunPhaseInMeta()
 */
export async function updateRunPhaseInMetaWithLock(
	runId: string,
	phase: RunPhase,
	workDir = process.cwd(),
): Promise<RunMeta | null> {
	// Queue this update behind any pending updates
	const waitForLock = async (): Promise<void> => {
		while (runMetaLockPromise) {
			await runMetaLockPromise;
		}
	};

	await waitForLock();

	// Acquire lock
	let releaseLock!: () => void;
	runMetaLockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});

	try {
		const meta = loadRunMeta(runId, workDir);
		if (!meta) {
			return null;
		}

		const updated = { ...meta, phase, updated_at: new Date().toISOString() };
		saveRunMeta(updated, workDir);

		// Also update in index (with its own lock)
		await saveRunsIndexWithLock((index) => {
			const runEntryIndex = index.runs.findIndex((r) => r.id === runId);
			if (runEntryIndex !== -1) {
				const updatedRuns = [...index.runs];
				updatedRuns[runEntryIndex] = { ...updatedRuns[runEntryIndex], phase };
				return { ...index, runs: updatedRuns };
			}
			return index;
		}, workDir);

		return updated;
	} finally {
		// Release lock
		runMetaLockPromise = null;
		releaseLock?.();
	}
}

/**
 * Update run statistics with locking
 * This is the concurrent-safe version of updateRunStats()
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
 * Save runs index with locking
 * Accepts an updater function that receives current index and returns updated index
 */
export async function saveRunsIndexWithLock(
	updater: (index: RunsIndex) => RunsIndex,
	workDir = process.cwd(),
): Promise<void> {
	// Queue this update behind any pending updates
	const waitForLock = async (): Promise<void> => {
		while (runsIndexLockPromise) {
			await runsIndexLockPromise;
		}
	};

	await waitForLock();

	// Acquire lock
	let releaseLock!: () => void;
	runsIndexLockPromise = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});

	try {
		const index = loadRunsIndex(workDir);
		const updated = updater(index);
		saveRunsIndex(updated, workDir);
	} finally {
		// Release lock
		runsIndexLockPromise = null;
		releaseLock?.();
	}
}

// ============================================================================
// CURRENT RUN CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Get current active run or throw error if none exists
 * Use this in commands that require an active run
 */
export function requireActiveRun(workDir = process.cwd()): RunMeta {
	const run = getCurrentRun(workDir);
	if (!run) {
		throw new Error(
			'No active run found. Start with: milhouse scan --scope "your scope"'
		);
	}
	return run;
}

/**
 * Update current run's phase
 * This is the primary way to update run phase in all commands
 */
export function updateCurrentRunPhase(
	phase: RunPhase,
	workDir = process.cwd(),
): RunMeta {
	const run = requireActiveRun(workDir);
	const updated = updateRunPhaseInMeta(run.id, phase, workDir);
	if (!updated) {
		throw new Error(`Failed to update run ${run.id} phase to ${phase}`);
	}
	return updated;
}

/**
 * Update current run's statistics
 */
export function updateCurrentRunStats(
	stats: Partial<Pick<RunMeta,
		| "issues_found"
		| "issues_validated"
		| "tasks_total"
		| "tasks_completed"
		| "tasks_failed"
	>>,
	workDir = process.cwd(),
): RunMeta {
	const run = requireActiveRun(workDir);
	const updated = updateRunStats(run.id, stats, workDir);
	if (!updated) {
		throw new Error(`Failed to update run ${run.id} stats`);
	}
	return updated;
}

/**
 * Get current run phase (for display purposes)
 */
export function getCurrentRunPhase(workDir = process.cwd()): RunPhase | null {
	const run = getCurrentRun(workDir);
	return run?.phase ?? null;
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
 * Get state file path - now supports both runs and legacy mode
 * If runs exist, uses current run's state directory
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

/**
 * Get probes directory for current run
 */
export function getProbesPathForCurrentRun(probeType: string, workDir = process.cwd()): string {
	const currentRunId = getCurrentRunId(workDir);

	if (currentRunId) {
		return join(getRunDir(currentRunId, workDir), "probes", probeType);
	}

	// Legacy fallback
	return join(getMilhouseDir(workDir), "probes", probeType);
}

// ============================================================================
// ENSURE ACTIVE RUN
// ============================================================================

/**
 * Ensure a run exists and is active
 * If no runs exist, creates one with given scope
 * If runs exist but none active, returns error message
 */
export function ensureActiveRun(
	options: {
		scope?: string;
		createIfMissing?: boolean;
		workDir?: string;
	} = {},
): { run: RunMeta | null; error?: string } {
	const workDir = options.workDir ?? process.cwd();

	const currentRun = getCurrentRun(workDir);
	if (currentRun) {
		return { run: currentRun };
	}

	const index = loadRunsIndex(workDir);

	// If runs exist but none is current
	if (index.runs.length > 0) {
		const runsList = index.runs
			.map((r) => `  • ${r.id}${r.scope ? ` (${r.scope})` : ""}`)
			.join("\n");

		return {
			run: null,
			error: `No active run selected.\n\nAvailable runs:\n${runsList}\n\nTo continue: milhouse runs switch <run-id>`,
		};
	}

	// No runs at all
	if (options.createIfMissing && options.scope) {
		const run = createRun({ scope: options.scope, workDir });
		return { run };
	}

	return {
		run: null,
		error: `No runs found. Start by scanning:\n  milhouse --scan --scope "your investigation scope"`,
	};
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
	/** Exclude the current run from cleanup */
	excludeCurrent?: boolean;
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
	const excludeCurrent = options.excludeCurrent ?? true;

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
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
	);

	// Determine which runs to keep
	const runsToDelete: typeof sortedRuns = [];
	const runsToKeep: typeof sortedRuns = [];

	for (let i = 0; i < sortedRuns.length; i++) {
		const run = sortedRuns[i];
		const runDate = new Date(run.created_at);
		let shouldDelete = false;
		let reason = "";

		// Check if this is the current run
		if (excludeCurrent && run.id === index.current_run) {
			runsToKeep.push(run);
			result.kept.push({ id: run.id, created_at: run.created_at, reason: "current run" });
			continue;
		}

		// Check keepLast constraint
		if (options.keepLast !== undefined) {
			// Count how many runs we're keeping so far
			const keptCount = runsToKeep.length;
			if (keptCount < options.keepLast) {
				runsToKeep.push(run);
				result.kept.push({ id: run.id, created_at: run.created_at, reason: `within keepLast (${keptCount + 1}/${options.keepLast})` });
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
			result.kept.push({ id: run.id, created_at: run.created_at, reason: "no cleanup criteria matched" });
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
		throw new Error(`Invalid duration format: ${duration}. Use format like "30d", "2w", "6h", "30m"`);
	}

	const value = parseInt(match[1], 10);
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
