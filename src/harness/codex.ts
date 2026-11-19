/**
 * Codex CLI: one `codex exec` process per call. It reports tokens, not dollars.
 *
 * The user's own Codex configuration (provider, model, MCP servers, plugins) applies as it is: it cannot be
 * switched off robustly, and a custom provider would stop working without it. `harnessArgs.codex` can add
 * flags such as `-p <profile>` or `--ignore-user-config`.
 */

import { tail } from "../util.ts";
import { type AgentOptions, type AgentResult, EngineError, type Harness } from "./types.ts";

/** A bad login, an unknown model or deployment, a spent quota: the same for every call. */
const SYSTEMIC =
	/unexpected status (401|403|404)\b|not logged in|missing bearer|invalid api key|incorrect api key|usage limit/i;

type Event = {
	type?: string;
	message?: unknown;
	error?: { message?: unknown };
	item?: { type?: string; text?: unknown };
	usage?: { input_tokens?: unknown; output_tokens?: unknown };
};

/** The JSON lines of Codex's event stream; anything else is ignored. */
function events(stdout: string): Event[] {
	return stdout.split("\n").flatMap((line) => {
		try {
			const parsed: unknown = JSON.parse(line);
			return parsed && typeof parsed === "object" ? [parsed as Event] : [];
		} catch {
			return [];
		}
	});
}

const count = (value: unknown): number => (typeof value === "number" ? value : 0);

export const codex: Harness = {
	label: "Codex",
	installHint: "https://github.com/openai/codex",
	reportsCost: false,
	binary: () => process.env.MILHOUSE_CODEX || "codex",

	args(opts: AgentOptions): string[] {
		return [
			"exec",
			...(opts.extraArgs ?? []),
			"--json",
			"--ephemeral",
			"-C",
			opts.cwd,
			...(opts.model ? ["-m", opts.model] : []),
			// Read-only steps run in Codex's read-only sandbox. exec has to commit inside a linked worktree,
			// which the workspace sandbox does not allow: the same trust as Claude's bypassed permissions.
			...(opts.tools === "read"
				? ["-s", "read-only"]
				: ["--dangerously-bypass-approvals-and-sandbox"]),
			"-", // the prompt comes from stdin
		];
	},

	/** Codex cannot enforce a schema for every provider, so the answer's shape is asked for in the prompt. */
	input: (prompt, opts) =>
		opts.schema
			? `${prompt}\n\n## Answer format\nYour final message must be one JSON object that matches this JSON Schema. Output only the JSON: no prose, no code fences.\n${JSON.stringify(opts.schema)}`
			: prompt,

	parse(out): AgentResult {
		const stream = events(out.stdout);
		// The stream ends with how the turn ended; anything before that, errors about reconnecting included, is noise.
		const ending = stream.findLast((e) => e.type === "turn.completed" || e.type === "turn.failed");
		if (ending?.type !== "turn.completed" || out.code !== 0) {
			const reasons = [
				ending?.type === "turn.failed" ? ending.error?.message : undefined,
				stream.findLast((e) => e.type === "error")?.message,
				tail(out.stderr, 500),
			];
			const reason = reasons.find((r) => typeof r === "string" && r !== "");
			const detail = typeof reason === "string" ? reason : `exit code ${out.code}, no result`;
			throw new EngineError(`codex failed: ${detail}`, { systemic: SYSTEMIC.test(detail) });
		}
		const answer = stream.findLast(
			(e) => e.type === "item.completed" && e.item?.type === "agent_message",
		);
		return {
			text: typeof answer?.item?.text === "string" ? answer.item.text : "",
			costUsd: 0,
			// Each turn.completed carries the usage of the whole thread so far: the last one is the total.
			tokens: {
				input: count(ending.usage?.input_tokens),
				output: count(ending.usage?.output_tokens),
			},
		};
	},
};
