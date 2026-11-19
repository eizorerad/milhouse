/**
 * exec: implement every issue on top of the previous ones, check it, have it reviewed, then accept it.
 *
 * Issues run one after another in a single worktree. `store.ref` holds accepted work only: an issue is
 * accepted (the ref moves) once its tasks are committed, the checks pass and the reviewer agrees.
 * A failed issue is parked on its own branch and the worktree returns to the accepted state, so no issue
 * builds on broken work and every issue is checked on top of everything accepted before it.
 */

import { existsSync } from "node:fs";
import { EngineError } from "../engine.ts";
import {
	findPlaceholders,
	findWhitespaceProblems,
	forbiddenFiles,
	runProjectChecks,
} from "../gates.ts";
import {
	acceptCommit,
	addedLines,
	branchExists,
	clearIndexLock,
	commitSubjects,
	deleteBranch,
	diffPatch,
	diffStat,
	gitOrThrow,
	isAncestor,
	parkWorktree,
	resetWorktree,
	revParse,
	touchedFiles,
} from "../git.ts";
import { feedback, prompt } from "../prompts.ts";
import { type Ctx, GiveUp, type PhaseDef, Skip } from "../runner.ts";
import type { Config, Task } from "../types.ts";
import { errorMessage, parseJson, tail } from "../util.ts";
import { discardWorktree, prepareWorktree } from "../worktree.ts";
import { type IssueGroup, committedTaskIds, loadGroups, unmetDependencies } from "./exec-order.ts";
import { REVIEW_SCHEMA, bullets, execPrompt, reviewPrompt } from "./exec-prompts.ts";

const MINUTE = 60_000;

export const parkBranch = (issueId: string): string => `mh-failed/${issueId}`;

/**
 * Marks a failure of the reviewer itself (not a verdict). It must not send the issue back to the executor:
 * the work is fine, only the review has to be asked for again.
 */
const REVIEW_UNAVAILABLE = "The review could not be completed";

/** The executor could not run at all (logged out, unknown model): nothing it did, nothing it can fix. */
const AGENT_UNAVAILABLE = "The agent could not run";

/** Failures that are not the executor's fault must not be fed back to it as feedback. */
const blamesAgent = (error: string | undefined): error is string =>
	error !== undefined &&
	!error.startsWith(REVIEW_UNAVAILABLE) &&
	!error.startsWith(AGENT_UNAVAILABLE) &&
	!error.startsWith("setup failed");

// ─── Checks and review ───────────────────────────────────────────────

interface Work {
	dir: string;
	/** Where the run started: every commit of the run lies after it. */
	base: string;
	/** Tip of the accepted work: this issue's commits lie after it. */
	accepted: string;
}

/** First problem with the work (written as instructions for the agent), or null when it passes. */
export async function checkWork(
	work: Work,
	group: IssueGroup,
	config: Config,
): Promise<string | null> {
	const tip = work.accepted.slice(0, 8);
	if (!(await isAncestor(work.dir, work.accepted, "HEAD"))) {
		return `The accepted commits (up to ${tip}) are no longer part of HEAD. Never reset, rebase or switch away from them: build on top of ${tip}.`;
	}

	const done = committedTaskIds(await commitSubjects(work.dir, work.base), group.tasks);
	const missing = group.tasks.filter((t) => !done.has(t.id));
	if (missing.length > 0) {
		const list = missing.map((t) => `[${t.id}] ${t.title}`).join("; ");
		return `These tasks have no commit with the subject \`[<task id>] <title>\`: ${list}`;
	}

	// --untracked-files=all: a user's status.showUntrackedFiles=no must not hide a fixture left behind.
	const status = await gitOrThrow(work.dir, "status", "--porcelain", "--untracked-files=all");
	if (status) {
		return `Uncommitted changes are left in the worktree. Commit them under the right task or remove them:\n${tail(status, 800)}`;
	}

	// .milhouse/ is milhouse's own: its config is executed as code, so no commit may change it.
	const protectedPaths = [...config.neverTouch, ".milhouse/"];
	const forbidden = forbiddenFiles(await touchedFiles(work.dir, work.accepted), protectedPaths);
	if (forbidden.length > 0) {
		return `Commits touched files that must never be modified: ${forbidden.join(", ")}. Rewrite the history so that no commit after ${tip} touches them (for example git reset --soft ${tip}, restore those files, then commit per task again).`;
	}

	const added =
		config.gates.placeholder || config.gates.diffHygiene
			? await addedLines(work.dir, work.accepted)
			: [];
	if (config.gates.placeholder) {
		const found = findPlaceholders(added);
		if (found.length > 0) {
			return `Unfinished work was added (TODO/FIXME/stubs). Finish it:\n${bullets(found.slice(0, 10))}`;
		}
	}
	if (config.gates.diffHygiene) {
		const problems = findWhitespaceProblems(added);
		if (problems.length > 0) {
			return `Trailing whitespace or conflict markers were added:\n${bullets(problems.slice(0, 10))}`;
		}
	}
	if (config.gates.dod) {
		const failure = await runProjectChecks(work.dir, config.commands);
		if (failure) return failure;
	}
	return null;
}

export interface Verdict {
	task_id: string;
	passed: boolean;
	reason: string;
}

/** Exactly one verdict per task, no unknown or repeated ids. */
export function parseVerdicts(text: string, tasks: Task[]): Verdict[] {
	const { tasks: verdicts } = parseJson<{ tasks?: Verdict[] }>(text, "Review");
	if (!Array.isArray(verdicts)) throw new Error("Review: the answer has no `tasks` list");
	const expected = new Set(tasks.map((t) => t.id));
	const seen = new Set<string>();
	for (const { task_id } of verdicts) {
		if (!expected.has(task_id)) throw new Error(`Review: unknown task id ${task_id}`);
		if (seen.has(task_id)) throw new Error(`Review: two verdicts for ${task_id}`);
		seen.add(task_id);
	}
	const missing = tasks.filter((t) => !seen.has(t.id));
	if (missing.length > 0)
		throw new Error(`Review: no verdict for ${missing.map((t) => t.id).join(", ")}`);
	return verdicts;
}

/** Ask the reviewer (retrying only when it fails to answer). Throws when it rejects the work. */
async function review(ctx: Ctx, group: IssueGroup, work: Work): Promise<void> {
	const [stat, patch] = await Promise.all([
		diffStat(work.dir, work.accepted),
		diffPatch(work.dir, work.accepted),
	]);
	const text = reviewPrompt(group, stat, patch, ctx.config);
	let verdicts: Verdict[] | undefined;
	let failure = "";
	for (let attempt = 0; attempt <= ctx.config.phases.verify.retries && !verdicts; attempt++) {
		let answer: string;
		try {
			answer = await ctx.ask(prompt(text, feedback(failure)), {
				step: "verify",
				cwd: work.dir,
				schema: REVIEW_SCHEMA,
				maxTurns: 25,
				timeoutMs: 10 * MINUTE,
			});
		} catch (err) {
			// An agent failure (outage, budget) goes back to the runner, which backs off and retries.
			if (err instanceof EngineError) {
				throw new EngineError(`${REVIEW_UNAVAILABLE}: ${err.message}`, {
					fatal: err.fatal,
					systemic: err.systemic,
				});
			}
			throw err;
		}
		try {
			verdicts = parseVerdicts(answer, group.tasks);
		} catch (err) {
			failure = errorMessage(err); // a malformed answer: just ask again
		}
	}
	if (!verdicts) throw new Error(`${REVIEW_UNAVAILABLE}: ${failure}`);

	const reasons = rejectionReasons(verdicts, group.tasks);
	if (reasons.length > 0) throw new Error(`The reviewer rejected the work:\n${bullets(reasons)}`);
}

/** One line per task the reviewer did not explicitly pass: anything but `true` counts as a rejection. */
export function rejectionReasons(verdicts: Verdict[], tasks: Task[]): string[] {
	const titles = new Map(tasks.map((t) => [t.id, t.title]));
	return verdicts
		.filter((v) => v.passed !== true)
		.map((v) => `[${v.task_id}] ${titles.get(v.task_id)}: ${v.reason}`);
}

// ─── The phase ───────────────────────────────────────────────────────

export const execPhase: PhaseDef<IssueGroup, string> = {
	name: "exec",

	loadItems: (store) => loadGroups(store),

	label: (group) => group.issue.title.slice(0, 50),

	async run(group, ctx) {
		const { store, config } = ctx;
		const repo = store.workDir;
		const { base_sha: base } = store.loadMeta();

		// What this issue builds on has to be in place; otherwise it would only waste money.
		const unmet = unmetDependencies(group, store.loadTasks());
		if (unmet.length > 0) throw new Skip(`waiting for ${unmet.join(", ")}`);

		const setupFailure = await prepareWorktree(store, config);
		if (setupFailure) throw new GiveUp(setupFailure);

		// Accepted before but never recorded (a crash in between): the recorded commit is in the ref.
		const recorded = group.tasks[0]?.sha;
		if (
			recorded &&
			group.tasks.every((t) => t.sha === recorded) &&
			(await isAncestor(repo, recorded, store.ref))
		) {
			return recorded;
		}

		const accepted = await revParse(repo, store.ref);
		const previous = ctx.lastError ?? group.tasks.find((t) => t.error)?.error;
		if (ctx.attempt === 0) {
			// Start from the accepted state, so leftovers of an interrupted session never leak into this
			// issue. Only a parked attempt whose sole problem was the review is picked up again.
			const parked = parkBranch(group.issue.id);
			const pickUp =
				previous?.startsWith(REVIEW_UNAVAILABLE) &&
				(await branchExists(repo, parked)) &&
				(await isAncestor(repo, accepted, parked));
			await resetWorktree(store.worktree, pickUp ? parked : store.ref);
			if (pickUp) {
				// The attempt may need what the accepted work lacks (a new dependency): set up at its commit.
				const failure = await prepareWorktree(store, config, { setupAgain: true });
				if (failure) throw new GiveUp(failure);
			}
		}
		const work: Work = { dir: store.worktree, base, accepted };

		const doneIds = committedTaskIds(await commitSubjects(work.dir, base), group.tasks);
		const done = group.tasks.filter((t) => doneIds.has(t.id));
		const problem = blamesAgent(previous) ? previous : undefined;
		if (done.length < group.tasks.length || problem !== undefined) {
			try {
				await ctx.ask(execPrompt(group, done, config, problem), {
					cwd: work.dir,
					tools: "all",
					timeoutMs: 30 * MINUTE,
				});
			} catch (err) {
				// The agent was killed or crashed, perhaps in the middle of a commit.
				if (err instanceof EngineError) await clearIndexLock(work.dir);
				if (err instanceof EngineError && err.systemic) {
					throw new EngineError(`${AGENT_UNAVAILABLE}: ${err.message}`, { systemic: true });
				}
				throw err;
			}
		}

		const failure = await checkWork(work, group, config);
		if (failure) throw new Error(failure);
		const checked = await revParse(work.dir, "HEAD"); // exactly this commit is reviewed and accepted
		if (config.gates.dod) await review(ctx, group, work);
		store.updateTasks(
			group.tasks.map((t) => t.id),
			{ sha: checked },
		); // before the ref moves: a crash in between is recognised on resume
		await acceptCommit(repo, store.ref, checked);
		return checked;
	},

	async record(group, outcome, store) {
		const ids = group.tasks.map((t) => t.id);
		if (outcome.ok) {
			store.updateTasks(ids, { status: "verified", error: undefined });
			await deleteBranch(store.workDir, parkBranch(group.issue.id)); // a stale parked attempt
			return;
		}
		if (existsSync(store.worktree)) {
			try {
				await parkWorktree(
					store.workDir,
					store.worktree,
					parkBranch(group.issue.id),
					await revParse(store.workDir, store.ref),
				);
			} catch (err) {
				// What is in the worktree is the only copy of the attempt: leave it alone, and stop everything.
				throw new Error(
					`${errorMessage(err)}\nThe attempt is still in ${store.worktree}. Save what you need from it, then run: milhouse --resume (it starts again from the accepted work).`,
				);
			}
			// Not just a reset: a failed attempt may have installed dependencies that the next issue would
			// silently build on. A fresh worktree (and its setup) starts every issue from what was accepted.
			await discardWorktree(store);
		}
		// Keep the start of the message: markers such as REVIEW_UNAVAILABLE are recognised by their prefix.
		store.updateTasks(ids, { status: "failed", error: outcome.error.slice(0, 2000) });
	},
};
