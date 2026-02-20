/**
 * Consolidate command -- thin wrapper around PhaseRunner
 *
 * @module cli/commands/pipeline/consolidate
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { consolidatePhaseConfig } from "../../../runner/phases/consolidate.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runConsolidatePipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(consolidatePhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}
