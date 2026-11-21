/** validate: check each finding against the code. A verdict other than FALSE needs evidence that exists. */

import { MAX_CITED_LINES, verifyEvidence } from "../gates.ts";
import { context, describeIssue, feedback, prompt, role, section } from "../prompts.ts";
import type { Ctx, PhaseDef } from "../runner.ts";
import { arrayOf, object } from "../schema.ts";
import type { Evidence, Issue } from "../types.ts";
import { parseJson, stripControl } from "../util.ts";

const VERDICTS = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] as const;

export interface Verdict {
	status: (typeof VERDICTS)[number];
	summary: string;
	corrected_description: string;
	evidence: Evidence[];
}

const VALIDATE_SCHEMA = object({
	status: { type: "string", enum: VERDICTS },
	summary: { type: "string" },
	corrected_description: { type: "string" },
	evidence: arrayOf(
		object({
			file: { type: "string" },
			line_start: { type: "number" },
			line_end: { type: "number" },
			snippet: { type: "string" },
		}),
	),
});

function validatePrompt(issue: Issue, { store, config, lastError }: Ctx): string {
	return prompt(
		role(
			"Issue Validator",
			"You check one reported work item against the actual code. You can only read files.",
		),
		section("Focus", store.loadMeta().scope ?? ""),
		describeIssue(issue),
		context(config),
		section(
			"Task",
			[
				"Look for evidence in the code and decide the status:",
				"- CONFIRMED: real and actionable as described",
				"- FALSE: not real, not needed, or unrelated to the requested focus",
				"- PARTIAL: real, but scope or severity differ (describe the correct scope in corrected_description)",
				"- MISDIAGNOSED: the need is real, but the cause or the right approach differs (say so in corrected_description)",
				"",
				"Give the reason in one short sentence in summary.",
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
	resultNote: ({ status, summary }) =>
		`${status}: ${summary.replace(/\s+/g, " ").trim().slice(0, 160)}`,

	async run(issue, ctx) {
		const text = await ctx.ask(validatePrompt(issue, ctx), {
			schema: VALIDATE_SCHEMA,
			maxTurns: 30,
		});
		const verdict = parseJson<Verdict>(text, "Validate");
		if (!VERDICTS.includes(verdict.status))
			throw new Error(`Validate: unknown status "${verdict.status}"`);
		if (typeof verdict.summary !== "string" || !verdict.summary.trim())
			throw new Error("Validate: give a short reason for the verdict in summary");
		if (verdict.status === "FALSE") return { ...verdict, evidence: [] };

		const cited = Array.isArray(verdict.evidence) ? verdict.evidence : [];
		if (!ctx.config.gates.evidence) return { ...verdict, evidence: cited };
		const evidence = verifyEvidence(ctx.store.worktree, cited);
		if (evidence.length === 0) {
			throw new Error(
				`Validate: none of the cited evidence holds up (file missing, lines out of range, a range of more than ${MAX_CITED_LINES} lines or snippet not found). Cite real files, line ranges and verbatim snippets.`,
			);
		}
		return { ...verdict, evidence };
	},

	record(issue, outcome, store) {
		if (!outcome.ok) return; // stays UNVALIDATED and is retried on --resume
		store.updateIssue(issue.id, {
			status: outcome.value.status,
			corrected_description: outcome.value.corrected_description || undefined,
			verdict_reason: stripControl(outcome.value.summary.trim()).slice(0, 300),
			evidence: outcome.value.evidence,
		});
	},
};
