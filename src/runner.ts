/** Runs one phase: load the items, process them (in parallel where configured) with retries, record each result. */

import { stepHarness, stepModel } from "./config.ts";
import { type CostTracker, LIMIT_USED_UP } from "./cost.ts";
import { EngineError, HARNESSES, runAgent } from "./engine.ts";
import { section } from "./prompts.ts";
import type { RunStore } from "./state.ts";
import type { AgentStep, Config, Phase } from "./types.ts";
import { Progress, log } from "./ui.ts";
import { MINUTE, errorMessage, mapPool, sleep } from "./util.ts";

export type Outcome<T> =
	| { ok: true; value: T }
	/**
	 * `skipped`: never attempted (the budget was used up, or the phase stopped), so there is nothing to record.
	 * `systemic`: every other item would fail the same way (not logged in, unknown model), so the run stops.
	 */
	| { ok: false; error: string; skipped?: boolean; systemic?: boolean };

export interface AskOptions {
	/** Step to charge and whose model to use. Defaults to the running phase. */
	step?: AgentStep;
	cwd?: string;
	schema?: object;
	maxTurns?: number;
	/** Default "read". */
	tools?: "read" | "all";
}

export interface Ctx {
	store: RunStore;
	config: Config;
	/** 0 for the first attempt. */
	attempt: number;
	/** Error of the previous attempt. Phases feed it back to the agent. */
	lastError?: string;
	ask(prompt: string, options?: AskOptions): Promise<string>;
}

export interface PhaseDef<TItem, TValue> {
	name: Exclude<Phase, "merge">;
	loadItems(store: RunStore, config: Config): TItem[] | Promise<TItem[]>;
	label(item: TItem): string;
	resultNote?(value: TValue): string;
	/** Do the work for one item. Throw to fail the attempt; the runner retries with the error as feedback. */
	run(item: TItem, ctx: Ctx): Promise<TValue>;
	/** Persist the final result of one item. Called as soon as the item is done. */
	record(item: TItem, outcome: Outcome<TValue>, store: RunStore): void | Promise<void>;
}

/** Throw to fail an item without further attempts (retrying cannot help). */
export class GiveUp extends Error {}

/** Throw to leave an item untouched for now: nothing is recorded, --resume picks it up again. */
export class Skip extends Error {}

/** How much of an agent's answer the run's log keeps. */
const ANSWER_LOG_CHARS = 4000;

const retryDelayMs = (): number => Number(process.env.MILHOUSE_RETRY_DELAY_MS ?? 2000);
const firstLine = (text: string): string => text.split("\n")[0].slice(0, 160);

/** What a phase hands its items to call the agent with. Parallel workers share what is left of the budget. */
function makeAsk(
	phase: Exclude<Phase, "merge">,
	store: RunStore,
	config: Config,
	cost: CostTracker,
	/** How many calls of the phase can be running at once from now on. */
	parallel: () => number,
): Ctx["ask"] {
	return async (prompt, o = {}) => {
		const step = o.step ?? phase;
		const harness = stepHarness(config, step);
		// Only a harness that reports dollars can be given an allowance.
		const allowance = HARNESSES[harness].reportsCost ? cost.reserve(parallel()) : undefined;
		try {
			if (allowance !== undefined && allowance <= 0) {
				throw new EngineError(LIMIT_USED_UP.budget, { fatal: true });
			}
			// Tokens cannot be capped per call: all that can be done is not to start another one.
			if (cost.tokensUsedUp()) {
				throw new EngineError(LIMIT_USED_UP.tokens, { fatal: true });
			}
			// Read once: a call that starts with no time left would get no timer at all, or a negative one.
			const remaining = cost.remainingMs();
			if (remaining <= 0) throw new EngineError(LIMIT_USED_UP.time, { fatal: true });
			// The step's own rules come last, after the role, the task and the global rules.
			const stepRules = config.phases[step].rules.map((rule) => `- ${rule}`).join("\n");
			const extra = section("Extra rules for this step", stepRules);
			const result = await runAgent(extra ? `${prompt}\n\n${extra}` : prompt, {
				harness,
				cwd: o.cwd ?? store.workDir,
				model: stepModel(config, step),
				schema: o.schema,
				maxTurns: o.maxTurns,
				timeoutMs: Math.min(config.phases[step].timeoutMinutes * MINUTE, remaining),
				tools: o.tools ?? "read",
				maxBudgetUsd: allowance,
				extraArgs: config.harnessArgs[harness],
			});
			cost.add(step, result.costUsd, result.tokens);
			log.debug(`${step}: ${harness} call cost $${result.costUsd.toFixed(4)}`);
			// What the agent said last: of the executor's work nothing else tells why it did what it did.
			store.logEvent({
				event: "agent",
				step,
				harness,
				...(HARNESSES[harness].reportsCost
					? { cost_usd: result.costUsd }
					: { tokens: result.tokens }),
				answer: result.text.slice(0, ANSWER_LOG_CHARS),
			});
			return result.text;
		} catch (err) {
			if (err instanceof EngineError) cost.add(step, err.costUsd);
			throw err;
		} finally {
			cost.release(allowance);
		}
	};
}

export async function runPhase<TItem, TValue>(
	def: PhaseDef<TItem, TValue>,
	store: RunStore,
	config: Config,
	cost: CostTracker,
): Promise<Outcome<TValue>[]> {
	const items = await def.loadItems(store, config);
	if (items.length === 0) {
		log.info(`${def.name}: nothing to do`);
		return [];
	}
	const options = config.phases[def.name];
	const workers = options.workers ?? 1;
	const progress = new Progress(def.name, items.length);

	// The last items of a phase must not be left with a worker's share of the budget while nobody else spends.
	let unfinished = items.length;
	const ask = makeAsk(def.name, store, config, cost, () => Math.min(workers, unfinished));

	let stopped: string | undefined; // set by a failure that every other item would hit as well

	const attempts = async (item: TItem, label: string): Promise<Outcome<TValue>> => {
		let lastError: string | undefined;
		for (let attempt = 0; attempt <= options.retries; attempt++) {
			// Another worker found that every call would fail: calls in flight finish, no new one starts.
			if (stopped) return { ok: false, error: stopped, skipped: true };
			const limit = cost.limitReached();
			if (limit) {
				const used = LIMIT_USED_UP[limit];
				const error = lastError ? `${lastError}\n(stopped: ${used})` : used;
				return { ok: false, error, skipped: attempt === 0 };
			}
			try {
				return { ok: true, value: await def.run(item, { store, config, attempt, lastError, ask }) };
			} catch (err) {
				if (err instanceof Skip) return { ok: false, error: err.message, skipped: true };
				lastError = errorMessage(err);
				store.logEvent({
					event: "attempt-failed",
					phase: def.name,
					item: label,
					attempt: attempt + 1,
					error: lastError.slice(0, 2000),
				});
				progress.note(
					`${label}: attempt ${attempt + 1}/${options.retries + 1} failed: ${firstLine(lastError)}`,
				);
				if (err instanceof EngineError && err.systemic) {
					return { ok: false, error: lastError, systemic: true };
				}
				if (err instanceof GiveUp || (err instanceof EngineError && err.fatal)) break;
				if (err instanceof EngineError && attempt < options.retries) {
					// Jitter: parallel workers that failed together must not retry together.
					await sleep(retryDelayMs() * (attempt + 1) * (0.5 + Math.random()));
				}
			}
		}
		return { ok: false, error: lastError ?? "failed" };
	};

	const outcomes = await mapPool(items, workers, async (item): Promise<Outcome<TValue>> => {
		if (stopped) return { ok: false, error: stopped, skipped: true }; // not attempted: --resume takes it up
		const label = def.label(item);
		progress.begin(label);
		const outcome = await attempts(item, label);
		if (!outcome.ok && outcome.systemic) stopped ??= outcome.error;
		unfinished--;
		if (outcome.ok || !outcome.skipped) await def.record(item, outcome, store);
		progress.end(
			label,
			outcome.ok,
			outcome.ok ? def.resultNote?.(outcome.value) : firstLine(outcome.error),
		);
		return outcome;
	});
	progress.stop();
	return outcomes;
}
