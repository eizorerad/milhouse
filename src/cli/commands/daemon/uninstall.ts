/**
 * Daemon uninstall subcommand
 *
 * Removes OS timers installed by the install command.
 * Supports systemd (Linux), launchd (macOS), and Task Scheduler (Windows).
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import {
	getTimerPlatform,
	generateSystemdUnit,
	generateLaunchdPlist,
	generateSchtasksXml,
	type TimerOptions,
} from "../../../daemon/os-timer.ts";
import { logError, logInfo, logSuccess } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

/**
 * Shared dummy opts for path resolution only.
 * The actual execPath/workDir/interval don't matter for uninstall —
 * we only need the file paths and task name.
 */
function pathOpts(workDir: string): TimerOptions {
	return {
		execPath: "",
		workDir,
		intervalMinutes: 0,
	};
}

/**
 * Remove the OS timer for the milhouse daemon.
 */
export async function daemonUninstall(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const platform = getTimerPlatform();

	switch (platform) {
		case "systemd":
			await uninstallSystemd(opts.workDir);
			break;
		case "launchd":
			await uninstallLaunchd(opts.workDir);
			break;
		case "schtasks":
			await uninstallSchtasks(opts.workDir);
			break;
	}
}

async function uninstallSystemd(workDir: string): Promise<void> {
	const { servicePath, timerPath } = generateSystemdUnit(pathOpts(workDir));

	if (!existsSync(servicePath) && !existsSync(timerPath)) {
		logInfo("Milhouse daemon timer is not installed (no systemd unit files found).");
		return;
	}

	// Disable and stop the timer
	try {
		execSync("systemctl --user disable --now milhouse.timer", { stdio: "pipe" });
	} catch {
		// May fail if not enabled — continue with file removal
	}

	// Remove unit files
	if (existsSync(timerPath)) unlinkSync(timerPath);
	if (existsSync(servicePath)) unlinkSync(servicePath);

	// Reload daemon
	try {
		execSync("systemctl --user daemon-reload", { stdio: "pipe" });
	} catch {
		// Ignore reload failure
	}

	logSuccess("Milhouse daemon timer removed (systemd).");
	logInfo(`Removed: ${servicePath}`);
	logInfo(`Removed: ${timerPath}`);
}

async function uninstallLaunchd(workDir: string): Promise<void> {
	const { plistPath } = generateLaunchdPlist(pathOpts(workDir));

	if (!existsSync(plistPath)) {
		logInfo("Milhouse daemon timer is not installed (no launchd plist found).");
		return;
	}

	// Unload the plist
	try {
		execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
	} catch {
		// May fail if not loaded — continue with file removal
	}

	// Remove plist file
	unlinkSync(plistPath);

	logSuccess("Milhouse daemon timer removed (launchd).");
	logInfo(`Removed: ${plistPath}`);
}

async function uninstallSchtasks(workDir: string): Promise<void> {
	const { taskName } = generateSchtasksXml(pathOpts(workDir));

	// Check if task exists
	try {
		execSync(`schtasks /Query /TN "${taskName}"`, { stdio: "pipe" });
	} catch {
		logInfo("Milhouse daemon timer is not installed (no scheduled task found).");
		return;
	}

	// Delete the task
	try {
		execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: "pipe" });
	} catch (err) {
		logError(`Failed to delete scheduled task: ${err instanceof Error ? err.message : String(err)}`);
		logInfo(`You may need to manually run: schtasks /Delete /TN "${taskName}" /F`);
		return;
	}

	logSuccess("Milhouse daemon timer removed (Task Scheduler).");
	logInfo(`Removed task: ${taskName}`);
}
