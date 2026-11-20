/** The starting commit has to pass the project's checks: otherwise every issue is blamed for what was broken already. */

import { existsSync } from "node:fs";
import { commandTimeoutMs, projectChecksEnabled } from "./config.ts";
import { runProjectChecks } from "./gates.ts";
import { acceptCommit, deleteRef } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config } from "./types.ts";
import { discardWorktree, prepareWorktree } from "./worktree.ts";

/** The checks on a new worktree at the starting commit: what is wrong, or null. */
async function checkOnStart(store: RunStore, config: Config): Promise<string | null> {
	// A new worktree: one that an earlier session left may hold what an interrupted attempt installed.
	if (existsSync(store.worktree)) await discardWorktree(store);
	await acceptCommit(store.workDir, store.ref, store.loadMeta().base_sha); // nothing is accepted yet
	const setupFailure = await prepareWorktree(store, config);
	if (setupFailure) return setupFailure;
	return runProjectChecks(store.worktree, config.commands, { timeoutMs: commandTimeoutMs(config) });
}

/** What is wrong with the starting commit, or null when it passes (or when nothing asks for the check). */
export async function checkBase(store: RunStore, config: Config): Promise<string | null> {
	if (!config.gates.baseline || !projectChecksEnabled(config)) return null;
	// Accepted work shows that the starting commit was usable; only a run that has none is checked.
	if (store.loadTasks().some((t) => t.sha)) return null;

	// A run that ends here has done nothing: no worktree and no ref of it stays behind.
	const leave = async (): Promise<void> => {
		if (existsSync(store.worktree)) await discardWorktree(store);
		await deleteRef(store.workDir, store.ref);
	};
	let failure: string | null;
	try {
		failure = await checkOnStart(store, config);
	} catch (err) {
		await leave().catch(() => {}); // the first error is the one to report
		throw err;
	}
	if (!failure) return null;
	await leave();
	return `The checks fail on the starting commit, before any change, so a run could not tell its own mistakes from what was broken already:\n${failure}\nFix that and start a new run. If the failure is what this run should fix, set gates.baseline to false; if the command only ran out of time, raise commandTimeoutMinutes.`;
}
