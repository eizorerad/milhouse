/** The starting commit has to pass the project's checks: otherwise every issue is blamed for what was broken already. */

import { commandTimeoutMs, projectChecksEnabled } from "./config.ts";
import { runProjectChecks } from "./gates.ts";
import { resetWorktree } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config } from "./types.ts";
import { cleanupRun, discardWorktree, prepareWorktree } from "./worktree.ts";

/** What is wrong with the starting commit, or null when it passes (or when nothing asks for the check). */
export async function checkBase(store: RunStore, config: Config): Promise<string | null> {
	if (!config.gates.baseline || !projectChecksEnabled(config)) return null;
	// Accepted work shows that the starting commit was usable; only a run that has none is checked.
	if (store.loadTasks().some((t) => t.status === "verified" || t.status === "merged")) return null;

	// A new worktree: one that an earlier session left may hold what an interrupted attempt installed.
	await discardWorktree(store);
	const setupFailure = await prepareWorktree(store, config);
	if (setupFailure) {
		await cleanupRun(store);
		return setupFailure;
	}
	await resetWorktree(store.worktree, store.loadMeta().base_sha);
	const failure = await runProjectChecks(store.worktree, config.commands, {
		timeoutMs: commandTimeoutMs(config),
	});
	if (!failure) return null;
	await cleanupRun(store); // the run ends here: nothing of it stays behind
	return `The checks fail on the starting commit, before any change, so a run could not tell its own mistakes from what was broken already:\n${failure}\nFix that and start a new run. If the failure is what this run should fix, set gates.baseline to false; if the command only ran out of time, raise commandTimeoutMinutes.`;
}
