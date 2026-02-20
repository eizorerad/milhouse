/**
 * Prompt builder for the validate phase (Issue Validator agent)
 *
 * Builds a prompt that instructs the AI to deeply validate a single
 * work item with concrete evidence from the codebase.
 */

import type { PhaseContext } from "../../runner/types.ts";
import {
	AGENT_ROLES,
	type Issue,
	getWorkItemRationale,
	getWorkItemTitle,
} from "../../state/types.ts";

/**
 * Build the validation prompt for a single issue.
 *
 * @param issue - The issue to validate
 * @param ctx - Phase context
 * @returns Full prompt string
 */
export function buildValidatePrompt(issue: Issue, _ctx: PhaseContext): string {
	const parts: string[] = [];
	const itemType = issue.type ?? "bug";

	// Role
	parts.push(`## Role: Work Item Validator (IV)
${AGENT_ROLES.IV}

You are validating a specific work item (type: ${itemType}) identified by the Lead Investigator. Your task is to validate this work item with concrete evidence.`);

	// Work item details
	const issueDetails = [
		`**ID**: ${issue.id}`,
		`**Type**: ${itemType}`,
		`**Title**: ${getWorkItemTitle(issue)}`,
		`**Rationale**: ${getWorkItemRationale(issue)}`,
		`**Severity**: ${issue.severity}`,
	];

	if (issue.scope_impact) issueDetails.push(`**Scope Impact**: ${issue.scope_impact}`);
	if (issue.frequency) issueDetails.push(`**Frequency**: ${issue.frequency}`);
	if (issue.blast_radius) issueDetails.push(`**Blast Radius**: ${issue.blast_radius}`);
	if (issue.strategy) issueDetails.push(`**Strategy**: ${issue.strategy}`);

	parts.push(`## Work Item to Validate\n${issueDetails.join("\n")}`);

	// Existing evidence
	if (issue.evidence.length > 0) {
		const evidenceList = issue.evidence
			.map((ev) => {
				if (ev.type === "file" && ev.file)
					return `- File: ${ev.file}${ev.line_start ? `:${ev.line_start}` : ""}`;
				if (ev.type === "command" && ev.command) return `- Command: ${ev.command}`;
				if (ev.type === "probe" && ev.probe_id) return `- Probe: ${ev.probe_id}`;
				return `- ${ev.type}`;
			})
			.join("\n");
		parts.push(`## Existing Evidence\n${evidenceList}`);
	}

	// Task
	parts.push(`## Task

Investigate this work item thoroughly and determine its validity.

1. Search for evidence in the codebase (file:line references)
2. Run any necessary probes or checks to verify claims
3. Determine the status:
   - **CONFIRMED**: Work item is valid and actionable with evidence
   - **FALSE**: Work item is not valid or not needed
   - **PARTIAL**: Work item is valid but scope/severity/priority differs
   - **MISDIAGNOSED**: Valid need exists but a different approach is recommended`);

	// Output format
	const timestamp = new Date().toISOString();
	parts.push(`## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "status": "CONFIRMED|FALSE|PARTIAL|MISDIAGNOSED",
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "Brief summary of findings",
  "corrected_description": "Only if PARTIAL or MISDIAGNOSED - describe the actual issue",
  "evidence": [
    {
      "type": "file|probe|log|command",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 50,
      "output": "Relevant output or code snippet",
      "timestamp": "${timestamp}"
    }
  ]
}
\`\`\``);

	// Guidelines
	parts.push(`## Guidelines

- Provide at least ONE piece of evidence for any non-FALSE status
- For FALSE status, explain why the issue doesn't exist
- Be specific about file paths and line numbers
- Run actual commands if needed to verify (e.g., run tests, check configs)
- Do NOT claim evidence without actual file references
- If the hypothesis is wrong but there's a related real issue, mark as MISDIAGNOSED
- Include the corrected_description for PARTIAL or MISDIAGNOSED issues
- All evidence must have timestamps`);

	return parts.join("\n\n");
}
