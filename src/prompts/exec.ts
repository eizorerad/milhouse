/**
 * Exec prompt — Executor (EX)
 */

import type { Config, IssueGroup } from "../types.ts";
import { PromptBuilder } from "./base.ts";

export function buildExecPrompt(issueGroup: IssueGroup, config: Config): string {
	const { issue, tasks } = issueGroup;

	const sorted = [...tasks].sort((a, b) => a.parallel_group - b.parallel_group);
	const taskSections = sorted
		.map(
			(t, i) =>
				`### Task ${i + 1}: ${t.id}
**Title**: ${t.title}
${t.description ? `**Description**: ${t.description}` : ""}
**Files**: ${t.files.length > 0 ? t.files.map((f) => `\`${f}\``).join(", ") : "To be determined"}
**Deps**: ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "None"}
**Checks**: ${t.checks.length > 0 ? t.checks.map((c) => `\`${c}\``).join(", ") : "Run tests"}
**Acceptance**:
${t.acceptance.length > 0 ? t.acceptance.map((a) => `- [ ] ${a.description}`).join("\n") : "- All tests pass"}`,
		)
		.join("\n\n");

	return new PromptBuilder()
		.role(
			"Executor (EX)",
			`You are executing ALL tasks for a single issue as part of the Milhouse pipeline.\nComplete tasks in order, respecting dependencies. Commit after each task.\n\n⚠️ **CRITICAL**: Complete ALL ${tasks.length} task(s) in this session.`,
		)
		.projectContext(config)
		.commands(config)
		.rules(config)
		.issue(issue)
		.section("Tasks", `(${tasks.length})\n\n${taskSections}`)
		.raw(`## Protocol

1. For each task: implement → run checks → commit with "[${issue.id}] Task N: <task-id> <title>"
2. Keep changes minimal and focused
3. Do NOT add placeholder or unfinished code markers
4. Do NOT modify unrelated files
5. Use the exact task ID shown above for <task-id>
6. Complete ALL tasks before finishing`)
		.build();
}
