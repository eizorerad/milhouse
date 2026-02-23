/**
 * milhouse daemon tick
 *
 * Single iteration mode for OS timers (systemd, launchd, cron, schtasks).
 * Checks conditions, runs one milhouse pipeline if appropriate, then exits.
 */

import { loadUserConfig } from "../../../config/loader.ts";
import { hardcodedDecision } from "../../../daemon/hardcoded-fallback.ts";
import { isAnyProcessRunning } from "../../../daemon/process-detect.ts";
import {
	appendLog,
	loadState,
	recordRunComplete,
	recordRunStart,
	saveState,
} from "../../../daemon/session-state.ts";
import { cleanStaleLocks } from "../../../daemon/stale-locks.ts";
import {
	DAEMON_DEFAULTS,
	type DaemonConfig,
	type DaemonStartOptions,
} from "../../../daemon/types.ts";
import { spawnWithWatchdog } from "../../../daemon/watchdog.ts";
import { logError, logInfo, logSuccess, logWarn } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

export async function daemonTick(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const { workDir } = opts;

	const userConfig = await loadUserConfig(workDir);
	const daemonConfig: DaemonConfig = {
		...DAEMON_DEFAULTS,
		...((userConfig as Record<string, unknown>).daemon as Partial<DaemonConfig>),
	};

	const minSeverity = getArgValue(args, "--min-severity") ?? "HIGH";

	logInfo(`Tick at ${new Date().toISOString()}`);

	// Step 1: Check if any relevant process is running
	const processNames = daemonConfig.processDetection.waitFor;
	if (isAnyProcessRunning(processNames)) {
		logInfo("Process already running, skipping tick.");
		return;
	}

	// Step 2: Clean stale locks
	const cleaned = cleanStaleLocks(workDir);
	if (cleaned.length > 0) {
		logInfo(`Cleaned ${cleaned.length} stale lock(s)`);
	}

	// Step 3: Load or create minimal session state
	let state = loadState(workDir);
	if (!state) {
		// Create a temporary state for decision-making
		const { createSession } = await import("../../../daemon/session-state.ts");
		state = createSession("daemon-tick", workDir);
	}

	// Step 4: Get directive via hardcoded fallback
	const directive = hardcodedDecision(state, workDir, minSeverity);

	if (directive.action === "stop") {
		logSuccess(`Stop: ${directive.stopReason ?? directive.reasoning}`);
		return;
	}

	// Step 5: Build args and run
	const cliArgs = buildTickArgs(directive, args);
	const runEntry = recordRunStart(state, directive);

	appendLog(workDir, "run:start", { source: "tick", args: cliArgs }, undefined, runEntry.number);
	logInfo(`Running pipeline: ${directive.reasoning}`);

	const result = await spawnWithWatchdog(cliArgs, daemonConfig.watchdog, { workDir });

	recordRunComplete(runEntry, {
		exitCode: result.exitCode,
		killedByWatchdog: result.killedByWatchdog,
		duration: result.duration,
	});

	saveState(state, workDir);

	const durationMin = Math.round(result.duration / 60_000);
	if (result.exitCode === 0) {
		appendLog(workDir, "run:complete", { duration: result.duration, source: "tick" });
		logSuccess(`Completed in ${durationMin}min`);
	} else {
		appendLog(workDir, "run:failed", { exitCode: result.exitCode, source: "tick" });
		logError(`Failed (exit ${result.exitCode}) after ${durationMin}min`);
	}
}

function buildTickArgs(
	directive: { scope?: string; resume?: boolean; runId?: string; minSeverity?: string },
	cliArgs: string[],
): string[] {
	const args: string[] = [];

	if (directive.resume) {
		args.push("--resume");
		if (directive.runId) args.push("--run-id", directive.runId);
	} else {
		args.push("--run");
	}

	if (directive.scope) {
		args.push("--scope", directive.scope);
	}

	const budget = getArgValue(cliArgs, "--budget");
	if (budget) args.push("--budget", budget);

	return args;
}

function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx >= 0 ? args[idx + 1] : undefined;
}
