/**
 * Prompt builder for the scan phase (Lead Investigator agent)
 *
 * Builds a prompt that instructs the AI to analyze the repository
 * and identify work items (bugs, features, refactoring, improvements, tasks).
 */

import type { PhaseContext } from "../../runner/types.ts";
import { AGENT_ROLES } from "../../state/types.ts";

/**
 * Build the scan prompt for the Lead Investigator agent.
 *
 * @param scope - Focus area for the scan (e.g. "authentication bugs")
 * @param workDir - Working directory of the repository
 * @param ctx - Phase context with config
 * @returns Full prompt string
 */
export function buildScanPrompt(scope: string, _workDir: string, _ctx: PhaseContext): string {
	const parts: string[] = [];

	// Role
	parts.push(`## Role: Lead Investigator (LI)
${AGENT_ROLES.LI}

You are analyzing this repository to identify work items. Work items can be bugs, features, refactoring opportunities, improvements, or general tasks. Determine the intent from the scope and produce appropriate work items.`);

	// Context
	const contextParts: string[] = [];
	if (scope) {
		contextParts.push(`Focus areas: ${scope}`);
	}
	if (contextParts.length > 0) {
		parts.push(`## Project Context\n${contextParts.join("\n\n")}`);
	}

	// Task
	parts.push(`## Task

Analyze the repository and identify work items based on the scope. For each work item, provide:

1. **Type**: bug | feature | refactor | improvement | task
2. **Title**: Clear, concise title describing the work item
3. **Rationale**: Why this work is needed (root cause for bugs, justification for features, etc.)
4. **Severity**: CRITICAL | HIGH | MEDIUM | LOW (priority level)
5. **Scope Impact**: What areas of the codebase are affected (optional)
6. **Strategy**: Suggested implementation approach (optional)

If the scope describes a specific task (e.g. "add dark mode", "refactor auth module"), create work items that break down that task.
If the scope describes an area to investigate (e.g. "authentication bugs", "performance issues"), scan for problems in that area.
If no scope is given, scan for bugs, technical debt, and improvement opportunities.`);

	// Output format
	parts.push(`## Output Format

Respond with a JSON array of work items in this exact format:

\`\`\`json
[
  {
    "type": "bug",
    "title": "Clear title describing the work item",
    "rationale": "Why this work is needed - root cause, justification, or analysis",
    "severity": "HIGH",
    "scope_impact": "Components or areas affected",
    "strategy": "Suggested implementation approach"
  }
]
\`\`\`

Valid types: bug, feature, refactor, improvement, task.

If no significant work items are found, return an empty array: \`[]\``);

	// Guidelines
	parts.push(`## Guidelines

- Focus on real, actionable work items (bugs, features, refactoring, improvements, tasks)
- Do NOT report style preferences or minor nitpicks
- Each work item should be independently actionable
- Be specific about file locations when possible
- Prioritize work items by impact and feasibility
- For bugs: look for missing error handling, race conditions, security vulnerabilities, performance bottlenecks
- For features/tasks: analyze existing code structure, identify integration points, assess prerequisites
- For refactoring: identify code duplication, tight coupling, architectural issues
- All work items start as UNVALIDATED (they need validation later)
- Do NOT make claims without evidence in the codebase
- Investigate thoroughly before reporting`);

	// Critical: force JSON output
	parts.push(`## CRITICAL: Response Format Requirement

Your FINAL response MUST be a JSON array wrapped in a \`\`\`json code block.
Do NOT respond with a text summary. Do NOT respond with markdown prose.
After you finish investigating, output ONLY a \`\`\`json code block containing the array of work items.

If you found no issues, respond with:

\`\`\`json
[]
\`\`\`

Do NOT include any text before or after the JSON code block in your final response.`);

	return parts.join("\n\n");
}
