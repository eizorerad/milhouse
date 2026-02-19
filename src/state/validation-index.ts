/**
 * Validation Index Module
 *
 * Provides indexing for validation reports:
 * - Track all validation reports for a run
 * - Query reports by run or issue
 * - Update index when reports are saved
 *
 * Index file: .milhouse/runs/<run-id>/validation-index.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logStateError, StateParseError } from "./errors.ts";
import { getRunDir } from "./runs.ts";
import {
	type ValidationIndex,
	ValidationIndexSchema,
	type ValidationReportRef,
} from "./types.ts";

// ============================================================================
// CONSTANTS
// ============================================================================

const VALIDATION_INDEX_FILE = "validation-index.json";
const VALIDATION_REPORTS_DIR = "validation-reports";

// ============================================================================
// PATH FUNCTIONS
// ============================================================================

/**
 * Get path to validation index file for a run
 */
export function getValidationIndexPath(runId: string, workDir = process.cwd()): string {
	return join(getRunDir(runId, workDir), VALIDATION_INDEX_FILE);
}

/**
 * Get path to validation reports directory for a run
 */
export function getValidationReportsDir(runId: string, workDir = process.cwd()): string {
	return join(getRunDir(runId, workDir), VALIDATION_REPORTS_DIR);
}

// ============================================================================
// INDEX OPERATIONS
// ============================================================================

/**
 * Load validation index for a run
 */
export function loadValidationIndex(runId: string, workDir = process.cwd()): ValidationIndex {
	const indexPath = getValidationIndexPath(runId, workDir);

	if (!existsSync(indexPath)) {
		return {
			run_id: runId,
			reports: [],
			updated_at: new Date().toISOString(),
		};
	}

	try {
		const content = readFileSync(indexPath, "utf-8");
		const parsed = JSON.parse(content);
		return ValidationIndexSchema.parse(parsed);
	} catch (error) {
		const stateError = new StateParseError(
			`Failed to load validation index: ${indexPath}`,
			{ filePath: indexPath, cause: error instanceof Error ? error : new Error(String(error)) },
		);
		logStateError(stateError, "warn");
		return {
			run_id: runId,
			reports: [],
			updated_at: new Date().toISOString(),
		};
	}
}

/**
 * Save validation index for a run
 */
export function saveValidationIndex(index: ValidationIndex, workDir = process.cwd()): void {
	const runDir = getRunDir(index.run_id, workDir);

	if (!existsSync(runDir)) {
		mkdirSync(runDir, { recursive: true });
	}

	const indexPath = getValidationIndexPath(index.run_id, workDir);
	const updatedIndex = { ...index, updated_at: new Date().toISOString() };
	writeFileSync(indexPath, JSON.stringify(updatedIndex, null, 2));
}

/**
 * Add a validation report to the index
 *
 * @param runId - Run identifier
 * @param reportRef - Validation report reference
 * @param workDir - Working directory
 */
export function addValidationReportToIndex(
	runId: string,
	reportRef: Omit<ValidationReportRef, "created_at"> & { created_at?: string },
	workDir = process.cwd(),
): void {
	const index = loadValidationIndex(runId, workDir);

	// Check if report already exists (by issue_id and report_path)
	const existingIndex = index.reports.findIndex(
		(r) => r.issue_id === reportRef.issue_id && r.report_path === reportRef.report_path
	);

	const fullRef: ValidationReportRef = {
		...reportRef,
		created_at: reportRef.created_at ?? new Date().toISOString(),
	};

	if (existingIndex !== -1) {
		// Update existing entry
		index.reports[existingIndex] = fullRef;
	} else {
		// Add new entry
		index.reports.push(fullRef);
	}

	saveValidationIndex(index, workDir);
}

/**
 * Update validation index from a saved report
 *
 * This is the main function to call after saving a validation report.
 * It extracts the necessary information and updates the index.
 *
 * @param runId - Run identifier
 * @param issueId - Issue ID that was validated
 * @param reportPath - Path to the saved report (relative to run directory)
 * @param status - Validation status
 * @param workDir - Working directory
 */
export function updateValidationIndex(
	runId: string,
	issueId: string,
	reportPath: string,
	status: "valid" | "invalid" | "partial",
	workDir = process.cwd(),
): void {
	addValidationReportToIndex(
		runId,
		{
			issue_id: issueId,
			report_path: reportPath,
			status,
		},
		workDir,
	);
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Get all validation reports for a run
 *
 * @param runId - Run identifier
 * @param workDir - Working directory
 * @returns Array of validation report references
 */
export function getValidationReportsForRun(
	runId: string,
	workDir = process.cwd(),
): ValidationReportRef[] {
	const index = loadValidationIndex(runId, workDir);
	return index.reports;
}

/**
 * Get validation reports for a specific issue
 *
 * @param runId - Run identifier
 * @param issueId - Issue identifier
 * @param workDir - Working directory
 * @returns Array of validation report references for the issue
 */
export function getValidationReportsByIssue(
	runId: string,
	issueId: string,
	workDir = process.cwd(),
): ValidationReportRef[] {
	const index = loadValidationIndex(runId, workDir);
	return index.reports.filter((r) => r.issue_id === issueId);
}

/**
 * Get the latest validation report for an issue
 *
 * @param runId - Run identifier
 * @param issueId - Issue identifier
 * @param workDir - Working directory
 * @returns Latest validation report reference or null
 */
export function getLatestValidationReport(
	runId: string,
	issueId: string,
	workDir = process.cwd(),
): ValidationReportRef | null {
	const reports = getValidationReportsByIssue(runId, issueId, workDir);

	if (reports.length === 0) {
		return null;
	}

	// Sort by created_at descending and return first
	return reports.sort(
		(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
	)[0];
}

/**
 * Get validation reports by status
 *
 * @param runId - Run identifier
 * @param status - Status to filter by
 * @param workDir - Working directory
 * @returns Array of validation report references with the given status
 */
export function getValidationReportsByStatus(
	runId: string,
	status: "valid" | "invalid" | "partial",
	workDir = process.cwd(),
): ValidationReportRef[] {
	const index = loadValidationIndex(runId, workDir);
	return index.reports.filter((r) => r.status === status);
}

/**
 * Count validation reports by status
 *
 * @param runId - Run identifier
 * @param workDir - Working directory
 * @returns Object with counts by status
 */
export function countValidationReportsByStatus(
	runId: string,
	workDir = process.cwd(),
): { valid: number; invalid: number; partial: number; total: number } {
	const index = loadValidationIndex(runId, workDir);

	const counts = {
		valid: 0,
		invalid: 0,
		partial: 0,
		total: index.reports.length,
	};

	for (const report of index.reports) {
		counts[report.status]++;
	}

	return counts;
}

/**
 * Check if an issue has been validated
 *
 * @param runId - Run identifier
 * @param issueId - Issue identifier
 * @param workDir - Working directory
 * @returns true if the issue has at least one validation report
 */
export function isIssueValidated(
	runId: string,
	issueId: string,
	workDir = process.cwd(),
): boolean {
	const reports = getValidationReportsByIssue(runId, issueId, workDir);
	return reports.length > 0;
}

/**
 * Get issues that have not been validated yet (based on validation index)
 *
 * @param runId - Run identifier
 * @param issueIds - Array of all issue IDs to check
 * @param workDir - Working directory
 * @returns Array of issue IDs that have no validation reports
 */
export function getUnvalidatedIssueIds(
	runId: string,
	issueIds: string[],
	workDir = process.cwd(),
): string[] {
	const index = loadValidationIndex(runId, workDir);
	const validatedIssueIds = new Set(index.reports.map((r) => r.issue_id));

	return issueIds.filter((id) => !validatedIssueIds.has(id));
}

// ============================================================================
// CLEANUP OPERATIONS
// ============================================================================

/**
 * Remove a validation report from the index
 *
 * @param runId - Run identifier
 * @param issueId - Issue identifier
 * @param reportPath - Path to the report to remove
 * @param workDir - Working directory
 * @returns true if removed, false if not found
 */
export function removeValidationReportFromIndex(
	runId: string,
	issueId: string,
	reportPath: string,
	workDir = process.cwd(),
): boolean {
	const index = loadValidationIndex(runId, workDir);

	const initialLength = index.reports.length;
	index.reports = index.reports.filter(
		(r) => !(r.issue_id === issueId && r.report_path === reportPath)
	);

	if (index.reports.length < initialLength) {
		saveValidationIndex(index, workDir);
		return true;
	}

	return false;
}

/**
 * Clear all validation reports from the index
 *
 * @param runId - Run identifier
 * @param workDir - Working directory
 */
export function clearValidationIndex(runId: string, workDir = process.cwd()): void {
	const index = loadValidationIndex(runId, workDir);
	index.reports = [];
	saveValidationIndex(index, workDir);
}

// ============================================================================
// REBUILD INDEX
// ============================================================================

/**
 * Rebuild validation index from existing report files
 *
 * This is useful if the index gets out of sync with actual files.
 *
 * @param runId - Run identifier
 * @param workDir - Working directory
 * @returns Number of reports indexed
 */
export function rebuildValidationIndex(runId: string, workDir = process.cwd()): number {
	const reportsDir = getValidationReportsDir(runId, workDir);

	if (!existsSync(reportsDir)) {
		// No reports directory, create empty index
		saveValidationIndex(
			{
				run_id: runId,
				reports: [],
				updated_at: new Date().toISOString(),
			},
			workDir,
		);
		return 0;
	}

	const files = readdirSync(reportsDir).filter((f) => f.endsWith(".json"));
	const reports: ValidationReportRef[] = [];

	for (const file of files) {
		try {
			const filePath = join(reportsDir, file);
			const content = readFileSync(filePath, "utf-8");
			const report = JSON.parse(content);

			// Extract issue_id from filename or report content
			const issueId = report.issue_id || file.replace(".json", "");

			// Determine status from report
			let status: "valid" | "invalid" | "partial" = "partial";
			if (report.verdict === "CONFIRMED" || report.status === "CONFIRMED") {
				status = "valid";
			} else if (report.verdict === "FALSE" || report.status === "FALSE") {
				status = "invalid";
			}

			reports.push({
				issue_id: issueId,
				report_path: `${VALIDATION_REPORTS_DIR}/${file}`,
				created_at: report.created_at || report.timestamp || new Date().toISOString(),
				status,
			});
		} catch (error) {
			// Skip invalid files
			const stateError = new StateParseError(
				`Failed to parse validation report: ${file}`,
				{ filePath: join(reportsDir, file), cause: error instanceof Error ? error : new Error(String(error)) },
			);
			logStateError(stateError, "debug");
		}
	}

	saveValidationIndex(
		{
			run_id: runId,
			reports,
			updated_at: new Date().toISOString(),
		},
		workDir,
	);

	return reports.length;
}
