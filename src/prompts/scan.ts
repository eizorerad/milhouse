/**
 * Scan prompt — Lead Investigator (LI)
 */

import type { Config } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildScanPrompt(scope: string, config: Config): string {
	return new PromptBuilder()
		.role(
			"Lead Investigator (LI)",
			"You are analyzing this repository to identify work items. Work items can be bugs, features, refactoring opportunities, improvements, or general tasks.",
		)
		.section("Focus", scope)
		.projectContext(config)
		.rules(config)
		.raw(`## Task

Analyze the repository and identify work items. For each:
1. **Type**: bug | feature | refactor | improvement | task
2. **Title**: Clear, concise title
3. **Rationale**: Why this work is needed
4. **Severity**: CRITICAL | HIGH | MEDIUM | LOW
5. **Scope Impact**: What areas are affected (optional)
6. **Strategy**: Suggested approach (optional)`)
		.jsonOutput(`[
  {
    "type": "bug",
    "title": "Clear title",
    "rationale": "Why this is needed",
    "severity": "HIGH",
    "scope_impact": "Areas affected",
    "strategy": "Suggested approach"
  }
]`)
		.raw(`## Guidelines

- **DO NOT run any commands.** Only read source files.
- Focus on real, actionable work items
- Be specific about file locations
- If no issues found, return \`[]\`

## CRITICAL

Your FINAL response MUST be a JSON array in a \`\`\`json code block. Nothing else.`)
		.build();
}

export const SCAN_SCHEMA = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["bug", "feature", "refactor", "improvement", "task"] },
					title: { type: "string" },
					rationale: { type: "string" },
					severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
					scope_impact: { type: "string" },
					strategy: { type: "string" },
				},
				required: ["type", "title", "rationale", "severity", "scope_impact", "strategy"],
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
} as const;
