/** Building blocks shared by the phase prompts. */

import type { Config, Issue } from "./types.ts";

export function section(title: string, body: string): string {
	return body.trim() ? `## ${title}\n${body.trim()}` : "";
}

export function role(name: string, description: string): string {
	return `## Role: ${name}\n${description}\n\nWork autonomously: never ask questions. When unsure, choose the most conservative option.`;
}

/** Join the non-empty parts into a prompt. */
export const prompt = (...parts: string[]): string => parts.filter(Boolean).join("\n\n");

/** What went wrong in the previous attempt, so the agent can fix it. Empty on the first attempt. */
export const feedback = (lastError?: string): string =>
	lastError
		? section("The previous attempt failed", `${lastError}\n\nFix this and try again.`)
		: "";

/** Project info, commands, rules and forbidden paths from the config. */
export function context(config: Config): string {
	const { project, commands, rules, neverTouch } = config;
	const about = [project.name, project.language, project.framework].filter(Boolean).join(", ");
	const cmds = Object.entries(commands)
		.filter(([, command]) => command)
		.map(([name, command]) => `- ${name}: \`${command}\``);
	return prompt(
		section("Project", [about, project.description].filter(Boolean).join("\n")),
		section("Commands", cmds.join("\n")),
		section("Rules", rules.map((rule) => `- ${rule}`).join("\n")),
		section("Never modify", neverTouch.map((glob) => `- \`${glob}\``).join("\n")),
	);
}

export function describeIssue(issue: Issue): string {
	const fields = [
		`**ID**: ${issue.id}`,
		`**Type**: ${issue.type}`,
		`**Title**: ${issue.title}`,
		`**Severity**: ${issue.severity}`,
		`**Rationale**: ${issue.rationale}`,
		issue.corrected_description && `**Corrected description**: ${issue.corrected_description}`,
		issue.scope_impact && `**Scope impact**: ${issue.scope_impact}`,
		issue.strategy && `**Suggested strategy**: ${issue.strategy}`,
	];
	const evidence = issue.evidence
		.map((e) => `- \`${e.file}:${e.line_start}-${e.line_end}\``)
		.join("\n");
	return prompt(section("Issue", fields.filter(Boolean).join("\n")), section("Evidence", evidence));
}
