/**
 * Scan command -- thin wrapper around PhaseRunner
 *
 * Replaces monolithic scan.ts (~800 lines) with a ~10-line wrapper.
 *
 * @module cli/commands/pipeline/scan
 */

import { loadResolvedConfig } from "../../../runner/config-loader.ts";
import { runPhase } from "../../../runner/phase-runner.ts";
import { scanPhaseConfig } from "../../../runner/phases/scan.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

export async function runScanPipeline(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const config = loadResolvedConfig(workDir, options);
	await runPhase(scanPhaseConfig, {
		workDir,
		config,
		scope: options.scanFocus,
		runId: options.runId,
	});
}
