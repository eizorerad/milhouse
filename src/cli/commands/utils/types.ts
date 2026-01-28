/**
 * @fileoverview Milhouse Utils Command Types
 *
 * Type definitions for utility CLI commands (scan, export, consolidate).
 * These commands handle utility operations.
 *
 * @module cli/commands/utils/types
 *
 * @since 4.3.0
 */

import type { ExportCommandResult } from "../../types.ts";

/**
 * Options for the export command
 */
export interface ExportOptions {
	/** Export formats (md, json) */
	formats: ExportFormat[];
	/** Output directory */
	outputDir?: string;
}

/**
 * Supported export formats
 */
export type ExportFormat = "md" | "json";

/**
 * Result of the export command
 */
export interface ExportResult extends ExportCommandResult {
	/** Export data summary */
	summary?: {
		issuesCount: number;
		tasksCount: number;
		executionsCount: number;
	};
}
