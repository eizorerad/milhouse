/**
 * milhouse daemon stop [--force]
 */

import { existsSync, rmSync } from "node:fs";
import {
	getDaemonPidPath,
	readDaemonPid,
} from "../../../daemon/session-state.ts";
import { logError, logInfo, logSuccess } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

export async function daemonStop(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const { workDir } = opts;
	const force = args.includes("--force");

	const pid = readDaemonPid(workDir);
	if (pid === null) {
		logInfo("No running daemon found.");
		return;
	}

	logInfo(`Sending ${force ? "SIGKILL" : "SIGTERM"} to daemon (PID ${pid})...`);

	try {
		process.kill(pid, force ? "SIGKILL" : "SIGTERM");
		logSuccess(`Signal sent to PID ${pid}`);

		if (!force) {
			logInfo("Daemon will finish current run before stopping.");
			logInfo("Use --force to kill immediately.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") {
			logError(`PID ${pid} not found — daemon may have already stopped.`);
			// Clean up stale PID file
			const pidPath = getDaemonPidPath(workDir);
			if (existsSync(pidPath)) {
				rmSync(pidPath);
			}
		} else {
			logError(`Failed to stop daemon: ${error}`);
		}
	}
}
