/**
 * milhouse daemon log [--all] [--errors] [--follow]
 */

import pc from "picocolors";
import { readLog, readLogFiltered } from "../../../daemon/session-state.ts";
import type { DaemonLogEntry } from "../../../daemon/types.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

const ERROR_EVENTS = [
	"run:failed",
	"run:killed",
	"watchdog:kill",
	"watchdog:activity-timeout",
	"watchdog:run-timeout",
	"daemon:crash",
	"orchestrator:error",
	"safety:budget-exceeded",
	"safety:consecutive-failures",
] as const;

export async function daemonLog(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const { workDir } = opts;
	const showAll = args.includes("--all");
	const errorsOnly = args.includes("--errors");

	let entries: DaemonLogEntry[];

	if (errorsOnly) {
		entries = readLogFiltered(workDir, [...ERROR_EVENTS]);
	} else {
		entries = readLog(workDir);
	}

	if (entries.length === 0) {
		console.log("\nNo daemon log entries found.\n");
		return;
	}

	// Show last 20 unless --all
	const display = showAll ? entries : entries.slice(-20);

	if (!showAll && entries.length > 20) {
		console.log(pc.dim(`\n  (showing last 20 of ${entries.length} entries, use --all for full log)\n`));
	} else {
		console.log();
	}

	for (const entry of display) {
		const time = formatTimestamp(entry.ts);
		const event = formatEvent(entry.event);
		const run = entry.runNumber ? pc.dim(` #${entry.runNumber}`) : "";
		const details = formatDetails(entry.details);

		console.log(`  ${time}  ${event}${run}  ${details}`);
	}

	console.log();
}

function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return pc.dim(`${d.toISOString().slice(0, 10)} ${h}:${m}:${s}`);
}

function formatEvent(event: string): string {
	if (event.startsWith("daemon:")) return pc.magenta(event.padEnd(28));
	if (event.startsWith("run:complete")) return pc.green(event.padEnd(28));
	if (event.startsWith("run:failed") || event.startsWith("run:killed"))
		return pc.red(event.padEnd(28));
	if (event.startsWith("watchdog:")) return pc.yellow(event.padEnd(28));
	if (event.startsWith("safety:")) return pc.red(event.padEnd(28));
	if (event.startsWith("orchestrator:")) return pc.cyan(event.padEnd(28));
	if (event.startsWith("stop:")) return pc.blue(event.padEnd(28));
	return pc.dim(event.padEnd(28));
}

function formatDetails(details: Record<string, unknown>): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(details)) {
		if (value === undefined || value === null) continue;

		if (key === "reason" || key === "reasoning") {
			parts.push(String(value));
		} else if (key === "duration" && typeof value === "number") {
			parts.push(`${Math.round(value / 60_000)}min`);
		} else if (key === "cost" && typeof value === "number") {
			parts.push(`$${(value as number).toFixed(2)}`);
		} else if (key === "count") {
			parts.push(`${value} cleaned`);
		} else if (key === "exitCode") {
			parts.push(`exit=${value}`);
		} else if (key === "totalRuns") {
			parts.push(`runs=${value}`);
		} else if (key === "totalCost" && typeof value === "number") {
			parts.push(`cost=$${(value as number).toFixed(2)}`);
		}
	}

	return pc.dim(parts.join("  "));
}
