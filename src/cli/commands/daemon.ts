/**
 * Daemon command dispatcher
 *
 * Routes daemon subcommands: tick, report, install, uninstall.
 */

import { logError } from "../../ui/logger.ts";

export interface DaemonCommandOptions {
	workDir: string;
}

export async function daemonCommand(
	subcommand: string,
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	switch (subcommand) {
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
			logError("daemon uninstall is not yet implemented");
			break;
		}

		default:
			logError(`Unknown daemon subcommand: ${subcommand}`);
			console.log("");
			console.log("Available commands:");
			console.log("  milhouse daemon report [--json]    - Generate session report");
			console.log("  milhouse daemon install [--interval <min>] [--force]  - Install OS timer");
			console.log("  milhouse daemon uninstall          - Remove OS timer");
			process.exit(1);
	}
}
