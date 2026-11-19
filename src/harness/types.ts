/** What every harness (coding agent CLI) has to provide, and what a call to one looks like. */

import type { RunResult } from "../proc.ts";
import type { HarnessName } from "../types.ts";

export interface AgentOptions {
	harness: HarnessName;
	cwd: string;
	model?: string;
	/** JSON schema the answer has to follow. */
	schema?: object;
	/** Turn limit. Claude only. */
	maxTurns?: number;
	timeoutMs: number;
	/** "read": look, change nothing. "all": edit files and run commands with permissions bypassed (exec only). */
	tools: "read" | "all";
	/** Cap for this single call in USD. Claude only: Codex does not report a cost. */
	maxBudgetUsd?: number;
	/** From the config (options that Milhouse sets itself are rejected there). They go first. */
	extraArgs?: string[];
}

export interface AgentResult {
	text: string;
	/** What the call cost in USD; 0 when the harness does not report it. */
	costUsd: number;
	/** Tokens of a call that reports no USD cost. */
	tokens?: { input: number; output: number };
}

export interface EngineErrorOptions {
	/** What the failed call cost. It is real money even though the call failed. */
	costUsd?: number;
	/** Retrying cannot help (the per-call budget is used up). */
	fatal?: boolean;
	/** Neither can any other call: the login, the model or the quota is the problem. The phase stops. */
	systemic?: boolean;
}

/** What a CLI says when it rejects its command line: the same for every call, retrying cannot help. */
export const USAGE_ERROR =
	/unexpected argument|unknown option|unrecognized (?:option|argument)|cannot be used multiple times|unknown argument/i;

export class EngineError extends Error {
	readonly costUsd: number;
	readonly fatal: boolean;
	readonly systemic: boolean;

	constructor(
		message: string,
		{ costUsd = 0, fatal = false, systemic = false }: EngineErrorOptions = {},
	) {
		super(message);
		this.name = "EngineError";
		this.costUsd = costUsd;
		this.systemic = systemic;
		this.fatal = fatal || systemic;
	}
}

export interface Harness {
	/** For messages. */
	label: string;
	installHint: string;
	/** Does a call report its cost in USD? Only then can the budget cap it. */
	reportsCost: boolean;
	binary(): string;
	args(opts: AgentOptions): string[];
	/** What is written to stdin. */
	input(prompt: string, opts: AgentOptions): string;
	/** The answer of a finished process. Throws EngineError when there is none. */
	parse(out: RunResult, opts: AgentOptions): AgentResult;
}
