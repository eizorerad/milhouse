/**
 * Exec command -- thin wrapper around PhaseRunner
 *
 * @module cli/commands/pipeline/exec
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { execPhaseConfig } from "../../../runner/phases/exec.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runExecPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = await loadResolvedConfig(workDir, options);
	await runPhase(execPhaseConfig, {
		workDir,
		config,
		runId: options.runId,
	});
}

// Re-export utilities for backward compatibility
export { buildExecutorPrompt, getReadyTasksForRun } from "../../../runner/phases/exec.ts";
export type { ExecResult } from "../exec.ts";
