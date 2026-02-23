/**
 * Daemon command dispatcher
 *
 * Routes daemon subcommands: start, stop, status, log, tick, report, install, uninstall.
 */

import { logError, logInfo } from "../../ui/logger.ts";
import type { RuntimeOptions } from "../runtime-options.ts";

export interface DaemonCommandOptions {
	workDir: string;
	options?: RuntimeOptions;
}

export async function daemonCommand(
	subcommand: string | undefined,
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const cmd = subcommand ?? "status";

	switch (cmd) {
		case "start": {
			const { daemonStart } = await import("./daemon/start.ts");
			await daemonStart(args, opts);
			break;
		}

		case "stop": {
			const { daemonStop } = await import("./daemon/stop.ts");
			await daemonStop(args, opts);
			break;
		}

		case "status": {
			const { daemonStatus } = await import("./daemon/status.ts");
			await daemonStatus(opts);
			break;
		}

		case "log": {
			const { daemonLog } = await import("./daemon/log.ts");
			await daemonLog(args, opts);
			break;
		}

		case "tick": {
			const { daemonTick } = await import("./daemon/tick.ts");
			await daemonTick(args, opts);
			break;
		}

		case "report": {
			const { daemonReport } = await import("./daemon/report.ts");
			await daemonReport(args, opts);
			break;
		}

		case "install": {
			const { daemonInstall } = await import("./daemon/install.ts");
			await daemonInstall(args, opts);
			break;
		}

		case "uninstall": {
			const { daemonUninstall } = await import("./daemon/uninstall.ts");
			await daemonUninstall(args, opts);
			break;
		}

		default:
			logError(`Unknown daemon subcommand: "${cmd}"`);
			logInfo("Available: start, stop, status, log, tick, report, install, uninstall");
			process.exit(1);
	}
}
