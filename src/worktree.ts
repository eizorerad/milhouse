/** The run's worktree, ready to use: created at the accepted ref, with `commands.setup` done. */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { commandTimeoutMs } from "./config.ts";
import { runChecks } from "./gates.ts";
import {
	deleteBranch,
	deleteRef,
	ensureWorktree,
	isAncestor,
	removeWorktree,
	resetWorktree,
	resolveRef,
} from "./git.ts";
import { type RunStore, parkBranch } from "./state.ts";
import type { Config } from "./types.ts";

/** Written only after setup succeeded, so a setup that was interrupted is run again. */
const setupMarker = (store: RunStore): string => `${store.worktree}.ready`;

/** The run's worktree, made when it is not there. Returns whether it is new, or what is wrong with the run's ref. */
async function openWorktree(store: RunStore): Promise<{ created: boolean } | string> {
	const { base_sha: base } = store.loadMeta();
	const tip = await resolveRef(store.workDir, store.ref);
	// A lost ref must not be recreated at the starting point: work that was verified is not in it any more.
	if (tip === null && store.loadTasks().some((t) => t.status === "verified")) {
		return `setup failed: the accepted work of this run (${store.ref}) is missing although tasks were verified. Merge or inspect it by hand; start a new run for the rest.`;
	}
	if (tip !== null) {
		// Nothing but a commit that Milhouse accepted (the starting point, or one of the tasks') was reviewed;
		// what the user's branch contains already is no news. Anything else: the ref was moved by hand.
		const accepted = new Set([base, ...store.loadTasks().flatMap((t) => (t.sha ? [t.sha] : []))]);
		if (!accepted.has(tip) && !(await isAncestor(store.workDir, tip, "HEAD"))) {
			return `setup failed: ${store.ref} points at a commit that Milhouse never accepted, so it was changed outside Milhouse. Inspect it; start a new run to continue.`;
		}
	}
	return ensureWorktree(store.workDir, store.worktree, store.ref, base);
}

/**
 * The worktree for the steps that only read. Every agent sees the commit the run started from and the work
 * it accepted since, never the user's checkout as it happens to be. No setup: nothing is built or run here.
 * Returns what is wrong, or null.
 */
export async function readWorktree(store: RunStore): Promise<string | null> {
	const opened = await openWorktree(store);
	if (typeof opened === "string") return opened;
	await resetWorktree(store.worktree, store.ref); // not what an interrupted issue left in it
	return null;
}

/**
 * Make the worktree usable for work. `commands.setup` runs whenever the worktree is new or its setup never
 * finished (also when it was removed and recreated later, for example for a merge).
 * Returns a description of the failure when setup fails; the worktree is then removed so that the
 * next call sets up again.
 */
export async function prepareWorktree(
	store: RunStore,
	config: Config,
	opts: { setupAgain?: boolean } = {},
): Promise<string | null> {
	const opened = await openWorktree(store);
	if (typeof opened === "string") return opened;
	const { created } = opened;
	const marker = setupMarker(store);
	// `setupAgain`: the worktree was moved to another commit, which may need what the first one did not.
	if (created || opts.setupAgain) rmSync(marker, { force: true });
	if (!config.commands.setup || existsSync(marker)) return null;

	// reap=false: a service that setup starts on purpose is allowed to stay.
	const failure = await runChecks(
		store.worktree,
		{ setup: config.commands.setup },
		{ reap: false, timeoutMs: commandTimeoutMs(config) },
	);
	if (failure) {
		await removeWorktree(store.workDir, store.worktree);
		return failure;
	}
	writeFileSync(marker, "");
	return null;
}

/** Remove the worktree and its setup marker. */
export async function discardWorktree(store: RunStore): Promise<void> {
	const marker = setupMarker(store); // before the removal: a run of 0.5.1 changes its place once its worktree is gone
	await removeWorktree(store.workDir, store.worktree);
	rmSync(marker, { force: true });
}

/** At the end of a command that leaves the run unfinished: a worktree without a setup is made again in a moment, so it does not stay. */
export async function releaseWorktree(store: RunStore): Promise<void> {
	if (!existsSync(setupMarker(store))) await discardWorktree(store);
}

/** Remove the run's worktree, and its ref once everything in it is part of the user's branch. */
export async function cleanupRun(store: RunStore): Promise<void> {
	await discardWorktree(store);
	if (await isAncestor(store.workDir, store.ref, "HEAD")) await deleteRef(store.workDir, store.ref);
}

/**
 * Everything a run left outside its own directory, for `--clean`: the worktree, the ref and the parked
 * attempts. Throws when the ref holds accepted work that is not in the user's branch: the run's records are
 * what `--merge` needs, so the run has to stay.
 */
export async function removeRun(store: RunStore): Promise<void> {
	await discardWorktree(store);
	const repo = store.workDir;
	const tip = await resolveRef(repo, store.ref);
	const accepted = store
		.loadTasks()
		.some((t) => t.status === "verified" || (t.sha !== undefined && t.status !== "merged"));
	if (tip !== null && accepted && !(await isAncestor(repo, tip, "HEAD"))) {
		throw new Error(
			`it holds accepted work that was never merged. Merge it with: milhouse --merge --run-id ${store.runId} (or give it up with: git update-ref -d ${store.ref})`,
		);
	}
	await deleteRef(repo, store.ref);
	for (const issue of store.loadIssues()) await deleteBranch(repo, parkBranch(issue.id));
}
