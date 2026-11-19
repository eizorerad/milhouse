/** scan: read the code and list the work items worth doing. */

import { context, feedback, prompt, role, section } from "../prompts.ts";
import type { PhaseDef } from "../runner.ts";
import { arrayOf, object } from "../schema.ts";
import type { Config, Issue } from "../types.ts";
import { log } from "../ui.ts";
import { MINUTE, generateId, parseJson, stripControl } from "../util.ts";

const DEFAULT_SCOPE = "Find the most important bugs and improvements.";

type RawIssue = Pick<
	Issue,
	"type" | "title" | "rationale" | "severity" | "scope_impact" | "strategy"
>;

const TYPES: Issue["type"][] = ["bug", "feature", "refactor", "improvement", "task"];
const SEVERITIES: Issue["severity"][] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
/** The prompt asks for at most 10; this only keeps a runaway answer from flooding the later phases. */
const MAX_ITEMS = 10;

const SCAN_SCHEMA = object({
	items: arrayOf(
		object({
			type: { type: "string", enum: TYPES },
			title: { type: "string" },
			rationale: { type: "string" },
			severity: { type: "string", enum: SEVERITIES },
			scope_impact: { type: "string" },
			strategy: { type: "string" },
		}),
	),
});

function scanPrompt(scope: string, config: Config, lastError?: string): string {
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

/** The scanner's work items. What a model left out or spelled differently is repaired; items without a title are dropped. */
export function parseItems(text: string): RawIssue[] {
	const { items } = parseJson<{ items?: unknown }>(text, "Scan");
	if (!Array.isArray(items)) throw new Error("Scan: the response has no `items` list");
	const str = (value: unknown): string =>
		typeof value === "string" ? stripControl(value.trim()) : "";
	return items
		.filter((item) => typeof item?.title === "string" && item.title.trim() !== "")
		.slice(0, MAX_ITEMS)
		.map((item) => {
			const type = str(item.type).toLowerCase() as Issue["type"];
			const severity = str(item.severity).toUpperCase() as Issue["severity"];
			return {
				type: TYPES.includes(type) ? type : "task",
				title: str(item.title),
				rationale: str(item.rationale),
				severity: SEVERITIES.includes(severity) ? severity : "MEDIUM",
				scope_impact: str(item.scope_impact),
				strategy: str(item.strategy),
			};
		});
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
		return parseItems(text);
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
