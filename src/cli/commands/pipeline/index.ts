/**
 * @fileoverview Milhouse Pipeline Commands Module
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
 *
 * @since 4.3.0
 */

// Types
export * from "./types.ts";

// Re-export scan command with Milhouse branding
export { runScan } from "../scan.ts";

// Re-export validate command with Milhouse branding
export { runValidate } from "../validate.ts";

// Re-export plan command with Milhouse branding
export { runPlan } from "../plan.ts";

// Re-export consolidate command with Milhouse branding
export {
	runConsolidate,
	topologicalSort,
	buildDependencyGraph,
	assignParallelGroups,
} from "../consolidate.ts";

// Re-export exec command with Milhouse branding
export { runExec, buildExecutorPrompt, getReadyTasks, type ExecResult } from "../exec.ts";

// Re-export verify command with Milhouse branding
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
