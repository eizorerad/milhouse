/** The agent: one process of the chosen harness per call. Spawning, timeouts and cleanup are the same for all. */

import { identityEnv, withoutGitRouting } from "./git.ts";
import { claude } from "./harness/claude.ts";
import { codex } from "./harness/codex.ts";
import { type AgentOptions, type AgentResult, EngineError, type Harness } from "./harness/types.ts";
import { type RunResult, run } from "./proc.ts";
import type { HarnessName } from "./types.ts";

export { EngineError };

export const HARNESSES: Record<HarnessName, Harness> = { claude, codex };

/** What a call that timed out is counted as when its harness reports USD but said nothing about this call. */
const UNKNOWN_COST_USD = 1;

/** What a call that was stopped says it cost, or 0 when it says nothing. */
function costOfInterrupted(harness: Harness, out: RunResult): number {
	try {
		return harness.parse(out).costUsd;
	} catch (err) {
		return err instanceof EngineError ? err.costUsd : 0;
	}
}

/** Agent commits must never wait for a signing prompt or a credential question. */
const agentEnv = (): NodeJS.ProcessEnv => ({
	...withoutGitRouting(process.env),
	...identityEnv(),
	CI: "true",
	NO_COLOR: "1",
	GIT_TERMINAL_PROMPT: "0",
	...gitConfig("commit.gpgsign", "false"),
});

/** One more git setting through the environment, after those the caller passed the same way (`safe.directory` in a container). */
function gitConfig(key: string, value: string): NodeJS.ProcessEnv {
	const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
	return {
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: key,
		[`GIT_CONFIG_VALUE_${count}`]: value,
	};
}

export async function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
	const harness = HARNESSES[opts.harness];
	const out = await run(harness.binary(), harness.args(opts), {
		cwd: opts.cwd,
		env: agentEnv(),
		input: harness.input(prompt, opts),
		timeoutMs: opts.timeoutMs,
		// An interrupt, as Ctrl-C sends it: Claude Code answers it with what the call cost so far, and says
		// nothing when it is terminated.
		timeoutSignal: "SIGINT",
		reap: true, // a dev server the agent started must not outlive its call
	});

	if (out.timedOut) {
		const seconds = Math.round(opts.timeoutMs / 1000);
		const costUsd = costOfInterrupted(harness, out); // of the turns it finished: the least it cost
		if (costUsd > 0 || !harness.reportsCost) {
			throw new EngineError(`agent timed out after ${seconds}s`, { costUsd });
		}
		// It said nothing, so the real cost is unknown. Count an estimate: nothing would hide the money, the
		// whole allowance (all that is left, for a sequential step) would stop the run for a call that may
		// have cost little.
		throw new EngineError(
			`agent timed out after ${seconds}s (its cost is unknown, counted as an estimate)`,
			{ costUsd: Math.min(opts.maxBudgetUsd ?? UNKNOWN_COST_USD, UNKNOWN_COST_USD) },
		);
	}
	return harness.parse(out);
}
