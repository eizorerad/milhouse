/**
 * Plan command -- thin wrapper around PhaseRunner
 *
 * @module cli/commands/pipeline/plan
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { planPhaseConfig } from "../../../runner/phases/plan.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runPlanPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(planPhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}
