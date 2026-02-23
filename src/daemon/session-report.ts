/**
 * Daemon session report generator
 *
 * Generates .md and .json reports for a daemon session by delegating
 * to the existing report infrastructure.
 */

import { generateReport, type ReportResult } from "../report/generator.ts";
import { createRunCost } from "../runner/cost.ts";
import type { RunMeta } from "../state/types.ts";

/**
 * Write a session report for the given run state.
 * Generates both markdown and JSON report files.
 */
export function writeSessionReport(state: RunMeta, workDir: string): ReportResult {
	return generateReport({
		runId: state.id,
		cost: createRunCost(),
		duration: Date.now() - new Date(state.created_at).getTime(),
		workDir,
		format: "both",
	});
}
