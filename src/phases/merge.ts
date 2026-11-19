/**
 * merge: bring the verified work of the run into the branch the run started from. No AI involved.
 *
 * Nothing reaches the user's branch before it was tested: when the branch moved during the run, the merge
 * commit is built and checked in the run's worktree, and only that tested commit is fast-forwarded into
 * the branch. If anything fails, the branch has not been touched.
 */

import { existsSync } from "node:fs";
import { runProjectChecks } from "../gates.ts";
import {
	acceptCommit,
	currentBranch,
	deleteRef,
	isAncestor,
	isDirty,
	mergeInto,
	publish,
	refExists,
	resetWorktree,
	revParse,
} from "../git.ts";
import type { Outcome } from "../runner.ts";
import type { RunStore } from "../state.ts";
import type { Config } from "../types.ts";
import { log } from "../ui.ts";
import { discardWorktree, prepareWorktree } from "../worktree.ts";

/** Remove the run's worktree, and its ref once everything in it is part of the user's branch. */
export async function cleanupRun(store: RunStore): Promise<void> {
	await discardWorktree(store);
	if (await isAncestor(store.workDir, store.ref, "HEAD")) await deleteRef(store.workDir, store.ref);
}

/** The commit to publish: the accepted tip itself, or a merge commit that was built and tested first. */
async function candidate(
	store: RunStore,
	config: Config,
	head: string,
	tip: string,
): Promise<{ sha: string } | { error: string }> {
	if (await isAncestor(store.workDir, head, tip)) return { sha: tip }; // same base: tested already

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
		const failure = await runProjectChecks(store.worktree, config.commands);
		if (failure) {
			return {
				error: `Merging would break the checks, so nothing was merged. The verified work stays in ${store.ref}.\n${failure}`,
			};
		}
	}
	return { sha: await revParse(store.worktree, "HEAD") };
}

export async function mergePhase(store: RunStore, config: Config): Promise<Outcome<string>[]> {
	const verified = store.loadTasks().filter((t) => t.status === "verified");
	if (verified.length === 0) {
		log.info("merge: no verified work to merge");
		return [];
	}
	const fail = (error: string): Outcome<string>[] => [{ ok: false, error }];
	const repo = store.workDir;
	const { base_branch: baseBranch } = store.loadMeta();

	if (!(await refExists(repo, store.ref))) {
		return fail(`The accepted work of this run (${store.ref}) is missing.`);
	}
	if ((await currentBranch(repo)) !== baseBranch) {
		return fail(`Check out "${baseBranch}" (the run started there), then run: milhouse --merge`);
	}
	if (await isDirty(repo)) {
		return fail(
			"The working tree has uncommitted changes. Commit or stash them, then run: milhouse --merge",
		);
	}

	const head = await revParse(repo, "HEAD");
	const tip = await revParse(repo, store.ref);
	// The records and the ref must agree: a ref that was lost and recreated would otherwise let work be
	// marked as merged that never was.
	for (const task of verified) {
		if (task.sha && !(await isAncestor(repo, task.sha, tip))) {
			return fail(
				`${task.id} was accepted as ${task.sha.slice(0, 8)}, but that commit is not part of ${store.ref}: the accepted work does not match the run's records, so nothing was merged.`,
			);
		}
	}
	let landed = head; // already contains the work when the tip is an ancestor of the branch
	let how = "";
	if (!(await isAncestor(repo, tip, head))) {
		const result = await candidate(store, config, head, tip);
		if ("error" in result) return fail(result.error);
		// The checks can take minutes: publish only if the branch is exactly where it was when they began.
		const unchanged =
			(await currentBranch(repo)) === baseBranch &&
			(await revParse(repo, "HEAD")) === head &&
			!(await isDirty(repo));
		if (!unchanged) {
			return fail(
				`"${baseBranch}" changed while the merge was being checked. Nothing was merged and nothing of yours was touched; run: milhouse --merge`,
			);
		}
		const published = await publish(repo, result.sha);
		if (!published.ok) {
			return fail(
				`git refused to move "${baseBranch}" to the merged work: ${published.error}\nNothing was merged and nothing of yours was touched; fix the cause, then run: milhouse --merge`,
			);
		}
		landed = result.sha;
		how = landed === tip ? "" : " with a merge commit";
	}

	// Checkpoint first, then record: a crash in between must not lose the new starting point.
	await acceptCommit(repo, store.ref, landed);
	store.setBase(landed);
	if (existsSync(store.worktree)) await resetWorktree(store.worktree, store.ref);
	store.updateTasks(
		verified.map((t) => t.id),
		{ status: "merged" },
	);
	log.success(`merged ${verified.length} task(s)${how}`);
	return [{ ok: true, value: landed }];
}
