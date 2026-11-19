/** The agent: one `claude -p` process per call. The CLI reports its own cost in USD. */

import { run } from "./proc.ts";
import { extractJson, tail } from "./util.ts";

export interface AgentOptions {
	cwd: string;
	model?: string;
	/** JSON schema for the answer (structured output). */
	schema?: object;
	maxTurns?: number;
	timeoutMs: number;
	/** "read": Read/Grep/Glob only. "all": every built-in tool with permissions bypassed (exec only). */
	tools: "read" | "all";
	/** Cap for this single call in USD. The CLI stops after the turn that crosses it. */
	maxBudgetUsd?: number;
}

export interface AgentResult {
	text: string;
	costUsd: number;
}

export class EngineError extends Error {
	constructor(
		message: string,
		/** What the failed call cost. It is real money even though the call failed. */
		readonly costUsd = 0,
		/** Retrying cannot help (the per-call budget is used up). */
		readonly fatal = false,
	) {
		super(message);
		this.name = "EngineError";
	}
}

/** What a call that timed out is counted as: it cannot report its own cost. */
const UNKNOWN_COST_USD = 1;

export const claudeBinary = (): string => process.env.MILHOUSE_CLAUDE || "claude";

export function buildArgs(
	opts: Pick<AgentOptions, "model" | "schema" | "maxTurns" | "tools" | "maxBudgetUsd">,
): string[] {
	// --setting-sources user: the repository's own .claude/settings.json (hooks, env, API base URL) is
	// never loaded. -p skips the trust prompt, so a repository could otherwise run code in read-only phases.
	const args = [
		"-p",
		"--output-format",
		"json",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--no-session-persistence",
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
	if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
	if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", opts.maxBudgetUsd.toFixed(4));
	// --strict-mcp-config above: the user's MCP servers (mail, payments, ...) never reach an agent.
	args.push(
		...(opts.tools === "read" ? ["--tools", "Read,Grep,Glob"] : ["--dangerously-skip-permissions"]),
	);
	return args;
}

/** Agent commits must never wait for a signing prompt or a credential question. */
const agentEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	CI: "true",
	NO_COLOR: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "commit.gpgsign",
	GIT_CONFIG_VALUE_0: "false",
});

type ResultEvent = {
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	structured_output?: unknown;
	errors?: unknown;
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

export async function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
	const out = await run(claudeBinary(), buildArgs(opts), {
		cwd: opts.cwd,
		env: agentEnv(),
		input: prompt,
		timeoutMs: opts.timeoutMs,
		reap: true, // a dev server the agent started must not outlive its call
	});

	if (out.timedOut) {
		// The real cost is unknown. Count an estimate: nothing would hide the money, the whole allowance
		// (all that is left, for a sequential step) would stop the run for a call that may have cost little.
		throw new EngineError(
			`agent timed out after ${Math.round(opts.timeoutMs / 1000)}s (its cost is unknown, counted as an estimate)`,
			Math.min(opts.maxBudgetUsd ?? UNKNOWN_COST_USD, UNKNOWN_COST_USD),
		);
	}
	const result = parseResult(out.stdout);
	if (!result) {
		throw new EngineError(`claude exited with ${out.code} and no result. ${tail(out.stderr, 500)}`);
	}

	const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
	if (result.is_error === true || out.code !== 0) {
		const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
		const detail =
			[...errors, result.result].filter(Boolean).join("; ") ||
			tail(out.stderr, 500) ||
			String(result.subtype);
		throw new EngineError(
			`agent failed: ${detail}`,
			costUsd,
			result.subtype === "error_max_budget_usd",
		);
	}
	const text =
		result.structured_output !== undefined && result.structured_output !== null
			? JSON.stringify(result.structured_output)
			: String(result.result ?? "");
	return { text, costUsd };
}
