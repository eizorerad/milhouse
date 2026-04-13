/**
 * Consolidate prompt — Consistency & Dependency Manager (CDM)
 */

import type { Issue, Task } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildConsolidatePrompt(tasks: Task[], issues: Issue[]): string {
	const issueList = issues
		.map((i) => `- **${i.id}** [${i.status}]: ${i.title} (${i.severity})`)
		.join("\n");
	const taskList = tasks
		.map(
			(t) =>
				`### ${t.id}: ${t.title}\n- Issue: ${t.issue_id} | Files: ${t.files.join(", ") || "none"} | Deps: ${t.depends_on.join(", ") || "none"} | Group: ${t.parallel_group}`,
		)
		.join("\n\n");

	return new PromptBuilder()
		.role(
			"Consistency & Dependency Manager (CDM)",
			"You are consolidating multiple WBS plans into a unified Execution Plan.",
		)
		.section("Issues", `(${issues.length})\n\n${issueList}`)
		.section("Tasks", `(${tasks.length})\n\n${taskList}`)
		.raw(`## Task

1. Find duplicate tasks (same files, same goals)
2. Add cross-issue dependencies (shared files = must serialize)
3. Optimize parallel groups
4. Provide execution order

**CRITICAL**: If two issues modify the same file, add a cross_dependency to serialize them (prevent merge conflicts).`)
		.jsonOutput(`{
  "duplicates": [
    { "keep": "TASK_ID", "remove": ["TASK_IDs"], "reason": "Why" }
  ],
  "cross_dependencies": [
    { "task_id": "TASK_ID", "depends_on": ["OTHER_TASK_IDs"], "reason": "Why" }
  ],
  "parallel_groups": [
    { "group": 0, "task_ids": ["IDs"] }
  ],
  "execution_order": ["Ordered task IDs"]
}`)
		.build();
}

export const CONSOLIDATE_SCHEMA = {
	type: "object",
	properties: {
		duplicates: {
			type: "array",
			items: {
				type: "object",
				properties: {
					keep: { type: "string" },
					remove: { type: "array", items: { type: "string" } },
					reason: { type: "string" },
				},
				required: ["keep", "remove", "reason"],
				additionalProperties: false,
			},
		},
		cross_dependencies: {
			type: "array",
			items: {
				type: "object",
				properties: {
					task_id: { type: "string" },
					depends_on: { type: "array", items: { type: "string" } },
					reason: { type: "string" },
				},
				required: ["task_id", "depends_on", "reason"],
				additionalProperties: false,
			},
		},
		parallel_groups: {
			type: "array",
			items: {
				type: "object",
				properties: {
					group: { type: "number" },
					task_ids: { type: "array", items: { type: "string" } },
				},
				required: ["group", "task_ids"],
				additionalProperties: false,
			},
		},
		execution_order: { type: "array", items: { type: "string" } },
	},
	required: ["duplicates", "cross_dependencies", "parallel_groups", "execution_order"],
	additionalProperties: false,
} as const;
