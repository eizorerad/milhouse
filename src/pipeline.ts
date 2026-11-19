/** The pipeline: preflight, open or resume a run, run the phases in order, finish with an honest status. */

import { agentSteps, describeAgents, projectChecksEnabled, stepHarness } from "./config.ts";
import { CostTracker, formatCost, formatUsd } from "./cost.ts";
import { HARNESSES } from "./engine.ts";
import { currentBranch, detectIdentity, hasCommits, isDirty, isRepo, revParse } from "./git.ts";
import { acquireLock } from "./lock.ts";
import { consolidatePhase } from "./phases/consolidate.ts";
import { execPhase } from "./phases/exec.ts";
import { mergePhase } from "./phases/merge.ts";
import { planPhase } from "./phases/plan.ts";
import { scanPhase } from "./phases/scan.ts";
import { validatePhase } from "./phases/validate.ts";
import { type Outcome, runPhase } from "./runner.ts";
import { RunStore } from "./state.ts";
import { type Config, PHASES, type Phase } from "./types.ts";
import { log } from "./ui.ts";
import { errorMessage } from "./util.ts";
import { cleanupRun } from "./worktree.ts";

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
			throw new Error(
				`"${harness.binary()}" was not found on PATH. Install ${harness.label} first: ${harness.installHint}`,
			);
		}
	}
}

export async function preflight(workDir: string, phases: Phase[]): Promise<void> {
	if (!(await isRepo(workDir)))
		throw new Error("This is not a git repository. Run milhouse inside one.");
	if (!(await hasCommits(workDir)))
		throw new Error("The repository has no commits yet. Make an initial commit first.");
	await detectIdentity(workDir); // commits need an author, also in a container that has none
	if (phases.includes("exec") || phases.includes("merge")) {
		if (!(await currentBranch(workDir)))
			throw new Error("HEAD is detached. Check out a branch first.");
		if (await isDirty(workDir)) {
			throw new Error("The working tree has uncommitted changes. Commit or stash them first.");
		}
	}
}

/** The run this command continues, or undefined when it starts a new one. */
async function existingRun(workDir: string, opts: PipelineOptions): Promise<RunStore | undefined> {
	const continuing = opts.resume || (opts.only !== undefined && opts.only !== "scan");
	if (!continuing) return undefined;
	const store = opts.runId ? RunStore.byId(workDir, opts.runId) : RunStore.latest(workDir);
	if (!store) throw new Error("There is no run to continue. Start one with: milhouse --run");
	// Every phase reads the code of the branch the run started on, and merge writes to it.
	const { base_branch: baseBranch } = store.loadMeta();
	if (baseBranch && (await currentBranch(workDir)) !== baseBranch) {
		throw new Error(`This run started on "${baseBranch}". Check it out first, then continue.`);
	}
	return store;
}

/** Scan, validate and plan read the checkout; exec starts from the last commit and would not have its untracked files. */
async function refuseUntracked(workDir: string, todo: Phase[]): Promise<void> {
	const readsCheckout = todo.some((p) => p === "scan" || p === "validate" || p === "plan");
	if (todo.includes("exec") && readsCheckout && (await isDirty(workDir, { untracked: true }))) {
		throw new Error(
			"The working tree has untracked files, which exec would not see (it starts from the last commit). Commit them, add them to .gitignore, or stash them: git stash -u",
		);
	}
}

/** What this command is about to do and spend, and what to watch out for. */
function announce(store: RunStore, config: Config, todo: Phase[], cost: CostTracker): void {
	log.info(`Run ${store.runId}: ${todo.join(" -> ") || "nothing left to do"}`);
	if (config.budget > 0) {
		log.info(`Budget ${formatUsd(config.budget)}, spent so far ${formatUsd(cost.current.total)}`);
	}
	if (agentSteps(config, todo).length > 0) log.info(`Agents: ${describeAgents(config, todo)}`);
	const unpriced = new Set(
		agentSteps(config, todo)
			.map((step) => stepHarness(config, step))
			.filter((name) => !HARNESSES[name].reportsCost),
	);
	if (config.budget > 0 && unpriced.size > 0) {
		const names = [...unpriced].map((name) => HARNESSES[name].label).join(" and ");
		log.warn(`The budget cannot limit ${names}: it reports tokens, not dollars.`);
	}
	if (todo.includes("exec") && !projectChecksEnabled(config)) {
		log.warn(
			config.gates.dod
				? "No build, lint or test command is configured. Set one in .milhouse/config.ts for automatic merge."
				: "Project checks and review are disabled (gates.dod=false). Automatic merge needs a passing project check.",
		);
	}
}

/** Returns true when everything that was asked for succeeded. */
export async function runPipeline(config: Config, opts: PipelineOptions = {}): Promise<boolean> {
	const workDir = opts.workDir ?? process.cwd();
	const wanted = opts.only ? [opts.only] : config.pipeline;
	await preflight(workDir, wanted);

	const release = acquireLock(workDir);
	try {
		const existing = await existingRun(workDir, opts);
		const done = existing?.loadMeta().done ?? [];
		// A full resume skips finished phases; an explicitly requested phase always runs.
		const todo =
			opts.only || !opts.resume ? wanted : wanted.filter((phase) => !done.includes(phase));
		await refuseUntracked(workDir, todo);
		requireAgents(config, todo); // before a new run leaves anything behind
		const store =
			existing ??
			RunStore.create(workDir, opts.scope, {
				branch: await currentBranch(workDir),
				sha: await revParse(workDir, "HEAD"),
			});
		const cost = new CostTracker(store.loadCost(), config.budget, (c) => store.saveCost(c));

		announce(store, config, todo, cost);

		let failures = 0;
		for (const phase of todo) {
			if (phase !== "merge" && cost.exceeded()) break; // merging costs nothing
			store.startPhase(phase);
			log.phase(phase);
			const outcomes =
				phase === "merge"
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
	} finally {
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
	const spent = formatCost(cost.current);
	const budgetHint = `The budget of ${formatUsd(config.budget)} is used up: raise "budget" in .milhouse/config.ts, then run: milhouse --resume`;
	if (failures > 0) {
		store.finish("failed");
		log.error(
			`${failures} item(s) failed (${spent}). Details: milhouse --report. Retry with: milhouse --resume`,
		);
		if (cost.exceeded()) log.warn(budgetHint);
		return false;
	}
	if (complete) {
		try {
			await cleanupRun(store); // nothing is left to do with the worktree; unmerged work stays in the ref
		} catch (err) {
			log.warn(`The run's worktree was not removed: ${errorMessage(err)}`);
		}
		store.finish("completed");
		log.success(`Pipeline complete: ${spent}. Summary: milhouse --report`);
		return true;
	}
	store.finish("stopped");
	if (cost.exceeded()) {
		log.warn(`${budgetHint} (${spent})`);
		return false;
	}
	log.success(`Done: ${spent}. Summary: milhouse --report`);
	return true;
}

/** Verified work that no merge has taken to the branch yet. */
function hintMerge(store: RunStore): void {
	const waiting = store.loadTasks().filter((t) => t.status === "verified").length;
	if (waiting > 0) {
		log.info(
			`${waiting} verified task(s) wait in ${store.ref}. To merge: milhouse --merge --run-id ${store.runId}`,
		);
	}
}
