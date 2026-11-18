/** scan: read the code and list the work items worth doing. */

import { context, feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import type { Config, Issue } from "../types.ts";
import { log } from "../ui.ts";
import { generateId, parseJson, stripControl } from "../util.ts";

const DEFAULT_SCOPE = "Find the most important bugs and improvements.";
const MINUTE = 60_000;

type RawIssue = Pick<
	Issue,
	"type" | "title" | "rationale" | "severity" | "scope_impact" | "strategy"
>;

const ITEM_FIELDS = ["type", "title", "rationale", "severity", "scope_impact", "strategy"];

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
				required: ITEM_FIELDS,
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
} as const;

export function scanPrompt(scope: string, config: Config, lastError?: string): string {
	return prompt(
		role(
			"Lead Investigator",
			"You analyse this repository and list the work items worth doing: bugs, missing features, refactors, improvements. You can only read files.",
		),
		section("Focus", scope),
		context(config),
		section(
			"Task",
			[
				"Explore the code and report the most important work items for the focus above, most important first (at most 10).",
				"Every item must be specific, real and actionable. Name the files involved in the rationale.",
				"Fields: type, title, rationale (why, with file references), severity, scope_impact (areas affected), strategy (suggested approach).",
				"If nothing is worth doing, return an empty list.",
			].join("\n"),
		),
		feedback(lastError),
	);
}

export const scanPhase: PhaseDef<{ scope: string }, RawIssue[]> = {
	name: "scan",

	loadItems: (store) =>
		store.loadIssues().length > 0 ? [] : [{ scope: store.loadMeta().scope ?? DEFAULT_SCOPE }],

	label: () => "scan",

	async run(item, ctx) {
		const text = await ctx.ask(scanPrompt(item.scope, ctx.config, ctx.lastError), {
			schema: SCAN_SCHEMA,
			maxTurns: 100,
			timeoutMs: 15 * MINUTE,
		});
		const { items } = parseJson<{ items?: unknown }>(text, "Scan");
		if (!Array.isArray(items)) throw new Error("Scan: the response has no `items` list");
		return items
			.filter((i): i is RawIssue => typeof i?.title === "string" && i.title.trim() !== "")
			.map((i) => ({ ...i, title: stripControl(i.title.trim()) }));
	},

	record(_item, outcome, store) {
		if (!outcome.ok) return;
		const issues: Issue[] = outcome.value.map((raw) => ({
			...raw,
			id: generateId("P"),
			status: "UNVALIDATED",
			evidence: [],
		}));
		store.saveIssues(issues);
		if (issues.length === 0) log.info("scan found nothing to do");
		for (const issue of issues) log.info(`[${issue.severity}] ${issue.title}`);
	},
};
