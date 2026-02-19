/**
 * @fileoverview Milhouse Consolidate Command
 *
 * Handles the --consolidate command to merge WBS plans into a unified
 * Execution Plan using the Consistency & Dependency Manager (CDM) agent.
 *
 * @module cli/commands/pipeline/consolidate
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Consolidate all WBS plans
 * milhouse --consolidate
 * ```
 */

// Re-export from the original consolidate command
// The original command already uses Milhouse branding
export {
	runConsolidate,
	topologicalSort,
	buildDependencyGraph,
	assignParallelGroups,
} from "../consolidate.ts";
