/**
 * Consolidate command -- thin wrapper around PhaseRunner
 *
 * Replaces monolithic consolidate.ts (~1500+ lines) with a ~10-line wrapper.
 *
 * @module cli/commands/pipeline/consolidate
 */

import type { RuntimeOptions } from "../../runtime-options.ts";
import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { consolidatePhaseConfig } from "../../../runner/phases/consolidate.ts";

export async function runConsolidatePipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(consolidatePhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}

// Backward-compat: re-export the old functions
export {
	runConsolidate,
	topologicalSort,
	buildDependencyGraph,
	assignParallelGroups,
} from "../consolidate.ts";
