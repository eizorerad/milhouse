/**
 * Verify command -- thin wrapper around PhaseRunner
 *
 * Replaces monolithic verify.ts (~1200+ lines) with a ~10-line wrapper.
 *
 * @module cli/commands/pipeline/verify
 */

import type { RuntimeOptions } from "../../runtime-options.ts";
import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { verifyPhaseConfig } from "../../../runner/phases/verify.ts";

export async function runVerifyPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(verifyPhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}

// Backward-compat: re-export the old functions
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
