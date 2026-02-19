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
// LEGACY: Re-exports from monolithic command files (backward compatibility)
// These will be removed in T10 when old commands are deleted.
// ============================================================================

// Re-export scan command
export { runScan } from "../scan.ts";

// Re-export validate command
export { runValidate } from "../validate.ts";

// Re-export plan command
export { runPlan } from "../plan.ts";

// Re-export consolidate command
export {
	runConsolidate,
	topologicalSort,
	buildDependencyGraph,
	assignParallelGroups,
} from "../consolidate.ts";

// Re-export exec command (exec stays as-is, not runner-based)
export { runExec, buildExecutorPrompt, getReadyTasksForRun, type ExecResult } from "../exec.ts";

// Re-export verify command
export {
	runVerify,
	buildVerifierPrompt,
	runPlaceholderGate,
	runDiffHygieneGate,
	runEvidenceGate,
	runDoDGate,
	runEnvConsistencyGate,
	runAllGates,
	GATES,
	type GateName,
	type VerifyResult,
	type VerificationIssue,
} from "../verify.ts";
