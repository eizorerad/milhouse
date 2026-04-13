/**
 * Verify prompt — Truth Verifier (TV)
 */

import type { Task } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildVerifyPrompt(task: Task): string {
	const builder = new PromptBuilder()
		.role(
			"Truth Verifier (TV)",
			"You are verifying ONE task's execution results.",
		)
		.section("Task to Verify", [
			`**ID**: ${task.id}`,
			`**Title**: ${task.title}`,
			task.issue_id ? `**Issue**: ${task.issue_id}` : "",
			task.description ? `**Description**: ${task.description}` : "",
		].filter(Boolean).join("\n"));

	if (task.files.length > 0) {
		builder.section("Files", task.files.map(f => `- \`${f}\``).join("\n"));
	}

	if (task.acceptance.length > 0) {
		builder.section(
			"Acceptance Criteria",
			task.acceptance.map(a =>
				`- [ ] ${a.description}${a.check_command ? ` (\`${a.check_command}\`)` : ""}`,
			).join("\n"),
		);
	}

	if (task.checks.length > 0) {
		builder.section("Verification Commands", task.checks.map(c => `- \`${c}\``).join("\n"));
	}

	return builder
		.raw(`## Steps

1. Run \`git log --oneline --all --grep="${task.id}"\` to find the task commit
2. If nothing matches, run \`git log --oneline --all --grep="[${task.issue_id}] Task"\` and identify the right commit by task title "${task.title}"
3. \`git show <commit>\` to review changes
4. Run verification commands
5. Check for TODO/FIXME/placeholder in modified files
6. Confirm acceptance criteria`)
		.jsonOutput(`{
  "overall_pass": true,
  "gates": [
    { "gate": "evidence|diffHygiene|placeholder|dod", "passed": true, "message": "Details" }
  ],
  "recommendations": [],
  "regressions_found": false,
  "summary": "Brief summary"
}`)
		.raw("Be fast and focused. Limited turn budget.")
		.build();
}

export const VERIFY_SCHEMA = {
	type: "object",
	properties: {
		overall_pass: { type: "boolean" },
		gates: {
			type: "array",
			items: {
				type: "object",
				properties: {
					gate: { type: "string" },
					passed: { type: "boolean" },
					message: { type: "string" },
				},
				required: ["gate", "passed", "message"],
				additionalProperties: false,
			},
		},
		recommendations: { type: "array", items: { type: "string" } },
		regressions_found: { type: "boolean" },
		summary: { type: "string" },
	},
	required: ["overall_pass", "gates", "recommendations", "regressions_found", "summary"],
	additionalProperties: false,
} as const;
