import { logError, setVerbose } from "../../ui/logger.ts";
import type { RuntimeOptions } from "../runtime-options.ts";

import { runPipeline as runPipelineImpl } from "../../pipeline/orchestrator.ts";
import type { PipelineResult } from "../../pipeline/orchestrator.ts";
// Runner-based imports
import { loadResolvedConfig } from "../../runner/config-loader.ts";

/**
 * Options for the pipeline run
 */
export interface PipelineRunOptions {
	/** Start from this phase */
	startPhase?: string;
	/** Stop after this phase */
	endPhase?: string;
	/** Resume from where it left off */
	resume?: boolean;
	/** Force run even if phases already completed */
	force?: boolean;
}

/**
 * Run the full Milhouse pipeline using the PhaseRunner-based orchestrator.
 *
 * 1. loadResolvedConfig() merges defaults + config.yml + CLI flags
 * 2. runPipeline() loops over phases using PhaseRunner
 */
export async function runPipelineV2(
	options: RuntimeOptions,
	pipelineOptions: PipelineRunOptions = {},
): Promise<PipelineResult> {
	const workDir = process.cwd();
	setVerbose(options.verbose);

	const config = await loadResolvedConfig(workDir, options);

	// Load user config for pipeline phase order
	const { loadUserConfig } = await import("../../config/loader.ts");
	const { resolveConfig } = await import("../../config/define.ts");
	const userConfig = resolveConfig(await loadUserConfig(workDir));

	const result = await runPipelineImpl({
		workDir,
		config,
		scope: options.scanFocus,
		runId: options.runId,
		pipeline: userConfig.pipeline,
		startPhase: pipelineOptions.startPhase,
		endPhase: pipelineOptions.endPhase,
		resume: pipelineOptions.resume,
		force: pipelineOptions.force,
	});

	if (!result.success) {
		logError(
			`Pipeline failed${result.stoppedAt ? ` at phase "${result.stoppedAt}"` : ""}: ${result.error ?? "unknown error"}`,
		);
		process.exit(1);
	}

	return result;
}
