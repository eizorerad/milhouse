/**
 * Milhouse Pipeline Commands Module
 *
 * Barrel export for pipeline CLI commands (scan, validate, plan, consolidate, exec, verify).
 * These commands handle the Milhouse pipeline phases.
 *
 * The Milhouse pipeline follows this sequence:
 * 1. scan - Lead Investigator scans for issues
 * 2. validate - Issue Validators confirm/reject issues
 * 3. plan - Planners create WBS for confirmed issues
 * 4. consolidate - CDM merges plans into Execution Plan
 * 5. exec - Executors implement the tasks
 * 6. verify - Truth Verifier runs gates and checks
 *
 * @module cli/commands/pipeline
 */

// Types
export * from "./types.ts";

// ============================================================================
// NEW: Thin wrappers that use PhaseRunner (preferred for new code)
// ============================================================================
export { runScanPipeline } from "./scan.ts";
export { runValidatePipeline } from "./validate.ts";
export { runPlanPipeline } from "./plan.ts";
export { runConsolidatePipeline } from "./consolidate.ts";
export { runVerifyPipeline } from "./verify.ts";

// ============================================================================
// Exec command (exec stays as-is, not runner-based yet)
// ============================================================================
export { runExec, buildExecutorPrompt, getReadyTasksForRun, type ExecResult } from "../exec.ts";
