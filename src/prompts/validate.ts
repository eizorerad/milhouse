/**
 * Validate prompt — Issue Validator (IV)
 */

import type { Issue } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildValidatePrompt(issue: Issue): string {
	return new PromptBuilder()
		.role(
			"Work Item Validator (IV)",
			`You are validating a work item (type: ${issue.type}) with concrete evidence from the codebase.`,
		)
		.issue(issue)
		.evidence(issue.evidence)
		.raw(`## Task

1. Search for evidence in the codebase (file:line references)
2. Determine the status:
   - **CONFIRMED**: Valid and actionable with evidence
   - **FALSE**: Not valid or not needed
   - **PARTIAL**: Valid but scope/severity differs
   - **MISDIAGNOSED**: Valid need but different approach recommended`)
		.jsonOutput(`{
  "issue_id": "${issue.id}",
  "status": "CONFIRMED|FALSE|PARTIAL|MISDIAGNOSED",
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "Brief summary",
  "corrected_description": "Only if PARTIAL or MISDIAGNOSED",
  "evidence": [
    { "type": "file", "file": "path.ts", "line_start": 42, "line_end": 50, "output": "snippet", "timestamp": "${new Date().toISOString()}" }
  ]
}`)
		.raw(`## Guidelines

- **DO NOT run any commands.** Only read files.
- Provide at least ONE evidence for non-FALSE status
- Limit to 3-5 file reads max
- If evidence is clear from 1-2 files, respond immediately`)
		.build();
}

export const VALIDATE_SCHEMA = {
	type: "object",
	properties: {
		issue_id: { type: "string" },
		status: { type: "string", enum: ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] },
		confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
		summary: { type: "string" },
		corrected_description: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["file", "log", "command"] },
					file: { type: "string" },
					line_start: { type: "number" },
					line_end: { type: "number" },
					output: { type: "string" },
					timestamp: { type: "string" },
				},
				required: ["type", "file", "line_start", "line_end", "output", "timestamp"],
				additionalProperties: false,
			},
		},
	},
	required: ["issue_id", "status", "confidence", "summary", "corrected_description", "evidence"],
	additionalProperties: false,
} as const;
