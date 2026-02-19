/**
 * Plan command -- thin wrapper around PhaseRunner
 *
 * Replaces monolithic plan.ts (~1000+ lines) with a ~10-line wrapper.
 *
 * @module cli/commands/pipeline/plan
 */

import type { RuntimeOptions } from "../../runtime-options.ts";
import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { planPhaseConfig } from "../../../runner/phases/plan.ts";

export async function runPlanPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(planPhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}

// Backward-compat: re-export the old function name
export { runPlan } from "../plan.ts";
