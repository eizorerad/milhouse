/**
 * Prompt builder for the plan phase (Planner agent)
 *
 * Builds a prompt that instructs the AI to create a Work Breakdown Structure
 * (WBS) for a validated work item, with tasks, dependencies, and acceptance criteria.
 */

import type { PhaseContext } from "../../runner/types.ts";
import { appendUserConfig } from "./common.ts";
import {
	AGENT_ROLES,
	type Issue,
	getWorkItemRationale,
	getWorkItemTitle,
} from "../../state/types.ts";

/**
 * Build the planner prompt for a single issue.
 *
 * @param issue - The issue to plan
 * @param ctx - Phase context
 * @returns Full prompt string
 */
export function buildPlanPrompt(issue: Issue, _ctx: PhaseContext): string {
	const parts: string[] = [];
	const itemType = issue.type ?? "bug";

	// Role
	parts.push(`## Role: Planner (PL)
${AGENT_ROLES.PL}

You are creating a Work Breakdown Structure (WBS) for a validated work item (type: ${itemType}). Your task is to break down the work into small, testable tasks with clear acceptance criteria.`);

	// Work item details
	const issueDetails = [
		`**ID**: ${issue.id}`,
		`**Type**: ${itemType}`,
		`**Status**: ${issue.status}`,
		`**Title**: ${getWorkItemTitle(issue)}`,
		`**Rationale**: ${getWorkItemRationale(issue)}`,
	];

	if (issue.corrected_description)
		issueDetails.push(`**Corrected Description**: ${issue.corrected_description}`);
	issueDetails.push(`**Severity**: ${issue.severity}`);
	if (issue.scope_impact) issueDetails.push(`**Scope Impact**: ${issue.scope_impact}`);
	if (issue.frequency) issueDetails.push(`**Frequency**: ${issue.frequency}`);
	if (issue.blast_radius) issueDetails.push(`**Blast Radius**: ${issue.blast_radius}`);
	if (issue.strategy) issueDetails.push(`**Strategy**: ${issue.strategy}`);

	parts.push(`## Work Item to Plan\n${issueDetails.join("\n")}`);

	// Evidence
	if (issue.evidence.length > 0) {
		const evidenceList = issue.evidence
			.map((ev) => {
				if (ev.type === "file" && ev.file) {
					let line = `- **File**: \`${ev.file}\``;
					if (ev.line_start) {
						line += `:${ev.line_start}`;
						if (ev.line_end && ev.line_end !== ev.line_start) line += `-${ev.line_end}`;
					}
					return line;
				}
				if (ev.type === "command" && ev.command) return `- **Command**: \`${ev.command}\``;
				if (ev.type === "probe" && ev.probe_id) return `- **Probe**: ${ev.probe_id}`;
				return `- ${ev.type}`;
			})
			.join("\n");
		parts.push(`## Evidence\n${evidenceList}`);
	}

	// Task
	parts.push(`## Task

Create a Work Breakdown Structure (WBS) to implement this work item. Each task should be:

1. **Small and focused**: Ideally completable in one commit
2. **Testable**: With clear acceptance criteria that can be verified
3. **Independent**: Minimal dependencies where possible
4. **Ordered**: Use depends_on to specify execution order

Consider:
- Test-first approach where appropriate
- Edge cases and error handling
- Rollback strategies for risky changes`);

	// Output format
	parts.push(`## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "summary": "Brief summary of the implementation approach",
  "tasks": [
    {
      "title": "Short task title",
      "description": "Detailed description of what needs to be done",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "depends_on": [],
      "checks": ["npm test", "npm run lint"],
      "acceptance": [
        {
          "description": "Test passes for X scenario",
          "check_command": "npm test -- --grep 'X scenario'"
        }
      ],
      "risk": "Low - isolated change",
      "rollback": "Revert commit",
      "parallel_group": 0
    }
  ]
}
\`\`\``);

	// Guidelines
	parts.push(`## Guidelines

- **Task Granularity**: Each task should be a single logical unit of work
- **Dependencies**: Use depends_on to reference other task indices (0-based within this WBS)
- **Parallel Groups**: Tasks with the same parallel_group can run concurrently
- **Acceptance Criteria**: Must be verifiable by running commands
- **Files**: List ALL files that will be modified
- **Checks**: Commands to run after task completion
- **Risk Assessment**: Describe potential risks and blast radius
- **Rollback**: How to undo if something goes wrong

**Important:**
- Do NOT create tasks that are too broad (e.g., "implement everything")
- Do NOT create tasks without acceptance criteria
- Each task should result in a working, testable state
- Consider test-first approach where appropriate
- Account for edge cases and error handling
- Keep the number of tasks reasonable (typically 2-8 per issue)`);

	return parts.join("\n\n");
}
