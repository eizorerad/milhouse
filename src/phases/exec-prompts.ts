/** What the executor and the reviewer are told. */

import { context, describeIssue, feedback, prompt, role, section } from "../prompts.ts";
import type { Config, Task } from "../types.ts";
import type { IssueGroup } from "./exec-order.ts";

const MAX_PATCH_CHARS = 100_000;

export const bullets = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

function taskBlock(task: Task): string {
	return [
		`### [${task.id}] ${task.title}`,
		task.description,
		task.files.length > 0 && `Files: ${task.files.map((f) => `\`${f}\``).join(", ")}`,
		task.depends_on.length > 0 && `Depends on: ${task.depends_on.join(", ")}`,
		task.checks.length > 0 && `Checks: ${task.checks.map((c) => `\`${c}\``).join(", ")}`,
		task.acceptance.length > 0 && `Acceptance:\n${bullets(task.acceptance)}`,
	]
		.filter(Boolean)
		.join("\n");
}

export function execPrompt(
	group: IssueGroup,
	done: Task[],
	config: Config,
	lastError?: string,
): string {
	const doneIds = new Set(done.map((t) => t.id));
	const remaining = group.tasks.filter((t) => !doneIds.has(t.id));
	return prompt(
		role(
			"Executor",
			"You implement one work item as a series of small commits in a git worktree. The work of earlier issues is already here.",
		),
		describeIssue(group.issue),
		context(config),
		section(
			"Tasks to do, in this order",
			remaining.length > 0
				? remaining.map(taskBlock).join("\n\n")
				: "Every task is committed already. Only the problem below remains.",
		),
		section("Already committed (do not redo)", bullets(done.map((t) => `[${t.id}] ${t.title}`))),
		feedback(lastError),
		section(
			"Protocol",
			[
				"1. Do the tasks in the order above. For each task: implement it, run its checks, commit.",
				"2. The commit subject must be exactly `[<task id>] <task title>`, e.g. `[T-abc123] Add input validation`, whatever commit message a task description suggests. Milhouse tracks progress by these subjects: one commit per task. Fixes go in new commits with the id of the task they belong to. If a git hook rejects a commit (a commit-message rule, say), commit with `--no-verify`: Milhouse runs the project's checks itself.",
				"3. Keep changes minimal and focused. Do not touch unrelated files, and never the `.milhouse/` directory. No TODO/FIXME or placeholder code.",
				"4. Do not create or switch branches and do not push. HEAD is detached on purpose: just commit.",
				"5. Finish with a clean worktree: everything committed, no stray files.",
			].join("\n"),
		),
	);
}

export const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					task_id: { type: "string" },
					passed: { type: "boolean" },
					reason: { type: "string" },
				},
				required: ["task_id", "passed", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["summary", "tasks"],
	additionalProperties: false,
} as const;

export function reviewPrompt(
	group: IssueGroup,
	stat: string,
	patch: string,
	config: Config,
): string {
	const truncated = patch.length > MAX_PATCH_CHARS;
	return prompt(
		role(
			"Truth Verifier",
			"You review the changes made for one work item. You can read files but not run commands: Milhouse already ran the project's checks and they passed.",
		),
		describeIssue(group.issue),
		context(config),
		section("Tasks to verify", group.tasks.map(taskBlock).join("\n\n")),
		section("Changed files", stat),
		section(
			truncated ? "Patch (truncated: read the changed files for the rest)" : "Patch",
			`\`\`\`diff\n${truncated ? patch.slice(0, MAX_PATCH_CHARS) : patch}\n\`\`\``,
		),
		section(
			"Task",
			[
				"For every task decide whether the changes fulfil its description and acceptance criteria. Judge the substance, against the final state of the issue (all its tasks together).",
				"A task fails when its behaviour or tests are missing or wrong, when the change is empty, a stub or a placeholder, or when it changes unrelated behaviour.",
				"Do not fail a task for: commit subjects or messages (Milhouse sets them), the order or number of commits, cosmetic differences from the wording of the description, or criteria about process you cannot observe (which commands were run, what was staged).",
				"Read the changed files when the patch is not enough. Return exactly one verdict per task id above, with a short reason.",
			].join("\n"),
		),
	);
}
