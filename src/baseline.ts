/** The starting commit has to pass the project's checks: otherwise every issue is blamed for what was broken already. */

import { commandTimeoutMs, projectChecksEnabled } from "./config.ts";
import { runProjectChecks } from "./gates.ts";
import { resetWorktree } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config } from "./types.ts";
import { prepareWorktree } from "./worktree.ts";

/** What is wrong with the starting commit, or null when it passes (or when nothing asks for the check). */
export async function checkBase(store: RunStore, config: Config): Promise<string | null> {
	if (!config.gates.baseline || !projectChecksEnabled(config)) return null;
	// Accepted work shows that the starting commit was usable; only a run that has none is checked.
	if (store.loadTasks().some((t) => t.status === "verified" || t.status === "merged")) return null;

	const setupFailure = await prepareWorktree(store, config);
	if (setupFailure) return setupFailure;
	await resetWorktree(store.worktree, store.ref); // nothing is accepted yet: the ref is the starting commit
	const failure = await runProjectChecks(store.worktree, config.commands, {
		timeoutMs: commandTimeoutMs(config),
	});
	if (!failure) return null;
	return `The checks fail on the starting commit, before any change, so no issue could pass them:\n${failure}\nFix that first (raise commandTimeoutMinutes if the command only ran out of time), or set gates.baseline to false to go on anyway.`;
}
