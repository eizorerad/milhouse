/** The starting commit has to pass the project's checks: otherwise every issue is blamed for what was broken already. */

import { existsSync } from "node:fs";
import { commandTimeoutMs, projectChecksEnabled } from "./config.ts";
import { runProjectChecks } from "./gates.ts";
import { deleteRef } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config } from "./types.ts";
import { Progress, formatDuration, log } from "./ui.ts";
import { discardWorktree, prepareWorktree } from "./worktree.ts";

/** What is wrong with the starting commit, or null when it passes (or when nothing asks for the check). */
export async function checkBase(store: RunStore, config: Config): Promise<string | null> {
	if (!config.gates.baseline || !projectChecksEnabled(config)) return null;
	// Accepted work shows that the starting commit was usable; only a run that has none is checked.
	if (store.loadTasks().some((t) => t.sha || t.status === "verified" || t.status === "merged")) {
		return null;
	}

	// A run that ends here has done nothing: no worktree and no ref of it stays behind.
	const leave = async (): Promise<void> => {
		if (existsSync(store.worktree)) await discardWorktree(store);
		await deleteRef(store.workDir, store.ref);
	};
	// Setup and the checks can take minutes without a word of their own: show each step while it runs.
	log.info("Checking the starting commit on a clean copy: this can take a few minutes");
	const steps = Object.values(config.commands).filter((command) => command.trim()).length;
	const progress = new Progress("checking the starting commit", steps);
	const startedAt = Date.now();
	let failure: string | null = null;
	let passed = false;
	try {
		// A new start: a worktree or a ref that an earlier session left may not be at the starting commit.
		await leave();
		failure =
			(await prepareWorktree(store, config, { progress })) ??
			(await runProjectChecks(store.worktree, config.commands, {
				timeoutMs: commandTimeoutMs(config),
				progress,
			}));
		passed = failure === null;
	} finally {
		progress.stop();
		if (!passed) await leave().catch(() => {}); // an error of the cleanup must not hide the real one
	}
	if (!failure) {
		log.success(
			`The starting commit passes its checks (${formatDuration(Date.now() - startedAt)})`,
		);
		return null;
	}
	if (failure.startsWith("setup failed")) {
		return `${failure}\nFix the setup (commands.setup) and start a new run.`;
	}
	return `The checks fail on the starting commit, before any change, so a run could not tell its own mistakes from what was broken already:\n${failure}\nFix that and start a new run. If the failure is what this run should fix, start it with --no-baseline; if the checks need a file that git does not track, copy it in commands.setup (cp "$MILHOUSE_PROJECT/.env" .); if the command only ran out of time, raise commandTimeoutMinutes.`;
}
