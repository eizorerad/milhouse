/**
 * Verify command -- thin wrapper around PhaseRunner
 *
 * @module cli/commands/pipeline/verify
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { verifyPhaseConfig } from "../../../runner/phases/verify.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runVerifyPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = await loadResolvedConfig(workDir, options);
	await runPhase(verifyPhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}
