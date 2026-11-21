/**
 * merge: bring the verified work of the run into the branch the run started from. No AI involved.
 *
 * Automatic merge requires project checks on the commit that lands. An explicit --merge can accept
 * unchecked work, but a conflict or a failed check still leaves the branch untouched.
 */

import { commandTimeoutMs, projectChecksEnabled } from "../config.ts";
import { runProjectChecks } from "../gates.ts";
import {
	acceptCommit,
	branchRef,
	isAncestor,
	isWorktree,
	mergeInto,
	publish,
	refExists,
	resetWorktree,
	resolveRef,
	revParse,
} from "../git.ts";
import type { Outcome } from "../runner.ts";
import type { RunStore } from "../state.ts";
import type { Config, Task } from "../types.ts";
import { log } from "../ui.ts";
import { prepareWorktree } from "../worktree.ts";

/** Build the merge commit in the worktree and run its configured checks before publishing it. */
async function mergeCandidate(
	store: RunStore,
	config: Config,
	head: string,
	tip: string,
): Promise<{ sha: string } | { error: string }> {
	const setupFailure = await prepareWorktree(store, config);
	if (setupFailure) {
		return { error: `The worktree for the merge could not be prepared:\n${setupFailure}` };
	}
	await resetWorktree(store.worktree, head);
	const merged = await mergeInto(store.worktree, tip, `Merge milhouse run ${store.runId}`);
	if (!merged.ok) {
		return {
			error: `The merge conflicts: ${merged.error}\nThe verified work stays in ${store.ref}: merge it by hand.`,
		};
	}
	if (config.gates.dod) {
		// The branch may have changed what has to be installed (a lockfile): check what a fresh install gives.
		const failedSetup = await prepareWorktree(store, config, { setupAgain: true });
		if (failedSetup) return { error: `The merged work could not be set up:\n${failedSetup}` };
		const failure = await runProjectChecks(store.worktree, config.commands, {
			timeoutMs: commandTimeoutMs(config),
		});
		if (failure) {
			return {
				error: `Merging would break the checks, so nothing was merged. The verified work stays in ${store.ref}.\n${failure}`,
			};
		}
	}
	return { sha: await revParse(store.worktree, "HEAD") };
}

/** What a merge starts from: where the run started, the branch as it is now, and the accepted tip. */
interface Ready {
	baseBranch: string;
	head: string;
	tip: string;
}

/**
 * The accepted work agrees with the run's records and its branch is there: or what is wrong. The branch need
 * not be the one that is checked out: the run never worked in the user's checkout, and neither does its merge.
 */
async function readyToMerge(
	store: RunStore,
	verified: Task[],
	explicit: boolean,
): Promise<Ready | { error: string; skipped?: boolean }> {
	const repo = store.workDir;
	const { base_branch: baseBranch } = store.loadMeta();

	if (!(await refExists(repo, store.ref))) {
		return { error: `The accepted work of this run (${store.ref}) is missing.` };
	}
	if (!baseBranch) {
		// Nothing went wrong: the work waits, as unchecked work does, until a branch is there to take it.
		const error =
			"This run started on a detached HEAD, so it has no branch to merge into. Check out a branch that contains its starting commit, then run: milhouse --merge";
		if (!explicit) log.warn(`Automatic merge deferred. ${error}`);
		return { error, skipped: !explicit };
	}
	const head = await resolveRef(repo, branchRef(baseBranch));
	if (head === null) {
		return {
			error: `The branch "${baseBranch}" that this run started on is gone. The verified work stays in ${store.ref}: merge it by hand.`,
		};
	}
	const tip = await revParse(repo, store.ref);
	// The records and the ref must agree: a ref that was lost and recreated would otherwise let work be
	// marked as merged that never was.
	for (const task of verified) {
		if (task.sha && !(await isAncestor(repo, task.sha, tip))) {
			return {
				error: `${task.id} was accepted as ${task.sha.slice(0, 8)}, but that commit is not part of ${store.ref}: the accepted work does not match the run's records, so nothing was merged.`,
			};
		}
	}
	return { baseBranch, head, tip };
}

/** Publish the accepted tip or a new merge commit. Only an explicit --merge may land unchecked work. */
async function publishWork(
	store: RunStore,
	config: Config,
	verified: Task[],
	{ baseBranch, head, tip }: Ready,
	allowUnchecked: boolean,
): Promise<{ sha: string } | { error: string; skipped?: boolean }> {
	const repo = store.workDir;
	// About to move the user's branch: to a commit that was reviewed, not to one a restored ref points at.
	const reviewed = new Set(verified.flatMap((t) => (t.sha ? [t.sha] : [])));
	if (!reviewed.has(tip)) {
		return {
			error:
				reviewed.size === 0
					? `The run has no accepted commit recorded for its verified tasks, so nothing was merged. Inspect ${store.ref}.`
					: `The accepted tip of this run (${tip.slice(0, 8)}) is none of the commits that were reviewed, so nothing was merged. Inspect ${store.ref}; it was changed outside Milhouse.`,
		};
	}
	const fastForward = await isAncestor(repo, head, tip);
	const tipChecked = verified.some((t) => t.sha === tip && t.checks_passed);
	if (!tipChecked || (!fastForward && !projectChecksEnabled(config))) {
		const reason = !tipChecked
			? "No passing project check was recorded for the accepted commit."
			: "No project check will run on the new merge commit.";
		if (!allowUnchecked) {
			log.warn(`Automatic merge deferred. ${reason}`);
			return { error: reason, skipped: true };
		}
		log.warn(`Explicit merge requested. ${reason}`);
	}
	const result = fastForward ? { sha: tip } : await mergeCandidate(store, config, head, tip);
	if ("error" in result) return result;
	// The checks can take minutes: publish only if the branch is exactly where it was when they began.
	if ((await resolveRef(repo, branchRef(baseBranch))) !== head) {
		return {
			error: `"${baseBranch}" changed while the merge was being checked. Nothing was merged and nothing of yours was touched; run: milhouse --merge`,
		};
	}
	const published = await publish(repo, baseBranch, head, result.sha);
	if (!published.ok) {
		return {
			error: `git refused to move "${baseBranch}" to the merged work: ${published.error}\nNothing was merged and nothing of yours was touched. If a file you changed stands in the way, commit or stash it; then run: milhouse --merge`,
		};
	}
	return result;
}

/** `explicit`: the user asked for this merge (--merge), so it may land unchecked work. */
export async function mergePhase(
	store: RunStore,
	config: Config,
	explicit: boolean,
): Promise<Outcome<string>[]> {
	const verified = store.loadTasks().filter((t) => t.status === "verified");
	if (verified.length === 0) {
		log.info("merge: no verified work to merge");
		return [];
	}
	const repo = store.workDir;

	const ready = await readyToMerge(store, verified, explicit);
	if ("error" in ready) return [{ ok: false, ...ready }];
	const { head, tip } = ready;
	let landed = head; // already contains the work when the tip is an ancestor of the branch
	let how = "";
	if (!(await isAncestor(repo, tip, head))) {
		const published = await publishWork(store, config, verified, ready, explicit);
		if ("error" in published) return [{ ok: false, ...published }];
		landed = published.sha;
		how = landed === tip ? "" : " with a merge commit";
	}

	// Checkpoint first, then record: a crash in between must not lose the new starting point.
	await acceptCommit(repo, store.ref, landed);
	store.setBase(landed);
	if (isWorktree(store.worktree)) await resetWorktree(store.worktree, store.ref);
	store.updateTasks(
		verified.map((t) => t.id),
		{ status: "merged" },
	);
	log.success(`merged ${verified.length} task(s)${how}`);
	return [{ ok: true, value: landed }];
}
