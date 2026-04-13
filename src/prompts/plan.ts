/**
 * Plan prompt — Planner (PL)
 */

import type { Issue } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildPlanPrompt(issue: Issue): string {
	return new PromptBuilder()
		.role(
			"Planner (PL)",
			`You are creating a Work Breakdown Structure (WBS) for a validated work item (type: ${issue.type}).`,
		)
		.issue(issue)
		.evidence(issue.evidence)
		.raw(`## Task

Create a WBS with small, testable tasks. Each task should be:
1. Completable in one commit
2. Testable with clear acceptance criteria
3. Independent where possible
4. Ordered via depends_on`)
		.jsonOutput(`{
  "issue_id": "${issue.id}",
  "summary": "Implementation approach",
  "tasks": [
    {
      "title": "Short title",
      "description": "What to do",
      "files": ["path/to/file.ts"],
      "depends_on": [],
      "checks": ["npm test"],
      "acceptance": [{ "description": "Test passes", "check_command": "npm test" }],
      "risk": "Low",
      "rollback": "Revert commit",
      "parallel_group": 0
    }
  ]
}`)
		.raw(`## Guidelines

- **DO NOT run commands.** Only read files.
- 2-8 tasks per issue
- Each task = one logical unit of work
- All files that will be modified must be listed`)
		.build();
}

export const PLAN_SCHEMA = {
	type: "object",
	properties: {
		issue_id: { type: "string" },
		summary: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					files: { type: "array", items: { type: "string" } },
					depends_on: { type: "array", items: { type: "string" } },
					checks: { type: "array", items: { type: "string" } },
					acceptance: {
						type: "array",
						items: {
							type: "object",
							properties: {
								description: { type: "string" },
								check_command: { type: "string" },
							},
							required: ["description", "check_command"],
							additionalProperties: false,
						},
					},
					risk: { type: "string" },
					rollback: { type: "string" },
					parallel_group: { type: "number" },
				},
				required: [
					"title",
					"description",
					"files",
					"depends_on",
					"checks",
					"acceptance",
					"risk",
					"rollback",
					"parallel_group",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["issue_id", "summary", "tasks"],
	additionalProperties: false,
} as const;
