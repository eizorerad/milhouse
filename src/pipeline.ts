/** The pipeline: preflight, open or resume a run, run the phases in order, finish with an honest status. */

import { checkBase } from "./baseline.ts";
import { agentSteps, describeAgents, projectChecksEnabled, stepHarness } from "./config.ts";
import { CostTracker, formatCost, formatTokens, formatUsd } from "./cost.ts";
import { HARNESSES } from "./engine.ts";
import {
	currentBranch,
	detectIdentity,
	hasCommits,
	isAncestor,
	isDirty,
	isRepo,
	revParse,
} from "./git.ts";
import { acquireLock } from "./lock.ts";
import { consolidatePhase } from "./phases/consolidate.ts";
import { execPhase } from "./phases/exec.ts";
import { mergePhase } from "./phases/merge.ts";
import { planPhase } from "./phases/plan.ts";
import { scanPhase } from "./phases/scan.ts";
import { validatePhase } from "./phases/validate.ts";
import { formatReport, generateReport } from "./report.ts";
import { type Outcome, runPhase } from "./runner.ts";
import { RunStore } from "./state.ts";
import { type Config, HARNESS_NAMES, PHASES, type Phase } from "./types.ts";
import { log } from "./ui.ts";
import { MINUTE, errorMessage } from "./util.ts";
import { cleanupRun, readWorktree, releaseWorktree, tidy } from "./worktree.ts";

export interface PipelineOptions {
	/** Repository to work in. Defaults to the current directory. */
	workDir?: string;
	scope?: string;
	/** Continue an existing run (the latest, or `runId`) instead of starting a new one. */
	resume?: boolean;
	runId?: string;
	/** Run only this phase. Every phase except scan works on an existing run. */
	only?: Phase;
}

type Runner = (store: RunStore, config: Config, cost: CostTracker) => Promise<Outcome<unknown>[]>;

const RUNNERS: Record<Exclude<Phase, "merge">, Runner> = {
	scan: (store, config, cost) => runPhase(scanPhase, store, config, cost),
	validate: (store, config, cost) => runPhase(validatePhase, store, config, cost),
	plan: (store, config, cost) => runPhase(planPhase, store, config, cost),
	consolidate: (store, config, cost) => runPhase(consolidatePhase, store, config, cost),
	exec: (store, config, cost) => runPhase(execPhase, store, config, cost),
};

/** The agents that the steps of `phases` use must be installed. Merge needs none. */
export function requireAgents(config: Config, phases: Phase[]): void {
	for (const name of new Set(agentSteps(config, phases).map((step) => stepHarness(config, step)))) {
		const harness = HARNESSES[name];
		if (!Bun.which(harness.binary())) {
			const other = HARNESS_NAMES.find((n) => n !== name && Bun.which(HARNESSES[n].binary()));
			const instead = other
				? ` ${HARNESSES[other].label} is installed: add --harness ${other} to use it instead.`
				: "";
			throw new Error(
				`"${harness.binary()}" was not found on PATH. Install ${harness.label} first: ${harness.installHint}${instead}`,
			);
		}
	}
}

export async function preflight(workDir: string): Promise<void> {
	if (!(await isRepo(workDir)))
		throw new Error("This is not a git repository. Run milhouse inside one.");
	if (!(await hasCommits(workDir)))
		throw new Error("The repository has no commits yet. Make an initial commit first.");
	await detectIdentity(workDir); // commits need an author, also in a container that has none
}

/** The run this command continues, or undefined when it starts a new one. */
async function existingRun(workDir: string, opts: PipelineOptions): Promise<RunStore | undefined> {
	const continuing = opts.resume || (opts.only !== undefined && opts.only !== "scan");
	if (!continuing) return undefined;
	const store = opts.runId ? RunStore.byId(workDir, opts.runId) : RunStore.latest(workDir);
	if (!store) throw new Error("There is no run to continue. Start one with: milhouse --run");
	// Merge writes to the branch the run started on, whatever is checked out by then. A run that began on a
	// detached HEAD (a CI checkout) takes the branch it is continued on, if that branch holds its starting commit.
	const { base_branch: baseBranch, base_sha: base } = store.loadMeta();
	const branch = await currentBranch(workDir);
	if (!baseBranch && branch && (await isAncestor(workDir, base, "HEAD"))) store.setBranch(branch);
	return store;
}

/** What this command is about to do and spend, and what to watch out for. */
function announce(store: RunStore, config: Config, todo: Phase[], cost: CostTracker): void {
	log.info(`Run ${store.runId}: ${todo.join(" -> ") || "nothing left to do"}`);
	if (config.budget > 0) {
		log.info(`Budget ${formatUsd(config.budget)}, spent so far ${formatUsd(cost.current.total)}`);
	}
	if (config.maxMinutes > 0) log.info(`Time limit for this command: ${config.maxMinutes} minutes`);
	if (agentSteps(config, todo).length > 0) log.info(`Agents: ${describeAgents(config, todo)}`);
	const unpriced = new Set(
		agentSteps(config, todo)
			.map((step) => stepHarness(config, step))
			.filter((name) => !HARNESSES[name].reportsCost),
	);
	if (unpriced.size > 0) {
		const names = [...unpriced].map((name) => HARNESSES[name].label).join(" and ");
		const { input = 0, output = 0 } = cost.current.tokens ?? {};
		if (config.maxTokens > 0) {
			log.info(
				`Token limit for ${names}: ${formatTokens(config.maxTokens)}, used so far ${formatTokens(input + output)}`,
			);
		} else if (config.budget > 0) {
			log.warn(
				`The budget cannot limit ${names}: it reports tokens, not dollars. Set maxTokens to limit it.`,
			);
		}
	}
	if (todo.includes("exec") && !projectChecksEnabled(config)) {
		log.warn(
			config.gates.dod
				? "No build, lint or test command is configured. Set one in .milhouse/config.ts for automatic merge."
				: "Project checks and review are disabled (gates.dod=false). Automatic merge needs a passing project check.",
		);
	}
}

/** Exec with nothing to run as a check is only an agent's opinion, and its work never merges by itself. */
function refuseUnchecked(config: Config, todo: Phase[]): void {
	if (!todo.includes("exec") || !config.gates.dod || config.allowUnchecked) return;
	if (projectChecksEnabled(config)) return;
	throw new Error(
		"No build, lint or test command is configured, so an agent alone would review the work and nothing would merge by itself. Set commands.test (or build, lint) in .milhouse/config.ts, or run with --allow-unchecked.",
	);
}

/** Returns true when everything that was asked for succeeded. */
export async function runPipeline(config: Config, opts: PipelineOptions = {}): Promise<boolean> {
	const workDir = opts.workDir ?? process.cwd();
	const wanted = opts.only ? [opts.only] : config.pipeline;
	await preflight(workDir);

	const release = acquireLock(workDir);
	// A run that ends without saying how must not stay "running": that is the status a later command reads.
	let opened: RunStore | undefined;
	const settle = (status: "stopped" | "failed") => {
		try {
			if (opened?.loadMeta().status === "running") opened.finish(status);
		} catch {
			// The state cannot be read or written: there is nothing to put right here.
		}
	};
	const interrupted = () => settle("stopped"); // Ctrl-C, SIGTERM, a closed terminal: the run can be resumed
	process.once("exit", interrupted);
	try {
		const existing = await existingRun(workDir, opts);
		const done = existing?.loadMeta().done ?? [];
		// A full resume skips finished phases; an explicitly requested phase always runs.
		const todo =
			opts.only || !opts.resume ? wanted : wanted.filter((phase) => !done.includes(phase));
		refuseUnchecked(config, todo);
		// The run has a checkout of its own: what is not committed stays where it is, untouched and unseen.
		if (!existing && (await isDirty(workDir, { untracked: true }))) {
			log.warn(
				"Uncommitted changes and untracked files are not part of this run: it works on the last commit and leaves them alone.",
			);
		}
		requireAgents(config, todo); // before a new run leaves anything behind
		// Housekeeping must not stop a run: what it could not remove stays for `--clean`, which says why.
		if (!existing) await tidy(workDir).catch((err) => log.debug(`tidy: ${errorMessage(err)}`));
		const store =
			existing ??
			RunStore.create(workDir, opts.scope, {
				branch: await currentBranch(workDir),
				sha: await revParse(workDir, "HEAD"),
			});
		opened = store;
		const cost = new CostTracker(
			store.loadCost(),
			config.budget,
			(c) => store.saveCost(c),
			config.maxMinutes * MINUTE,
			config.maxTokens,
		);

		announce(store, config, todo, cost);

		const broken = todo.includes("exec")
			? await checkBase(store, config).catch(
					(err) => errorMessage(err) || "The check of the starting commit failed.",
				)
			: null;
		if (broken) {
			log.error(broken);
			store.finish("failed"); // first: it is the status that a later command reads
			store.logEvent({ event: "baseline-failed", error: broken.slice(0, 2000) });
			return false;
		}

		let failures = 0;
		for (const phase of todo) {
			if (phase !== "merge" && cost.exceeded()) continue; // merging costs nothing: it still runs
			store.startPhase(phase);
			log.phase(phase);
			// The steps that only read need the run's checkout too; exec prepares it for every issue itself.
			const unreadable = phase === "merge" || phase === "exec" ? null : await readWorktree(store);
			const outcomes = unreadable
				? [{ ok: false as const, error: unreadable }]
				: phase === "merge"
					? await mergePhase(store, config, opts.only === "merge")
					: await RUNNERS[phase](store, config, cost);
			if (outcomes.every((o) => o.ok) && upstreamDone(store, config, phase))
				store.completePhase(phase);
			const failed = outcomes.flatMap((o) => (!o.ok && !o.skipped ? [o] : []));
			failures += failed.length;
			for (const error of new Set(failed.map((o) => o.error))) log.error(error);
			if (failed.some((o) => o.systemic)) {
				log.warn(
					"Stopped: every other call would fail the same way. Fix the cause, then run: milhouse --resume",
				);
				break;
			}
			if (failures > 0 && config.failFast) break;
		}
		const ok = await finish(store, config, cost, failures);
		hintMerge(store);
		return ok;
	} catch (err) {
		settle("failed"); // something broke that no retry handles
		throw err;
	} finally {
		process.off("exit", interrupted);
		release();
	}
}

/**
 * A phase that found nothing to do because an earlier phase failed has not really finished:
 * it must run again on --resume. So a phase counts as done only when everything before it is done.
 */
function upstreamDone(store: RunStore, config: Config, phase: Phase): boolean {
	const done = store.loadMeta().done;
	return config.pipeline
		.filter((earlier) => PHASES.indexOf(earlier) < PHASES.indexOf(phase))
		.every((earlier) => done.includes(earlier));
}

async function finish(
	store: RunStore,
	config: Config,
	cost: CostTracker,
	failures: number,
): Promise<boolean> {
	const complete = config.pipeline.every((phase) => store.loadMeta().done.includes(phase));
	try {
		// Nothing is left to do with the worktree of a finished run (unmerged work stays in the ref); an
		// unfinished one keeps it only for the setup that was run in it.
		await (complete ? cleanupRun(store) : releaseWorktree(store));
	} catch (err) {
		log.warn(`The run's worktree was not removed: ${errorMessage(err)}`);
	}
	const spent = formatCost(cost.current);
	const limit = cost.limitReached(); // once: the clock goes on while this function runs
	const limitHint =
		limit === "time"
			? `The time limit of ${config.maxMinutes} minutes is used up. Go on with: milhouse --resume (every command gets the full time; --max-minutes <n> sets another)`
			: limit === "tokens"
				? `The token limit of ${formatTokens(config.maxTokens)} is used up. Go on with a higher one: milhouse --resume --max-tokens <n> (or set "maxTokens" in .milhouse/config.ts)`
				: `The budget of ${formatUsd(config.budget)} is used up. Go on with a higher one: milhouse --resume --budget <usd> (or set "budget" in .milhouse/config.ts)`;
	store.finish(failures > 0 ? "failed" : complete ? "completed" : "stopped");
	// What the run found and did, right here: nobody should have to ask for it.
	console.log(`\n${formatReport(generateReport(store), "terminal")}\n`);
	if (failures > 0) {
		log.error(`${failures} item(s) failed (${spent}). Retry with: milhouse --resume`);
		if (limit) log.warn(limitHint);
		return false;
	}
	if (complete) {
		log.success(`Pipeline complete: ${spent}`);
		return true;
	}
	if (limit) {
		log.warn(`${limitHint} (${spent})`);
		return false;
	}
	log.success(`Done: ${spent}`);
	return true;
}

/** Verified work that no merge has taken to the branch yet. */
function hintMerge(store: RunStore): void {
	const waiting = store.loadTasks().filter((t) => t.status === "verified");
	if (waiting.length === 0) return;
	const unchecked = waiting.filter((t) => !t.checks_passed).length;
	const note = unchecked > 0 ? `; for ${unchecked} of them no project check ran` : "";
	log.info(
		`${waiting.length} verified task(s) wait in ${store.ref}${note}. To merge: milhouse --merge --run-id ${store.runId}`,
	);
}
