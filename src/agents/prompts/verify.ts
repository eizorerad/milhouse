/**
 * Prompt builder for the verify phase (Truth Verifier agent)
 *
 * Builds per-task verification prompts so each completed task can be
 * verified independently and in parallel. Each verifier focuses on
 * ONE task's diff, files, and acceptance criteria.
 *
 * @module agents/prompts/verify
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
 * Legacy input type for backward compatibility.
 * The new per-item mode passes individual Task objects instead.
 */
export interface VerifyInput {
	tasks: Task[];
	preCheckIssues: VerifyPreCheckIssue[];
}

/**
 * Build a verification prompt for a SINGLE task.
 *
 * Each parallel verifier gets one task to review, making verification
 * fast and focused. The verifier checks the task's files, diff, acceptance
 * criteria, and runs relevant tests.
 *
 * @param task - The specific task to verify
 * @param ctx - Phase context (provides workDir, runId, etc.)
 * @returns Focused prompt string for verifying this one task
 */
export function buildVerifyPromptForTask(task: Task, _ctx: PhaseContext): string {
	const parts: string[] = [];

	// Role
	parts.push(`## Role: Truth Verifier (TV)
${AGENT_ROLES.TV}

You are verifying ONE specific task's execution results.
Your job is to ensure the changes for this task are legitimate, complete, and meet quality standards.

⚠️ **AUTONOMOUS MODE**: You are running in a fully automated pipeline. Do NOT ask questions or request clarification. Make the best decision based on the codebase context. If uncertain, choose the most conservative/safe option and proceed.`);

	// Task details
	parts.push(`## Task to Verify

**ID**: ${task.id}
**Title**: ${task.title}
**Status**: ${task.status}
${task.issue_id ? `**Issue**: ${task.issue_id}` : ""}
${task.description ? `**Description**: ${task.description}` : ""}`);

	// Files to check
	if (task.files.length > 0) {
		parts.push(`### Modified Files
${task.files.map((f) => `- \`${f}\``).join("\n")}`);
	}

	// Acceptance criteria
	if (task.acceptance.length > 0) {
		parts.push(`### Acceptance Criteria
${task.acceptance
	.map(
		(a) =>
			`- [ ] ${a.description}${a.check_command ? ` (verify: \`${a.check_command}\`)` : ""}`,
	)
	.join("\n")}`);
	}

	// Verification checks
	if (task.checks.length > 0) {
		parts.push(`### Verification Commands
Run these to confirm the task works:
${task.checks.map((c) => `- \`${c}\``).join("\n")}`);
	}

	// Verification steps
	parts.push(`## Verification Steps

1. **Check the diff**: Run \`git log --oneline --all --grep="${task.id}"\` to find commits for this task, then \`git show <commit>\` to see the changes
2. **Verify files exist and are valid**: Spot-check the modified files listed above
3. **Run verification commands**: Execute the check commands listed above (if any)
4. **Check for placeholders**: Search for TODO, FIXME, mock, placeholder, or stub in modified files
5. **Confirm acceptance criteria**: Verify each criterion is met

### Efficiency Guidelines

- **Focus only on this task's files** — do NOT review unrelated code
- **Run only the specific test commands** for this task, NOT the full test suite
- **One git log + one git show** is sufficient for diff review
- You have a limited turn budget — be fast and focused`);

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
      "message": "Description of findings"
    }
  ],
  "recommendations": ["List of recommendations if any"],
  "regressions_found": false,
  "summary": "Brief summary of verification for this task"
}
\`\`\``);

	return parts.join("\n\n");
}

/**
 * Build the verifier prompt (legacy — single-agent mode).
 * Kept for backward compatibility but the phase now uses buildVerifyPromptForTask.
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
5. Ensure no placeholder code remains

### Efficiency Guidelines

- **Do NOT run the full test suite more than once.** Run tests once, record results, then analyze.
- **Use \`git diff\` or \`git log --oneline\` to review changes** rather than reading every modified file individually.
- **Spot-check** representative files rather than reading all of them.
- **Keep it fast**: you have a limited turn budget. Focus on evidence-based verification, not exhaustive auditing.
- If the test suite takes more than 2 minutes, stop it and note it as a concern rather than retrying.`);

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
