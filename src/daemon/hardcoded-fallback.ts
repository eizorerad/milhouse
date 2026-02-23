/**
 * Hardcoded fallback decision logic
 *
 * Used when the AI orchestrator is disabled (--no-orchestrator) or when
 * the orchestrator call fails. Provides deterministic stop/continue logic.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRunDir, loadRunsIndex } from "../state/runs.ts";
import type { DaemonState, RunDirective } from "./types.ts";

interface IssueSnapshot {
	id: string;
	severity: string;
	status: string;
	title?: string;
}

/**
 * Make a deterministic run/stop decision based on current state.
 * No AI involved — pure logic.
 */
export function hardcodedDecision(
	state: DaemonState,
	workDir: string,
	minSeverity = "HIGH",
): RunDirective {
	const lastRun = state.runs[state.runs.length - 1];

	// First run ever — just start with the user's scope
	if (!lastRun || state.totalRuns === 0) {
		return {
			action: "run",
			reasoning: "First run — starting with user scope",
			scope: state.scope,
		};
	}

	// Load issues from the latest milhouse run to check remaining work
	const remaining = getRemainingIssues(workDir, minSeverity);

	if (remaining.length === 0) {
		return {
			action: "stop",
			reasoning: `No issues at severity ${minSeverity} or above remain`,
			stopReason: `All ${minSeverity}+ issues resolved`,
			summary: `Completed ${state.totalRuns} runs. All issues at ${minSeverity} severity or above have been resolved.`,
		};
	}

	// Last run failed — try resuming it
	if (lastRun.result === "failed" || lastRun.result === "killed") {
		return {
			action: "run",
			reasoning: `Last run ${lastRun.result} — resuming`,
			resume: true,
			runId: lastRun.runId,
		};
	}

	// Last run succeeded but issues remain — new scan with same scope
	return {
		action: "run",
		reasoning: `${remaining.length} ${minSeverity}+ issues remaining`,
		scope: state.scope,
	};
}

/**
 * Get issues at or above the given severity that are not done.
 */
function getRemainingIssues(
	workDir: string,
	minSeverity: string,
): IssueSnapshot[] {
	const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
	const minIdx = severityOrder.indexOf(minSeverity.toUpperCase());
	const targetSeverities =
		minIdx >= 0 ? severityOrder.slice(0, minIdx + 1) : severityOrder.slice(0, 2);

	const index = loadRunsIndex(workDir);
	if (index.runs.length === 0) return [];

	// Look at the latest run
	const latestRunId = index.runs[index.runs.length - 1].id;
	const issuesPath = join(getRunDir(latestRunId, workDir), "state", "issues.json");

	if (!existsSync(issuesPath)) return [];

	try {
		const issues: IssueSnapshot[] = JSON.parse(
			readFileSync(issuesPath, "utf-8"),
		);

		return issues.filter(
			(issue) =>
				targetSeverities.includes(issue.severity) &&
				issue.status !== "FALSE",
		);
	} catch {
		return [];
	}
}
