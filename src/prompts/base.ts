/**
 * PromptBuilder — DRY helper for building phase prompts.
 * Shared patterns: role header, autonomous mode warning, project context,
 * rules, output format instructions.
 */

import type { Config, Evidence, Issue } from "../types.ts";

export class PromptBuilder {
	private parts: string[] = [];

	/** Add a role header with autonomous mode warning. */
	role(name: string, description: string): this {
		this.parts.push(
			`## Role: ${name}\n${description}\n\n⚠️ **AUTONOMOUS MODE**: Do NOT ask questions. Make the best decision based on the codebase. If uncertain, choose the most conservative option.`,
		);
		return this;
	}

	/** Add a section with title and content. */
	section(title: string, content: string): this {
		if (content.trim()) {
			this.parts.push(`## ${title}\n${content}`);
		}
		return this;
	}

	/** Add project context from config. */
	projectContext(config: Config): this {
		const ctx = [config.project.name, config.project.language, config.project.framework]
			.filter(Boolean)
			.join(", ");
		if (ctx) this.parts.push(`## Project\n${ctx}`);
		return this;
	}

	/** Add project commands from config. */
	commands(config: Config): this {
		const cmds = [
			config.commands.test && `Test: ${config.commands.test}`,
			config.commands.lint && `Lint: ${config.commands.lint}`,
			config.commands.build && `Build: ${config.commands.build}`,
		].filter(Boolean);
		if (cmds.length > 0) this.parts.push(`## Commands\n${cmds.join("\n")}`);
		return this;
	}

	/** Add rules from config. */
	rules(config: Config): this {
		if (config.rules.length > 0) {
			this.parts.push(`## Rules\n${config.rules.map((r) => `- ${r}`).join("\n")}`);
		}
		return this;
	}

	/** Add issue details. */
	issue(issue: Issue): this {
		const lines = [
			`**ID**: ${issue.id}`,
			`**Type**: ${issue.type}`,
			`**Title**: ${issue.title}`,
			`**Rationale**: ${issue.rationale}`,
			`**Severity**: ${issue.severity}`,
			issue.status ? `**Status**: ${issue.status}` : "",
			issue.corrected_description ? `**Corrected**: ${issue.corrected_description}` : "",
			issue.scope_impact ? `**Scope Impact**: ${issue.scope_impact}` : "",
			issue.strategy ? `**Strategy**: ${issue.strategy}` : "",
		].filter(Boolean);
		this.parts.push(`## Issue\n${lines.join("\n")}`);
		return this;
	}

	/** Add evidence list. */
	evidence(evidence: Evidence[]): this {
		if (evidence.length === 0) return this;
		const evList = evidence
			.map((e) =>
				e.type === "file" && e.file
					? `- \`${e.file}\`${e.line_start ? `:${e.line_start}` : ""}`
					: e.type === "command" && e.output
						? `- Command output: ${e.output}`
						: `- ${e.type}`,
			)
			.join("\n");
		this.parts.push(`## Evidence\n${evList}`);
		return this;
	}

	/** Add JSON output format instruction with example. */
	jsonOutput(example: string): this {
		this.parts.push(`## Output Format\n\n\`\`\`json\n${example}\n\`\`\``);
		return this;
	}

	/** Add raw text block. */
	raw(text: string): this {
		this.parts.push(text);
		return this;
	}

	/** Build the final prompt string. */
	build(): string {
		return this.parts.join("\n\n");
	}
}
