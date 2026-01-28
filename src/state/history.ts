/**
 * State History Module
 *
 * Provides state versioning capabilities:
 * - Automatic snapshots before state changes
 * - Rollback to previous snapshots
 * - Configurable snapshot retention
 *
 * Directory structure:
 * .milhouse/runs/<run-id>/state/history/
 *   ├── issues/
 *   │   ├── 2024-01-15T10-30-00-000Z.json
 *   │   └── 2024-01-15T11-45-00-000Z.json
 *   ├── tasks/
 *   │   └── ...
 *   └── meta/
 *       └── ...
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logStateError, StateParseError } from "./errors.ts";
import { getRunDir, getRunStateDir } from "./runs.ts";

// ============================================================================
// TYPES AND SCHEMAS
// ============================================================================

/**
 * State types that can be versioned
 */
export type StateType = "issues" | "tasks" | "meta" | "graph" | "executions";

/**
 * Snapshot metadata
 */
export const SnapshotMetaSchema = z.object({
	/** Unique snapshot identifier (timestamp-based) */
	id: z.string(),
	/** State type (issues, tasks, etc.) */
	state_type: z.string(),
	/** ISO timestamp when snapshot was created */
	created_at: z.string(),
	/** Optional description of what triggered the snapshot */
	reason: z.string().optional(),
	/** Optional agent ID that triggered the change */
	agent_id: z.string().optional(),
	/** File size in bytes */
	size_bytes: z.number().optional(),
});

export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

/**
 * Snapshot with data
 */
export interface Snapshot<T = unknown> {
	meta: SnapshotMeta;
	data: T;
}

/**
 * History configuration
 */
export interface HistoryConfig {
	/** Maximum number of snapshots to keep per state type (default: 10) */
	maxSnapshots: number;
	/** Whether to enable history (default: true) */
	enabled: boolean;
}

/**
 * Default history configuration
 */
export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
	maxSnapshots: 10,
	enabled: true,
};

// ============================================================================
// DIRECTORY FUNCTIONS
// ============================================================================

/**
 * Get path to history directory for a run
 */
export function getHistoryDir(runId: string, workDir = process.cwd()): string {
	return join(getRunStateDir(runId, workDir), "history");
}

/**
 * Get path to history directory for a specific state type
 */
export function getStateHistoryDir(
	runId: string,
	stateType: StateType,
	workDir = process.cwd(),
): string {
	return join(getHistoryDir(runId, workDir), stateType);
}

/**
 * Ensure history directory structure exists
 */
export function ensureHistoryDir(runId: string, stateType: StateType, workDir = process.cwd()): string {
	const dir = getStateHistoryDir(runId, stateType, workDir);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

// ============================================================================
// SNAPSHOT ID GENERATION
// ============================================================================

/**
 * Generate a snapshot ID from timestamp
 * Format: YYYY-MM-DDTHH-mm-ss-SSSZ (filesystem-safe ISO format)
 */
export function generateSnapshotId(timestamp = new Date()): string {
	return timestamp.toISOString().replace(/[:.]/g, "-");
}

/**
 * Parse snapshot ID back to Date
 */
export function parseSnapshotId(snapshotId: string): Date {
	// Convert back from filesystem-safe format
	const isoString = snapshotId
		.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1-$2-$3T$4:$5:$6.$7Z");
	return new Date(isoString);
}

// ============================================================================
// SNAPSHOT OPERATIONS
// ============================================================================

/**
 * Save a state snapshot before making changes
 *
 * @param runId - Run identifier
 * @param stateType - Type of state being saved (issues, tasks, etc.)
 * @param data - Current state data to snapshot
 * @param options - Optional metadata
 * @returns Snapshot metadata
 */
export function saveStateSnapshot<T>(
	runId: string,
	stateType: StateType,
	data: T,
	options: {
		reason?: string;
		agentId?: string;
		workDir?: string;
		config?: Partial<HistoryConfig>;
	} = {},
): SnapshotMeta {
	const workDir = options.workDir ?? process.cwd();
	const config = { ...DEFAULT_HISTORY_CONFIG, ...options.config };

	// Skip if history is disabled
	if (!config.enabled) {
		const now = new Date();
		return {
			id: generateSnapshotId(now),
			state_type: stateType,
			created_at: now.toISOString(),
			reason: options.reason,
			agent_id: options.agentId,
		};
	}

	// Ensure directory exists
	const historyDir = ensureHistoryDir(runId, stateType, workDir);

	// Generate snapshot ID
	const now = new Date();
	const snapshotId = generateSnapshotId(now);
	const snapshotPath = join(historyDir, `${snapshotId}.json`);

	// Create snapshot metadata
	const content = JSON.stringify(data, null, 2);
	const meta: SnapshotMeta = {
		id: snapshotId,
		state_type: stateType,
		created_at: now.toISOString(),
		reason: options.reason,
		agent_id: options.agentId,
		size_bytes: Buffer.byteLength(content, "utf-8"),
	};

	// Save snapshot with metadata wrapper
	const snapshot: Snapshot<T> = { meta, data };
	writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

	// Enforce snapshot limit
	enforceSnapshotLimit(runId, stateType, config.maxSnapshots, workDir);

	return meta;
}

/**
 * List all snapshots for a state type
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param workDir - Working directory
 * @returns Array of snapshot metadata, sorted by creation time (newest first)
 */
export function listSnapshots(
	runId: string,
	stateType: StateType,
	workDir = process.cwd(),
): SnapshotMeta[] {
	const historyDir = getStateHistoryDir(runId, stateType, workDir);

	if (!existsSync(historyDir)) {
		return [];
	}

	const files = readdirSync(historyDir).filter((f) => f.endsWith(".json"));
	const snapshots: SnapshotMeta[] = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(historyDir, file), "utf-8");
			const parsed = JSON.parse(content) as Snapshot;
			if (parsed.meta) {
				snapshots.push(parsed.meta);
			}
		} catch (error) {
			// Log but continue - corrupted snapshot shouldn't break listing
			const stateError = new StateParseError(
				`Failed to parse snapshot: ${file}`,
				{ filePath: join(historyDir, file), cause: error instanceof Error ? error : new Error(String(error)) },
			);
			logStateError(stateError, "debug");
		}
	}

	// Sort by creation time, newest first
	return snapshots.sort((a, b) =>
		new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
	);
}

/**
 * Load a specific snapshot
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param snapshotId - Snapshot identifier
 * @param workDir - Working directory
 * @returns Snapshot data or null if not found
 */
export function loadSnapshot<T>(
	runId: string,
	stateType: StateType,
	snapshotId: string,
	workDir = process.cwd(),
): Snapshot<T> | null {
	const historyDir = getStateHistoryDir(runId, stateType, workDir);
	const snapshotPath = join(historyDir, `${snapshotId}.json`);

	if (!existsSync(snapshotPath)) {
		return null;
	}

	try {
		const content = readFileSync(snapshotPath, "utf-8");
		return JSON.parse(content) as Snapshot<T>;
	} catch (error) {
		const stateError = new StateParseError(
			`Failed to load snapshot: ${snapshotId}`,
			{ filePath: snapshotPath, cause: error instanceof Error ? error : new Error(String(error)) },
		);
		logStateError(stateError, "warn");
		return null;
	}
}

/**
 * Get the latest snapshot for a state type
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param workDir - Working directory
 * @returns Latest snapshot or null if none exist
 */
export function getLatestSnapshot<T>(
	runId: string,
	stateType: StateType,
	workDir = process.cwd(),
): Snapshot<T> | null {
	const snapshots = listSnapshots(runId, stateType, workDir);
	if (snapshots.length === 0) {
		return null;
	}

	return loadSnapshot<T>(runId, stateType, snapshots[0].id, workDir);
}

// ============================================================================
// ROLLBACK OPERATIONS
// ============================================================================

/**
 * Rollback state to a previous snapshot
 *
 * This function:
 * 1. Creates a snapshot of current state (for safety)
 * 2. Loads the target snapshot
 * 3. Writes the snapshot data to the current state file
 *
 * @param runId - Run identifier
 * @param stateType - Type of state to rollback
 * @param snapshotId - Snapshot to rollback to
 * @param options - Rollback options
 * @returns The restored data or null if rollback failed
 */
export function rollbackState<T>(
	runId: string,
	stateType: StateType,
	snapshotId: string,
	options: {
		workDir?: string;
		/** Skip creating a backup snapshot before rollback (default: false) */
		skipBackup?: boolean;
		/** Agent ID performing the rollback */
		agentId?: string;
	} = {},
): T | null {
	const workDir = options.workDir ?? process.cwd();

	// Load target snapshot
	const targetSnapshot = loadSnapshot<T>(runId, stateType, snapshotId, workDir);
	if (!targetSnapshot) {
		return null;
	}

	// Get current state file path
	const stateDir = getRunStateDir(runId, workDir);
	const stateFileName = getStateFileName(stateType);
	const statePath = join(stateDir, stateFileName);

	// Create backup of current state before rollback (unless skipped)
	if (!options.skipBackup && existsSync(statePath)) {
		try {
			const currentContent = readFileSync(statePath, "utf-8");
			const currentData = JSON.parse(currentContent);
			saveStateSnapshot(runId, stateType, currentData, {
				reason: `Pre-rollback backup (rolling back to ${snapshotId})`,
				agentId: options.agentId,
				workDir,
			});
		} catch (error) {
			// Log but continue - backup failure shouldn't prevent rollback
			const stateError = new StateParseError(
				"Failed to create pre-rollback backup",
				{ filePath: statePath, cause: error instanceof Error ? error : new Error(String(error)) },
			);
			logStateError(stateError, "warn");
		}
	}

	// Write snapshot data to state file
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}
	writeFileSync(statePath, JSON.stringify(targetSnapshot.data, null, 2));

	return targetSnapshot.data;
}

/**
 * Get the state file name for a state type
 */
function getStateFileName(stateType: StateType): string {
	const fileNames: Record<StateType, string> = {
		issues: "issues.json",
		tasks: "tasks.json",
		meta: "meta.json",
		graph: "graph.json",
		executions: "executions.json",
	};
	return fileNames[stateType];
}

// ============================================================================
// SNAPSHOT CLEANUP
// ============================================================================

/**
 * Enforce snapshot limit by removing oldest snapshots
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param maxSnapshots - Maximum number of snapshots to keep
 * @param workDir - Working directory
 * @returns Number of snapshots removed
 */
export function enforceSnapshotLimit(
	runId: string,
	stateType: StateType,
	maxSnapshots: number,
	workDir = process.cwd(),
): number {
	const snapshots = listSnapshots(runId, stateType, workDir);

	if (snapshots.length <= maxSnapshots) {
		return 0;
	}

	// Remove oldest snapshots (list is sorted newest first)
	const toRemove = snapshots.slice(maxSnapshots);
	const historyDir = getStateHistoryDir(runId, stateType, workDir);

	let removed = 0;
	for (const snapshot of toRemove) {
		const snapshotPath = join(historyDir, `${snapshot.id}.json`);
		try {
			if (existsSync(snapshotPath)) {
				rmSync(snapshotPath);
				removed++;
			}
		} catch (error) {
			// Log but continue
			const stateError = new StateParseError(
				`Failed to remove old snapshot: ${snapshot.id}`,
				{ filePath: snapshotPath, cause: error instanceof Error ? error : new Error(String(error)) },
			);
			logStateError(stateError, "warn");
		}
	}

	return removed;
}

/**
 * Delete a specific snapshot
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param snapshotId - Snapshot to delete
 * @param workDir - Working directory
 * @returns true if deleted, false if not found
 */
export function deleteSnapshot(
	runId: string,
	stateType: StateType,
	snapshotId: string,
	workDir = process.cwd(),
): boolean {
	const historyDir = getStateHistoryDir(runId, stateType, workDir);
	const snapshotPath = join(historyDir, `${snapshotId}.json`);

	if (!existsSync(snapshotPath)) {
		return false;
	}

	rmSync(snapshotPath);
	return true;
}

/**
 * Clear all snapshots for a state type
 *
 * @param runId - Run identifier
 * @param stateType - Type of state
 * @param workDir - Working directory
 * @returns Number of snapshots removed
 */
export function clearSnapshots(
	runId: string,
	stateType: StateType,
	workDir = process.cwd(),
): number {
	const historyDir = getStateHistoryDir(runId, stateType, workDir);

	if (!existsSync(historyDir)) {
		return 0;
	}

	const files = readdirSync(historyDir).filter((f) => f.endsWith(".json"));
	let removed = 0;

	for (const file of files) {
		try {
			rmSync(join(historyDir, file));
			removed++;
		} catch {
			// Continue on error
		}
	}

	return removed;
}

/**
 * Clear all history for a run
 *
 * @param runId - Run identifier
 * @param workDir - Working directory
 */
export function clearAllHistory(runId: string, workDir = process.cwd()): void {
	const historyDir = getHistoryDir(runId, workDir);

	if (existsSync(historyDir)) {
		rmSync(historyDir, { recursive: true, force: true });
	}
}

// ============================================================================
// HISTORY STATISTICS
// ============================================================================

/**
 * Get history statistics for a run
 */
export function getHistoryStats(
	runId: string,
	workDir = process.cwd(),
): {
	stateType: StateType;
	snapshotCount: number;
	totalSizeBytes: number;
	oldestSnapshot: string | null;
	newestSnapshot: string | null;
}[] {
	const stateTypes: StateType[] = ["issues", "tasks", "meta", "graph", "executions"];
	const stats: ReturnType<typeof getHistoryStats> = [];

	for (const stateType of stateTypes) {
		const snapshots = listSnapshots(runId, stateType, workDir);
		const totalSize = snapshots.reduce((sum, s) => sum + (s.size_bytes ?? 0), 0);

		stats.push({
			stateType,
			snapshotCount: snapshots.length,
			totalSizeBytes: totalSize,
			oldestSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1].created_at : null,
			newestSnapshot: snapshots.length > 0 ? snapshots[0].created_at : null,
		});
	}

	return stats;
}
