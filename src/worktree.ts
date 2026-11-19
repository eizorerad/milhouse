/** The run's worktree, ready to use: created at the accepted ref, with `commands.setup` done. */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { COMMAND_TIMEOUT_MS, runChecks } from "./gates.ts";
import { ensureWorktree, isAncestor, removeWorktree, resolveRef } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config } from "./types.ts";

/** Written only after setup succeeded, so a setup that was interrupted is run again. */
const setupMarker = (store: RunStore): string => `${store.worktree}.ready`;

/**
 * Make the worktree usable. `commands.setup` runs whenever the worktree is new or its setup never
 * finished (also when it was removed and recreated later, for example for a merge).
 * Returns a description of the failure when setup fails; the worktree is then removed so that the
 * next call sets up again.
 */
export async function prepareWorktree(
	store: RunStore,
	config: Config,
	opts: { setupAgain?: boolean } = {},
): Promise<string | null> {
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
	const { created } = await ensureWorktree(store.workDir, store.worktree, store.ref, base);
	const marker = setupMarker(store);
	// `setupAgain`: the worktree was moved to another commit, which may need what the first one did not.
	if (created || opts.setupAgain) rmSync(marker, { force: true });
	if (!config.commands.setup || existsSync(marker)) return null;

	// reap=false: a service that setup starts on purpose is allowed to stay.
	const failure = await runChecks(
		[["setup", config.commands.setup]],
		store.worktree,
		COMMAND_TIMEOUT_MS,
		false,
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
	await removeWorktree(store.workDir, store.worktree);
	rmSync(setupMarker(store), { force: true });
}
