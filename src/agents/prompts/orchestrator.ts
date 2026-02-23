/**
 * Orchestrator agent prompt template
 *
 * The orchestrator is a lightweight AI agent that runs between daemon iterations.
 * It reads session context (specs, reports, run history) and returns a RunDirective
 * telling the daemon what to do next: run with a specific scope, or stop.
 */

import type { DaemonRunEntry, RunDirective } from "../../daemon/types.ts";

export interface OrchestratorPromptContext {
	/** Original user scope */
	userScope: string;
	/** Contents of spec documents (truncated if large) */
	specContents: string;
	/** Session stats */
	completedRuns: number;
	maxRuns: number;
	budgetSpent: number;
	budgetLimit: number;
	elapsedTime: string;
	timeLimit: string;
	consecutiveFailures: number;
	/** Run history summaries */
	runHistory: DaemonRunEntry[];
	/** Previous orchestrator decisions */
	previousDecisions: Array<{ timestamp: string; directive: RunDirective }>;
	/** Available engines */
	availableEngines: string[];
	/** Last incomplete run info (for resume) */
	lastIncompleteRunId?: string;
	lastIncompletePhase?: string;
}

const RUN_DIRECTIVE_SCHEMA = `{
  "action": "run" | "stop",
  "reasoning": "string — explain your decision",

  // If action = "run":
  "scope": "string — what to focus on this run",
  "resume": false,
  "runId": null,
  "minSeverity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null,
  "issueIds": [] | null,
  "excludeIssueIds": [] | null,
  "startPhase": null,

  // If action = "stop":
  "stopReason": "string — human-readable reason",
  "summary": "string — one paragraph summary of what was accomplished"
}`;

/**
 * Build the orchestrator agent prompt.
 */
export function buildOrchestratorPrompt(ctx: OrchestratorPromptContext): string {
	const sections: string[] = [];

	sections.push(`You are the Milhouse Daemon Orchestrator. You review the current state of an
overnight automation session and decide what the next step should be.

## Your Responsibilities
1. Decide whether to CONTINUE running (action: "run") or STOP (action: "stop")
2. If continuing, determine the best scope and strategy for the next run
3. Learn from previous failures — exclude issues that repeatedly fail, adjust strategy when something is not working
4. Stay focused on the original user intent — do not drift into unrelated work
5. If all meaningful work within the user's intent is done, STOP — do not invent new work

## Rules
- You can ONLY return a JSON object matching the schema below
- Never suggest disabling safety limits or watchdog
- If unsure, prefer to continue with a narrow scope rather than stopping prematurely
- If the same issue failed 3+ times, exclude it and move on`);

	// User intent
	sections.push(`## User Intent
${ctx.userScope || "(no specific scope provided — use previous run state)"}`);

	// Spec documents
	if (ctx.specContents) {
		sections.push(`## Spec Documents
${ctx.specContents}`);
	}

	// Session state
	sections.push(`## Session State
- Runs completed: ${ctx.completedRuns} of max ${ctx.maxRuns || "unlimited"}
- Budget spent: $${ctx.budgetSpent.toFixed(2)} of $${ctx.budgetLimit || "unlimited"}
- Time elapsed: ${ctx.elapsedTime} of ${ctx.timeLimit || "unlimited"}
- Consecutive failures: ${ctx.consecutiveFailures}`);

	// Run history
	if (ctx.runHistory.length > 0) {
		const historyLines = ctx.runHistory
			.slice(-10) // last 10 runs max
			.map((run) => {
				const fixed = run.issuesFixed.length > 0
					? `Fixed: ${run.issuesFixed.join(", ")}`
					: "Fixed: none";
				const failed = run.issuesFailed.length > 0
					? `Failed: ${run.issuesFailed.join(", ")}`
					: "";
				const cost = run.cost ? `Cost: $${run.cost.toFixed(2)}` : "";
				const watchdog = run.killedByWatchdog ? " [KILLED BY WATCHDOG]" : "";
				const error = run.error ? `Error: ${run.error}` : "";

				return `Run #${run.number} (${run.result}${watchdog}): ${fixed}${failed ? ` | ${failed}` : ""}${cost ? ` | ${cost}` : ""}${error ? ` | ${error}` : ""}`;
			})
			.join("\n");

		sections.push(`## Run History (most recent last)
${historyLines}`);
	} else {
		sections.push("## Run History\nNo runs completed yet.");
	}

	// Previous decisions
	if (ctx.previousDecisions.length > 0) {
		const decisionLines = ctx.previousDecisions
			.slice(-5)
			.map((d) => `[${d.timestamp}] ${d.directive.action}: ${d.directive.reasoning}`)
			.join("\n");

		sections.push(`## Previous Orchestrator Decisions
${decisionLines}`);
	}

	// Resume info
	if (ctx.lastIncompleteRunId) {
		sections.push(`## Resume Option
Can resume run ${ctx.lastIncompleteRunId} from phase "${ctx.lastIncompletePhase}"`);
	}

	// Output format
	sections.push(`## Output Format
Return ONLY a JSON object with this schema (no markdown, no explanation outside JSON):
${RUN_DIRECTIVE_SCHEMA}

Think step by step before deciding:
1. What was the user's goal?
2. How much progress has been made?
3. What went wrong in previous runs? Can it be fixed by changing strategy?
4. Is there meaningful work left that fits the user's intent?
5. Are we stuck in a loop (same failures repeating)?`);

	return sections.join("\n\n");
}
