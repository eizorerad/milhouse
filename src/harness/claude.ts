/** Claude Code: one `claude -p` process per call. It reports its own cost in USD. */

import { extractJson, tail } from "../util.ts";
import {
	type AgentOptions,
	type AgentResult,
	EngineError,
	type Harness,
	USAGE_ERROR,
} from "./types.ts";

/** Logged out, out of credit or out of quota: no other call will do better. */
const SYSTEMIC =
	/not logged in|invalid api key|please run \/login|credit balance is too low|hit your limit|usage limit|issue with the selected model/i;

type ResultEvent = {
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	structured_output?: unknown;
	errors?: unknown;
	api_error_status?: unknown;
	total_cost_usd?: number;
};

function parseResult(stdout: string): ResultEvent | null {
	const json = extractJson(stdout);
	if (!json) return null;
	const parsed: unknown = JSON.parse(json);
	const events = Array.isArray(parsed) ? parsed : [parsed];
	const result = events.findLast((e) => e && typeof e === "object" && e.type === "result");
	return (result as ResultEvent | undefined) ?? null;
}

export const claude: Harness = {
	label: "Claude Code",
	installHint: "https://claude.com/claude-code",
	reportsCost: true,
	binary: () => process.env.MILHOUSE_CLAUDE || "claude",

	args(opts: AgentOptions): string[] {
		// --setting-sources user: the repository's own .claude/settings.json (hooks, env, API base URL) is
		// never loaded. -p skips the trust prompt, so a repository could otherwise run code in read-only phases.
		const args = [
			"-p",
			"--output-format",
			"json",
			"--setting-sources",
			"user",
			"--strict-mcp-config", // the user's MCP servers (mail, payments, ...) never reach an agent
			"--no-session-persistence",
			...(opts.extraArgs ?? []),
		];
		if (opts.model) args.push("--model", opts.model);
		if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
		if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
		if (opts.maxBudgetUsd !== undefined) {
			args.push("--max-budget-usd", opts.maxBudgetUsd.toFixed(4));
		}
		args.push(
			...(opts.tools === "read"
				? ["--tools", "Read,Grep,Glob"]
				: ["--dangerously-skip-permissions"]),
		);
		return args;
	},

	input: (prompt) => prompt,

	parse(out): AgentResult {
		const result = parseResult(out.stdout);
		if (!result) {
			throw new EngineError(
				`claude exited with ${out.code} and no result. ${tail(out.stderr, 500)}`,
				{ systemic: USAGE_ERROR.test(out.stderr) || SYSTEMIC.test(out.stderr) },
			);
		}
		const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
		if (result.is_error === true || out.code !== 0) {
			const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
			const detail =
				[...errors, result.result].filter(Boolean).join("; ") ||
				tail(out.stderr, 500) ||
				String(result.subtype);
			throw new EngineError(`agent failed: ${detail}`, {
				costUsd,
				fatal: result.subtype === "error_max_budget_usd",
				systemic:
					SYSTEMIC.test(detail) || [401, 403, 404].includes(Number(result.api_error_status)),
			});
		}
		const text =
			result.structured_output !== undefined && result.structured_output !== null
				? JSON.stringify(result.structured_output)
				: String(result.result ?? "");
		return { text, costUsd };
	},
};
