/**
 * milhouse daemon status
 */

import pc from "picocolors";
import {
	loadState,
	readDaemonPid,
} from "../../../daemon/session-state.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

export async function daemonStatus(opts: DaemonCommandOptions): Promise<void> {
	const { workDir } = opts;

	const pid = readDaemonPid(workDir);
	const state = loadState(workDir);

	if (pid !== null && state?.status === "running") {
		const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
		const lastRun = state.runs[state.runs.length - 1];

		console.log(`\n${pc.green("milhouse daemon")} ${pc.dim("—")} ${pc.green("RUNNING")} (PID ${pid}, since ${formatTime(state.startedAt)})\n`);
		console.log(`  Session:     ${elapsed} elapsed`);
		console.log(`  Scope:       ${state.scope || pc.dim("(none)")}`);
		console.log(`  Progress:    ${state.totalRuns} runs completed`);
		console.log(`  Cost:        $${state.totalCost.toFixed(2)}`);
		console.log(`  Failures:    ${state.consecutiveFailures} consecutive`);

		if (lastRun) {
			const status =
				lastRun.result === "pending"
					? pc.yellow("in progress")
					: lastRun.result === "success"
						? pc.green(lastRun.result)
						: pc.red(lastRun.result);
			console.log(`  Last run:    #${lastRun.number} — ${status}`);
		}
		console.log();
	} else if (state) {
		const elapsed = formatDuration(
			(state.runs[state.runs.length - 1]
				? new Date(state.runs[state.runs.length - 1].finishedAt ?? state.startedAt).getTime()
				: new Date(state.startedAt).getTime()) - new Date(state.startedAt).getTime(),
		);

		const statusColor =
			state.status === "stopped" ? pc.dim : pc.red;

		console.log(`\n${pc.green("milhouse daemon")} ${pc.dim("—")} ${statusColor(state.status.toUpperCase())}\n`);
		console.log(`  Last session: ${formatTime(state.startedAt)} (${elapsed})`);
		console.log(`  Scope:        ${state.scope || pc.dim("(none)")}`);
		console.log(`  Runs:         ${state.totalRuns}`);
		console.log(`  Cost:         $${state.totalCost.toFixed(2)}`);

		const successful = state.runs.filter((r) => r.result === "success" || r.result === "partial").length;
		const failed = state.runs.filter((r) => r.result === "failed" || r.result === "killed").length;
		console.log(`  Results:      ${pc.green(`${successful} ok`)} / ${pc.red(`${failed} failed`)}`);
		console.log();
	} else {
		console.log(`\n${pc.green("milhouse daemon")} ${pc.dim("— NOT RUNNING")}\n`);
		console.log(`  No previous session found.`);
		console.log(`  Start with: milhouse daemon start "your scope"\n`);
	}
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString();
}

function formatDuration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);

	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
