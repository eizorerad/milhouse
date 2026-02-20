/**
 * Prompt builder for the consolidate phase (CDM agent)
 *
 * Builds a prompt that instructs the AI to merge multiple WBS plans into
 * a unified execution plan with proper dependencies and parallel groups.
 */

import type { PhaseContext } from "../../runner/types.ts";
import { AGENT_ROLES, type Issue, type Task, getWorkItemTitle } from "../../state/types.ts";
import { appendUserConfig } from "./common.ts";

/**
 * Input for the consolidate prompt.
 */
export interface ConsolidateInput {
	tasks: Task[];
	issues: Issue[];
}

/**
 * Build the consolidator prompt.
 *
 * @param input - Tasks and issues to consolidate
 * @param ctx - Phase context
 * @returns Full prompt string
 */
export function buildConsolidatePrompt(input: ConsolidateInput, _ctx: PhaseContext): string {
	const { tasks, issues } = input;
	const parts: string[] = [];

	// Role
	parts.push(`## Role: Consistency & Dependency Manager (CDM)
${AGENT_ROLES.CDM}

You are consolidating multiple Work Breakdown Structures into a unified Execution Plan.
Your task is to:
1. Identify and merge duplicate or overlapping tasks
2. Establish cross-issue dependencies
3. Optimize parallel execution groups
4. Provide a coherent execution order`);

	// Issues summary
	parts.push(`## Issues (${issues.length})

${issues
	.map(
		(i) => `- **${i.id}** [${i.status}]: ${getWorkItemTitle(i)}
  - Severity: ${i.severity}
  - Tasks: ${i.related_task_ids.length > 0 ? i.related_task_ids.join(", ") : "None"}`,
	)
	.join("\n\n")}`);

	// Tasks to consolidate
	parts.push(`## Tasks to Consolidate (${tasks.length})

${tasks
	.map(
		(t) => `### ${t.id}: ${t.title}
- **Issue**: ${t.issue_id || "None"}
- **Status**: ${t.status}
- **Files**: ${t.files.length > 0 ? t.files.join(", ") : "None specified"}
- **Dependencies**: ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "None"}
- **Parallel Group**: ${t.parallel_group}
- **Description**: ${truncate(t.description || "No description", 200)}`,
	)
	.join("\n\n")}`);

	// Task instructions
	parts.push(`## Task

Analyze the tasks and provide consolidation recommendations:

1. **Duplicates**: Find tasks that do the same thing or modify the same files
2. **Cross-Dependencies**: Identify dependencies between tasks from different issues
3. **Parallel Groups**: Optimize which tasks can run in parallel
4. **Execution Order**: Provide the optimal execution order respecting dependencies`);

	// Output format
	parts.push(`## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "duplicates": [
    {
      "keep": "TASK_ID to keep",
      "remove": ["TASK_IDs to remove"],
      "reason": "Why these are duplicates"
    }
  ],
  "cross_dependencies": [
    {
      "task_id": "TASK_ID",
      "depends_on": ["OTHER_TASK_IDs from different issues"],
      "reason": "Why this dependency exists"
    }
  ],
  "parallel_groups": [
    {
      "group": 0,
      "task_ids": ["IDs of tasks that can run in parallel"]
    }
  ],
  "execution_order": ["Ordered list of task IDs for execution"]
}
\`\`\``);

	// Guidelines
	parts.push(`## Guidelines

- **Duplicates**: Tasks touching the same files with similar goals should be merged
- **Cross-Dependencies**: Consider file conflicts and logical ordering
- **Parallel Groups**: Tasks with no conflicts can run in parallel
- **Execution Order**: Must respect all dependencies
- Be conservative - only merge tasks that are truly duplicates
- Consider the full blast radius when recommending changes`);

	return parts.join("\n\n");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}…`;
}
