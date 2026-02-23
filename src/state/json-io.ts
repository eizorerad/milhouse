/**
 * Shared JSON file I/O with schema validation and atomic writes.
 *
 * Used across all state modules (runs, issues, tasks, graph, probes, etc.)
 * to eliminate duplicated read/write/validate patterns.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StateParseError, StateWriteError, logStateError } from "./errors.ts";

/**
 * Load a JSON file with Zod schema validation.
 *
 * @param filePath - Path to the JSON file
 * @param schema - Zod schema (or anything with a .parse method)
 * @param defaultValue - Value to return if file doesn't exist or parsing fails
 * @returns Parsed and validated value, or defaultValue on error
 */
export function loadJsonFile<T>(
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
		const stateError = new StateParseError(`Failed to load or parse state file: ${filePath}`, {
			filePath,
			cause: error instanceof Error ? error : new Error(String(error)),
		});
		logStateError(stateError, "debug");
		return defaultValue;
	}
}

/**
 * Save a JSON file atomically where possible.
 *
 * Uses write-to-tmp + rename for atomicity. When combined with
 * withFileLock() or AsyncMutex, provides both atomic writes and
 * concurrency safety.
 *
 * On systems where rename fails (e.g., Windows with file watchers),
 * falls back to direct write.
 *
 * @param filePath - Path to write the JSON file
 * @param data - Data to serialize
 * @param atomic - Whether to use atomic write (tmp + rename). Default: true.
 */
export function saveJsonFile(filePath: string, data: unknown, atomic = true): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const content = JSON.stringify(data, null, 2);

	if (atomic) {
		const tmpPath = `${filePath}.tmp`;
		try {
			writeFileSync(tmpPath, content);
			renameSync(tmpPath, filePath);
			return;
		} catch (error) {
			// Log that atomicity was lost
			const writeError = new StateWriteError(
				`Atomic write failed for ${filePath}, falling back to direct write`,
				{
					filePath,
					cause: error instanceof Error ? error : new Error(String(error)),
				},
			);
			logStateError(writeError, "warn");

			// Clean up orphaned .tmp file
			try {
				unlinkSync(tmpPath);
			} catch {
				// .tmp may not exist or already removed — ignore
			}
		}
	}

	writeFileSync(filePath, content);
}
