/**
 * @fileoverview Milhouse Scan Command
 *
 * Handles the --scan command to scan the repository for issues using
 * the Lead Investigator (LI) agent. Creates a new run with Problem Brief v0.
 *
 * @module cli/commands/pipeline/scan
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Scan the repository
 * milhouse --scan
 *
 * # Scan with focus area
 * milhouse --scan --scope "frontend"
 * ```
 */

// Re-export from the original scan command
// The original command already uses Milhouse branding
export { runScan } from "../scan.ts";
