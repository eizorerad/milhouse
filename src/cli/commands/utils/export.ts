/**
 * @fileoverview Milhouse Export Command
 *
 * Handles the --export command to export state to markdown/JSON formats.
 *
 * @module cli/commands/utils/export
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Export to all formats
 * milhouse --export
 *
 * # Export to markdown only
 * milhouse --export --format md
 * ```
 */

// Re-export from the original export command
// The original command already uses Milhouse branding
export {
	runExport,
	parseFormats,
	loadExportData,
	generateJsonExport,
	generateMarkdownExport,
	getDefaultOutputDir,
	type ExportFormat,
	type ExportOptions,
	type ExportResult,
	type ExportData,
} from "../export.ts";
