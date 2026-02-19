/**
 * @fileoverview Milhouse Verify Command
 *
 * Handles the --verify command to run verification gates and check
 * for regressions using the Truth Verifier (TV) agent.
 *
 * @module cli/commands/pipeline/verify
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Run verification
 * milhouse --verify
 * ```
 */

// Re-export from the original verify command
// The original command already uses Milhouse branding
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
