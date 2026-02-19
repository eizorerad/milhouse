/**
 * Compatibility/Export module
 *
 * Handles exporting state to external tool formats (e.g., PRD format).
 * This module provides interoperability with other tools and formats.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExecutions } from "./executions.ts";
import { loadGraph } from "./graph.ts";
import { loadIssues } from "./issues.ts";
import { getCurrentRun } from "./runs.ts";
import { loadTasks } from "./tasks.ts";

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
 * Get path to compatibility directory (for external tool exports)
 */
export function getCompatDir(workDir = process.cwd()): string {
	return join(getMilhouseDir(workDir), "compat");
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
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Export tasks to PRD (Product Requirements Document) format
 *
 * This creates a simplified JSON format that can be consumed by
 * external tools or used for documentation purposes.
 *
 * @param workDir - Working directory (defaults to cwd)
 */
export function exportToCompat(workDir = process.cwd()): void {
	const tasks = loadTasks(workDir);
	const compatDir = getCompatDir(workDir);

	const prd = {
		tasks: tasks.map((t) => ({
			id: t.id,
			title: t.title,
			description: t.description,
			status: t.status,
			files: t.files,
			depends_on: t.depends_on,
		})),
		generated_at: new Date().toISOString(),
	};

	saveJsonFile(join(compatDir, "prd.json"), prd);
}

/**
 * Export tasks to a simple markdown format
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns Markdown string
 */
export function exportToMarkdown(workDir = process.cwd()): string {
	const tasks = loadTasks(workDir);

	const lines: string[] = [
		"# Tasks",
		"",
		`Generated at: ${new Date().toISOString()}`,
		"",
	];

	// Group tasks by status
	const byStatus = new Map<string, typeof tasks>();
	for (const task of tasks) {
		const existing = byStatus.get(task.status) || [];
		existing.push(task);
		byStatus.set(task.status, existing);
	}

	for (const [status, statusTasks] of byStatus) {
		lines.push(`## ${status.toUpperCase()}`);
		lines.push("");

		for (const task of statusTasks) {
			const checkbox = task.status === "done" ? "[x]" : "[ ]";
			lines.push(`- ${checkbox} **${task.id}**: ${task.title}`);
			if (task.description) {
				lines.push(`  - ${task.description}`);
			}
			if (task.files.length > 0) {
				lines.push(`  - Files: ${task.files.join(", ")}`);
			}
			if (task.depends_on.length > 0) {
				lines.push(`  - Depends on: ${task.depends_on.join(", ")}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Export tasks to CSV format
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns CSV string
 */
export function exportToCsv(workDir = process.cwd()): string {
	const tasks = loadTasks(workDir);

	const headers = ["id", "title", "description", "status", "files", "depends_on", "created_at"];
	const lines: string[] = [headers.join(",")];

	for (const task of tasks) {
		const row = [
			escapeCSV(task.id),
			escapeCSV(task.title),
			escapeCSV(task.description || ""),
			escapeCSV(task.status),
			escapeCSV(task.files.join("; ")),
			escapeCSV(task.depends_on.join("; ")),
			escapeCSV(task.created_at),
		];
		lines.push(row.join(","));
	}

	return lines.join("\n");
}

/**
 * Escape a value for CSV format
 */
function escapeCSV(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Export issues to a summary format
 *
 * @param workDir - Working directory (defaults to cwd)
 */
export function exportIssuesToCompat(workDir = process.cwd()): void {
	const issues = loadIssues(workDir);
	const compatDir = getCompatDir(workDir);

	const summary = {
		issues: issues.map((i: { id: string; symptom: string; hypothesis: string; status: string; severity: string; evidence: unknown[] }) => ({
			id: i.id,
			symptom: i.symptom,
			hypothesis: i.hypothesis,
			status: i.status,
			severity: i.severity,
			evidence_count: i.evidence.length,
		})),
		generated_at: new Date().toISOString(),
		total: issues.length,
		by_status: countByField(issues, "status"),
		by_severity: countByField(issues, "severity"),
	};

	saveJsonFile(join(compatDir, "issues-summary.json"), summary);
}

/**
 * Count items by a field value
 */
function countByField<T extends Record<string, unknown>>(
	items: T[],
	field: keyof T,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const value = String(item[field]);
		counts[value] = (counts[value] || 0) + 1;
	}
	return counts;
}

/**
 * Export full state snapshot for backup/restore
 *
 * @param workDir - Working directory (defaults to cwd)
 */
export function exportStateSnapshot(workDir = process.cwd()): void {
	const tasks = loadTasks(workDir);
	const issues = loadIssues(workDir);
	const executions = loadExecutions(workDir);
	const graph = loadGraph(workDir);
	const currentRun = getCurrentRun(workDir);

	const compatDir = getCompatDir(workDir);

	const snapshot = {
		version: "1.0",
		exported_at: new Date().toISOString(),
		current_run: currentRun,
		state: {
			tasks,
			issues,
			executions,
			graph,
		},
	};

	saveJsonFile(join(compatDir, "state-snapshot.json"), snapshot);
}
