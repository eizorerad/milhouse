/**
 * State Manager - Core utilities for state management
 *
 * This module provides core directory management, file utilities, and
 * essential state management functions.
 *
 * @module state/manager
 *
 * For specialized state operations, import from the dedicated modules:
 * - runs.ts: Run management (create, list, switch, delete)
 * - issues.ts: Issue management
 * - tasks.ts: Task management
 * - graph.ts: Dependency graph operations
 * - executions.ts: Execution records
 * - compat.ts: Export to external formats
 * - migration.ts: Legacy state migration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveJsonFile } from "./json-io.ts";
import { MILHOUSE_DIR, getMilhouseDir } from "./paths.ts";
import {
	type ExecutionRecord,
	type GateResult,
	STATE_FILES,
	type Task,
} from "./types.ts";

// Import task functions for internal use
import { updateTask as _updateTask } from "./tasks.ts";

// Import execution functions for internal use
import { loadExecutions as _loadExecutions } from "./executions.ts";

// ============================================================================
// CORE CONSTANTS AND DIRECTORY MANAGEMENT
// ============================================================================

// Re-export for backward compatibility (other modules import from manager.ts)
export { MILHOUSE_DIR, getMilhouseDir };

const SUBDIRS = ["state", "probes", "plans", "compat", "work/branches", "work/worktrees", "rules"];

/**
 * Get path to a state file
 */
export function getStatePath(file: keyof typeof STATE_FILES, workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "state", STATE_FILES[file]);
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
// INTERNAL FILE UTILITIES (using shared json-io module)
// ============================================================================

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
