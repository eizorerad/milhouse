/**
 * @fileoverview Milhouse Plan Command
 *
 * Handles the --plan command to generate Work Breakdown Structures (WBS)
 * for validated issues using Planner (PL) agents.
 *
 * @module cli/commands/pipeline/plan
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Plan all confirmed issues
 * milhouse --plan
 *
 * # Plan only high severity issues
 * milhouse --plan --min-severity HIGH
 * ```
 */

// Re-export from the original plan command
// The original command already uses Milhouse branding
export { runPlan } from "../plan.ts";
