/**
 * Probe results management module
 *
 * Handles saving and loading probe results from the filesystem.
 * Supports both run-aware paths (when runs are active) and legacy paths.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logStateError, StateParseError } from "./errors.ts";
import {
	type ProbeResult,
	ProbeResultSchema,
} from "./types.ts";
import { getCurrentRunId, getProbesPathForCurrentRun, getRunDir } from "./runs.ts";

// ============================================================================
// INTERNAL UTILITIES
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
// PROBE RESULTS FUNCTIONS
// ============================================================================

/**
 * Save a probe result to the filesystem
 *
 * Uses run-aware path if runs are active, otherwise falls back to legacy path.
 *
 * @param result - The probe result to save
 * @param workDir - Working directory (defaults to cwd)
 */
export function saveProbeResult(result: ProbeResult, workDir = process.cwd()): void {
	const dir = getProbesPathForCurrentRun(result.probe_type, workDir);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const path = join(dir, `${result.probe_id}.json`);
	saveJsonFile(path, result);
}

/**
 * Load all probe results of a specific type
 *
 * Uses run-aware path if runs are active, otherwise falls back to legacy path.
 *
 * @param probeType - The type of probe results to load
 * @param workDir - Working directory (defaults to cwd)
 * @returns Array of probe results
 */
export function loadProbeResults(probeType: string, workDir = process.cwd()): ProbeResult[] {
	const dir = getProbesPathForCurrentRun(probeType, workDir);
	if (!existsSync(dir)) {
		return [];
	}

	const results: ProbeResult[] = [];
	const files = readdirSync(dir);

	for (const file of files) {
		if (file.endsWith(".json")) {
			const path = join(dir, file);
			const result = loadJsonFile(path, ProbeResultSchema, null as unknown as ProbeResult);
			if (result) {
				results.push(result);
			}
		}
	}

	return results;
}

/**
 * Load a specific probe result by ID
 *
 * @param probeType - The type of probe
 * @param probeId - The probe result ID
 * @param workDir - Working directory (defaults to cwd)
 * @returns The probe result or null if not found
 */
export function loadProbeResult(
	probeType: string,
	probeId: string,
	workDir = process.cwd(),
): ProbeResult | null {
	const dir = getProbesPathForCurrentRun(probeType, workDir);
	const path = join(dir, `${probeId}.json`);

	if (!existsSync(path)) {
		return null;
	}

	return loadJsonFile(path, ProbeResultSchema, null as unknown as ProbeResult);
}

/**
 * Delete a probe result
 *
 * @param probeType - The type of probe
 * @param probeId - The probe result ID
 * @param workDir - Working directory (defaults to cwd)
 * @returns true if deleted, false if not found
 */
export function deleteProbeResult(
	probeType: string,
	probeId: string,
	workDir = process.cwd(),
): boolean {
	const dir = getProbesPathForCurrentRun(probeType, workDir);
	const path = join(dir, `${probeId}.json`);

	if (!existsSync(path)) {
		return false;
	}

	rmSync(path);
	return true;
}

/**
 * Get all probe types that have results
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns Array of probe type names
 */
export function getProbeTypes(workDir = process.cwd()): string[] {
	// Check both current run and legacy paths
	const currentRunId = getCurrentRunId(workDir);

	let probesDir: string;
	if (currentRunId) {
		probesDir = join(getRunDir(currentRunId, workDir), "probes");
	} else {
		probesDir = join(workDir, ".milhouse", "probes");
	}

	if (!existsSync(probesDir)) {
		return [];
	}

	const entries = readdirSync(probesDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/**
 * Count probe results by type
 *
 * @param probeType - The type of probe
 * @param workDir - Working directory (defaults to cwd)
 * @returns Number of probe results
 */
export function countProbeResults(probeType: string, workDir = process.cwd()): number {
	const dir = getProbesPathForCurrentRun(probeType, workDir);
	if (!existsSync(dir)) {
		return 0;
	}

	const files = readdirSync(dir);
	return files.filter((f) => f.endsWith(".json")).length;
}

/**
 * Get probe results with findings of a specific severity or higher
 *
 * @param probeType - The type of probe
 * @param minSeverity - Minimum severity level
 * @param workDir - Working directory (defaults to cwd)
 * @returns Array of probe results with matching findings
 */
export function getProbeResultsBySeverity(
	probeType: string,
	minSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
	workDir = process.cwd(),
): ProbeResult[] {
	const severityOrder = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
	const minIndex = severityOrder.indexOf(minSeverity);

	const results = loadProbeResults(probeType, workDir);

	return results.filter((result) =>
		result.findings.some((finding) => {
			const findingIndex = severityOrder.indexOf(finding.severity);
			return findingIndex >= minIndex;
		})
	);
}
