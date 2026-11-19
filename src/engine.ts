/** The agent: one process of the chosen harness per call. Spawning, timeouts and cleanup are the same for all. */

import { identityEnv, withoutGitRouting } from "./git.ts";
import { claude } from "./harness/claude.ts";
import { codex } from "./harness/codex.ts";
import { type AgentOptions, type AgentResult, EngineError, type Harness } from "./harness/types.ts";
import { run } from "./proc.ts";
import type { HarnessName } from "./types.ts";

export { EngineError };

export const HARNESSES: Record<HarnessName, Harness> = { claude, codex };

/** What a call that timed out is counted as when its harness reports USD: it cannot report its own cost. */
const UNKNOWN_COST_USD = 1;

/** Agent commits must never wait for a signing prompt or a credential question. */
const agentEnv = (): NodeJS.ProcessEnv => ({
	...withoutGitRouting(process.env),
	...identityEnv(),
	CI: "true",
	NO_COLOR: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "commit.gpgsign",
	GIT_CONFIG_VALUE_0: "false",
});

export async function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
	const harness = HARNESSES[opts.harness];
	const out = await run(harness.binary(), harness.args(opts), {
		cwd: opts.cwd,
		env: agentEnv(),
		input: harness.input(prompt, opts),
		timeoutMs: opts.timeoutMs,
		reap: true, // a dev server the agent started must not outlive its call
	});

	if (out.timedOut) {
		const seconds = Math.round(opts.timeoutMs / 1000);
		if (!harness.reportsCost) throw new EngineError(`agent timed out after ${seconds}s`);
		// The real cost is unknown. Count an estimate: nothing would hide the money, the whole allowance
		// (all that is left, for a sequential step) would stop the run for a call that may have cost little.
		throw new EngineError(
			`agent timed out after ${seconds}s (its cost is unknown, counted as an estimate)`,
			{ costUsd: Math.min(opts.maxBudgetUsd ?? UNKNOWN_COST_USD, UNKNOWN_COST_USD) },
		);
	}
	return harness.parse(out);
}
