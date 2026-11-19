/** validate: check each finding against the code. A verdict other than FALSE needs evidence that exists. */

import { verifyEvidence } from "../gates.ts";
import { context, describeIssue, feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import type { Config, Evidence, Issue, IssueStatus } from "../types.ts";
import { MINUTE, parseJson } from "../util.ts";

const VERDICTS = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] as const;

export interface Verdict {
	status: (typeof VERDICTS)[number];
	corrected_description: string;
	evidence: Evidence[];
}

const VALIDATE_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: VERDICTS },
		summary: { type: "string" },
		corrected_description: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					line_start: { type: "number" },
					line_end: { type: "number" },
					snippet: { type: "string" },
				},
				required: ["file", "line_start", "line_end", "snippet"],
				additionalProperties: false,
			},
		},
	},
	required: ["status", "summary", "corrected_description", "evidence"],
	additionalProperties: false,
} as const;

function validatePrompt(issue: Issue, config: Config, lastError?: string): string {
	return prompt(
		role(
			"Issue Validator",
			"You check one reported work item against the actual code. You can only read files.",
		),
		describeIssue(issue),
		context(config),
		section(
			"Task",
			[
				"Look for evidence in the code and decide the status:",
				"- CONFIRMED: real and actionable as described",
				"- FALSE: not real, or not needed",
				"- PARTIAL: real, but scope or severity differ (describe the correct scope in corrected_description)",
				"- MISDIAGNOSED: the need is real, but the cause or the right approach differs (say so in corrected_description)",
				"",
				"Every status except FALSE needs at least one evidence entry: the file, the line range and a verbatim snippet copied from those lines.",
				"Milhouse opens every cited file and checks the lines and the snippet, so cite only what you have read.",
			].join("\n"),
		),
		feedback(lastError),
	);
}

export const validatePhase: PhaseDef<Issue, Verdict> = {
	name: "validate",

	loadItems: (store) => store.loadIssues().filter((i) => i.status === "UNVALIDATED"),

	label: (issue) => issue.title.slice(0, 50),

	async run(issue, ctx) {
		const text = await ctx.ask(validatePrompt(issue, ctx.config, ctx.lastError), {
			schema: VALIDATE_SCHEMA,
			maxTurns: 30,
			timeoutMs: 5 * MINUTE,
		});
		const verdict = parseJson<Verdict>(text, "Validate");
		if (!VERDICTS.includes(verdict.status))
			throw new Error(`Validate: unknown status "${verdict.status}"`);
		if (verdict.status === "FALSE") return { ...verdict, evidence: [] };

		const cited = Array.isArray(verdict.evidence) ? verdict.evidence : [];
		if (!ctx.config.gates.evidence) return { ...verdict, evidence: cited };
		const evidence = verifyEvidence(ctx.store.workDir, cited);
		if (evidence.length === 0) {
			throw new Error(
				"Validate: none of the cited evidence holds up (file missing, lines out of range or snippet not found). Cite real files, line ranges and verbatim snippets.",
			);
		}
		return { ...verdict, evidence };
	},

	record(issue, outcome, store) {
		if (!outcome.ok) return; // stays UNVALIDATED and is retried on --resume
		const status: IssueStatus = outcome.value.status;
		store.updateIssue(issue.id, {
			status,
			corrected_description: outcome.value.corrected_description || undefined,
			evidence: outcome.value.evidence,
		});
	},
};
