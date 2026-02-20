/**
 * Validate command -- thin wrapper around PhaseRunner
 *
 * Replaces monolithic validate.ts (~1000+ lines) with a ~10-line wrapper.
 *
 * @module cli/commands/pipeline/validate
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { validatePhaseConfig } from "../../../runner/phases/validate.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runValidatePipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(validatePhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}
