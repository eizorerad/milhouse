/**
 * Prompt builder for the verify phase (Truth Verifier agent)
 *
 * Builds a prompt that instructs the AI to verify execution results,
 * run quality gates, and check for regressions.
 */

import type { PhaseContext } from "../../runner/types.ts";
import { AGENT_ROLES, type Task } from "../../state/types.ts";

/**
 * Pre-check issue found by automated gates.
 */
export interface VerifyPreCheckIssue {
	gate: string;
	severity: string;
	message: string;
	file?: string;
	line?: number;
}

/**
 * Input for the verify prompt.
 */
export interface VerifyInput {
	tasks: Task[];
	preCheckIssues: VerifyPreCheckIssue[];
}

/**
 * Build the verifier prompt.
 *
 * @param input - Tasks and pre-check issues
 * @param ctx - Phase context
 * @returns Full prompt string
 */
export function buildVerifyPrompt(input: VerifyInput, _ctx: PhaseContext): string {
	const { tasks, preCheckIssues } = input;
	const parts: string[] = [];

	const completedTasks = tasks.filter((t) => t.status === "done");
	const failedTasks = tasks.filter((t) => t.status === "failed");

	// Role
	parts.push(`## Role: Truth Verifier (TV)
${AGENT_ROLES.TV}

You are verifying the execution results of completed tasks.
Your job is to ensure all changes are legitimate, complete, and meet quality standards.

⚠️ **AUTONOMOUS MODE**: You are running in a fully automated pipeline. Do NOT ask questions or request clarification. Make the best decision for this specific project based on the codebase context. If uncertain, choose the most conservative/safe option and proceed.`);

	// Execution summary
	parts.push(`## Execution Summary

**Completed Tasks**: ${completedTasks.length}
**Failed Tasks**: ${failedTasks.length}
**Total Tasks**: ${tasks.length}`);

	// Completed tasks
	if (completedTasks.length > 0) {
		parts.push(`### Completed Tasks

${completedTasks.map((t) => `- **${t.id}**: ${t.title}`).join("\n")}`);
	}

	// Pre-check issues
	if (preCheckIssues.length > 0) {
		parts.push(`## Pre-check Issues Found

The following issues were detected by automated gates:

${preCheckIssues.map((i) => `- **[${i.severity}]** ${i.gate}: ${i.message}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : ""}`).join("\n")}`);
	}

	// Verification task
	parts.push(`## Verification Task

1. Review the completed tasks and verify their implementation
2. Check that all acceptance criteria are met
3. Verify no regressions were introduced
4. Confirm all tests pass
5. Ensure no placeholder code remains`);

	// Output format
	parts.push(`## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "overall_pass": true|false,
  "gates": [
    {
      "gate": "evidence|diffHygiene|placeholder|dod",
      "passed": true|false,
      "message": "Description of findings",
      "evidence": []
    }
  ],
  "recommendations": ["List of recommendations if any"],
  "regressions_found": false,
  "summary": "Brief summary of verification results"
}
\`\`\``);

	return parts.join("\n\n");
}
