/**
 * State Manager - Core utilities for state management
 *
 * This module provides core directory management, file utilities, and
 * essential state management functions.
 *
 * @module state/manager
 *
 * NOTE: Deprecated re-exports have been moved to _legacy/manager-reexports.ts.
 * For backward compatibility during migration, import from there or directly
 * from the specialized modules:
 * - runs.ts: Run management (create, list, switch, delete)
 * - issues.ts: Issue management
 * - tasks.ts: Task management
 * - graph.ts: Dependency graph operations
 * - executions.ts: Execution records
 * - probes.ts: Probe result storage
 * - compat.ts: Export to external formats
 * - migration.ts: Legacy state migration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logStateError, StateParseError } from "./errors.ts";
import {
	type ExecutionRecord,
	type GateResult,
	type RunState,
	RunStateSchema,
	STATE_FILES,
	type Task,
} from "./types.ts";

// Import task functions for internal use
import {
	loadTasks as _loadTasks,
	updateTask as _updateTask,
} from "./tasks.ts";

// Import execution functions for internal use
import { loadExecutions as _loadExecutions } from "./executions.ts";

// ============================================================================
// CORE CONSTANTS AND DIRECTORY MANAGEMENT
// ============================================================================

export const MILHOUSE_DIR = ".milhouse";

const SUBDIRS = ["state", "probes", "plans", "compat", "work/branches", "work/worktrees", "rules"];

/**
 * Get the full path to the milhouse directory
 */
export function getMilhouseDir(workDir = process.cwd()): string {
	return join(workDir, MILHOUSE_DIR);
}

/**
 * Get path to a state file
 */
export function getStatePath(file: keyof typeof STATE_FILES, workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "state", STATE_FILES[file]);
}

/**
 * Get path to probes directory for a specific type
 */
export function getProbesDir(probeType: string, workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "probes", probeType);
}

/**
 * Get path to plans directory
 */
export function getPlansDir(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "plans");
}

/**
 * Check if milhouse is initialized
 */
export function isInitialized(workDir = process.cwd()): boolean {
	const configPath = join(getMilhouseDir(workDir), "config.yaml");
	return existsSync(configPath);
}

/**
 * Ensure .milhouse/ is in .gitignore to prevent merge conflicts
 * with reports and task state files
 */
export function ensureGitignore(workDir = process.cwd()): void {
	const gitignorePath = join(workDir, ".gitignore");
	const milhousePattern = ".milhouse/";

	if (!existsSync(gitignorePath)) {
		// Create .gitignore with milhouse entry
		writeFileSync(gitignorePath, `# Milhouse local state (reports, tasks)\n${milhousePattern}\n`);
		return;
	}

	const content = readFileSync(gitignorePath, "utf-8");
	const lines = content.split("\n");

	// Check if .milhouse/ is already in gitignore
	const hasEntry = lines.some((line) => {
		const trimmed = line.trim();
		// Match .milhouse/ or .milhouse (with or without trailing slash)
		return trimmed === ".milhouse/" || trimmed === ".milhouse";
	});

	if (!hasEntry) {
		// Append .milhouse/ to gitignore
		const newContent = content.endsWith("\n")
			? `${content}\n# Milhouse local state (reports, tasks)\n${milhousePattern}\n`
			: `${content}\n\n# Milhouse local state (reports, tasks)\n${milhousePattern}\n`;
		writeFileSync(gitignorePath, newContent);
	}
}

/**
 * Initialize milhouse directory structure
 */
export function initializeDir(workDir = process.cwd()): void {
	const milDir = getMilhouseDir(workDir);

	// Ensure .milhouse/ is in .gitignore before creating the directory
	ensureGitignore(workDir);

	if (!existsSync(milDir)) {
		mkdirSync(milDir, { recursive: true });
	}

	for (const subdir of SUBDIRS) {
		const path = join(milDir, subdir);
		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
	}
}

/**
 * Generate unique ID
 */
export function generateId(prefix = ""): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}

// ============================================================================
// INTERNAL FILE UTILITIES
// ============================================================================

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
// LEGACY RUN STATE MANAGEMENT
// Note: For new code, use RunMeta from runs.ts instead
// These functions are kept here for backward compatibility but are also
// available in _legacy/manager-reexports.ts
// ============================================================================

/**
 * Load legacy run state
 * @deprecated Use getCurrentRun() from runs.ts for the new runs system
 */
export function loadRunState(workDir = process.cwd()): RunState | null {
	const path = getStatePath("run", workDir);
	if (!existsSync(path)) {
		return null;
	}
	return loadJsonFile(path, RunStateSchema, null as unknown as RunState);
}

/**
 * Save legacy run state
 * @deprecated Use saveRunMeta() from runs.ts for the new runs system
 */
export function saveRunState(state: RunState, workDir = process.cwd()): void {
	const path = getStatePath("run", workDir);
	saveJsonFile(path, state);
}

/**
 * Create legacy run state
 * @deprecated Use createRun() from runs.ts for the new runs system
 */
export function createRunState(workDir = process.cwd()): RunState {
	const state: RunState = {
		run_id: generateId("run"),
		started_at: new Date().toISOString(),
		phase: "idle",
		issues_found: 0,
		issues_validated: 0,
		tasks_total: 0,
		tasks_completed: 0,
		tasks_failed: 0,
	};
	saveRunState(state, workDir);
	return state;
}

/**
 * Update legacy run phase
 * @deprecated Use updateRunPhaseInMeta() from runs.ts for the new runs system
 */
export function updateRunPhase(phase: RunState["phase"], workDir = process.cwd()): RunState {
	const state = loadRunState(workDir) || createRunState(workDir);
	const updated = { ...state, phase };
	saveRunState(updated, workDir);
	return updated;
}

// ============================================================================
// TASK UPDATE WRAPPER
// ============================================================================

/**
 * Update task - wrapper for backward compatibility
 */
export function updateTask(
	id: string,
	update: Partial<Task>,
	workDir = process.cwd(),
): Task | null {
	return _updateTask(id, update, workDir);
}

// ============================================================================
// GATE RESULTS
// ============================================================================

/**
 * Record a gate result for an execution
 */
export function recordGateResult(
	executionId: string,
	gate: GateResult,
	workDir = process.cwd(),
): void {
	const executions = _loadExecutions(workDir);
	const exec = executions.find((e: ExecutionRecord) => e.id === executionId);
	if (!exec) {
		return;
	}

	const path = join(getMilhouseDir(workDir), "state", `gate_${executionId}_${gate.gate}.json`);
	saveJsonFile(path, gate);
}

// ============================================================================
// PROGRESS FILE
// ============================================================================

/**
 * Update progress file for human-readable status
 */
export function updateProgress(message: string, workDir = process.cwd()): void {
	const path = join(getMilhouseDir(workDir), "progress.txt");
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}\n`;

	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	writeFileSync(path, existing + line);
}
