/**
 * Daemon install subcommand
 *
 * Installs an OS timer to run `milhouse daemon tick` at a configurable interval.
 * Supports systemd (Linux), launchd (macOS), and Task Scheduler (Windows).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTimerPlatform,
	generateSystemdUnit,
	generateLaunchdPlist,
	generateSchtasksXml,
	type TimerOptions,
} from "../../../daemon/os-timer.ts";
import { logError, logInfo, logSuccess, logWarn } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";

const DEFAULT_INTERVAL_MINUTES = 30;

function parseArgs(args: string[]): { interval: number; force: boolean; scope?: string } {
	let interval = DEFAULT_INTERVAL_MINUTES;
	let force = false;
	let scope: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--interval" && args[i + 1]) {
			interval = Number.parseInt(args[i + 1], 10);
			if (Number.isNaN(interval) || interval < 1) {
				logError("Invalid interval value. Must be a positive integer (minutes).");
				process.exit(1);
			}
			i++;
		} else if (args[i] === "--force") {
			force = true;
		} else if (args[i] === "--scope" && args[i + 1]) {
			scope = args[i + 1];
			i++;
		}
	}

	return { interval, force, scope };
}

function getExecPath(): string {
	return process.argv[0];
}

/**
 * Install an OS timer for the milhouse daemon.
 */
export async function daemonInstall(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const { interval, force, scope } = parseArgs(args);
	const platform = getTimerPlatform();

	const timerOpts: TimerOptions = {
		execPath: getExecPath(),
		workDir: opts.workDir,
		intervalMinutes: interval,
		scope,
	};

	switch (platform) {
		case "systemd":
			await installSystemd(timerOpts, force);
			break;
		case "launchd":
			await installLaunchd(timerOpts, force);
			break;
		case "schtasks":
			await installSchtasks(timerOpts, force);
			break;
	}
}

async function installSystemd(opts: TimerOptions, force: boolean): Promise<void> {
	const { service, timer, servicePath, timerPath } = generateSystemdUnit(opts);

	if (!force && (existsSync(servicePath) || existsSync(timerPath))) {
		logWarn("Milhouse daemon timer is already installed.");
		logInfo(`Service: ${servicePath}`);
		logInfo(`Timer: ${timerPath}`);
		logInfo("Use --force to overwrite the existing installation.");
		return;
	}

	// Ensure directory exists
	mkdirSync(dirname(servicePath), { recursive: true });

	// Write unit files
	writeFileSync(servicePath, service);
	writeFileSync(timerPath, timer);

	// Enable and start the timer
	try {
		execSync("systemctl --user daemon-reload", { stdio: "pipe" });
		execSync("systemctl --user enable --now milhouse.timer", { stdio: "pipe" });
	} catch (err) {
		logError(`Failed to enable systemd timer: ${err instanceof Error ? err.message : String(err)}`);
		logInfo(`Files written to:\n  ${servicePath}\n  ${timerPath}`);
		logInfo("You may need to manually run: systemctl --user enable --now milhouse.timer");
		return;
	}

	logSuccess("Milhouse daemon timer installed (systemd).");
	logInfo(`Service: ${servicePath}`);
	logInfo(`Timer: ${timerPath}`);
	logInfo(`Interval: every ${opts.intervalMinutes} minutes`);
	logInfo("Check status: systemctl --user status milhouse.timer");
}

async function installLaunchd(opts: TimerOptions, force: boolean): Promise<void> {
	const { plist, plistPath } = generateLaunchdPlist(opts);

	if (!force && existsSync(plistPath)) {
		logWarn("Milhouse daemon timer is already installed.");
		logInfo(`Plist: ${plistPath}`);
		logInfo("Use --force to overwrite the existing installation.");
		return;
	}

	// Ensure directory exists
	mkdirSync(dirname(plistPath), { recursive: true });

	// Unload existing if force-overwriting
	if (force && existsSync(plistPath)) {
		try {
			execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
		} catch {
			// Ignore — may not be loaded
		}
	}

	// Write plist
	writeFileSync(plistPath, plist);

	// Load the plist
	try {
		execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
	} catch (err) {
		logError(`Failed to load launchd plist: ${err instanceof Error ? err.message : String(err)}`);
		logInfo(`Plist written to: ${plistPath}`);
		logInfo(`You may need to manually run: launchctl load "${plistPath}"`);
		return;
	}

	logSuccess("Milhouse daemon timer installed (launchd).");
	logInfo(`Plist: ${plistPath}`);
	logInfo(`Interval: every ${opts.intervalMinutes} minutes`);
	logInfo(`Check status: launchctl list | grep milhouse`);
}

async function installSchtasks(opts: TimerOptions, force: boolean): Promise<void> {
	const { xml, taskName } = generateSchtasksXml(opts);

	// Check if task already exists
	if (!force) {
		try {
			execSync(`schtasks /Query /TN "${taskName}"`, { stdio: "pipe" });
			logWarn("Milhouse daemon timer is already installed.");
			logInfo(`Task: ${taskName}`);
			logInfo("Use --force to overwrite the existing installation.");
			return;
		} catch {
			// Task doesn't exist — proceed with install
		}
	}

	// Write XML to temp file, import it, then clean up
	const tmpXmlPath = join(tmpdir(), `${taskName}.xml`);
	writeFileSync(tmpXmlPath, xml);

	try {
		const forceFlag = force ? " /F" : "";
		execSync(`schtasks /Create /XML "${tmpXmlPath}" /TN "${taskName}"${forceFlag}`, {
			stdio: "pipe",
		});
	} catch (err) {
		logError(`Failed to create scheduled task: ${err instanceof Error ? err.message : String(err)}`);
		logInfo(`XML written to: ${tmpXmlPath}`);
		logInfo(`You may need to manually run: schtasks /Create /XML "${tmpXmlPath}" /TN "${taskName}"`);
		return;
	}

	// Clean up temp file
	try {
		const { unlinkSync } = await import("node:fs");
		unlinkSync(tmpXmlPath);
	} catch {
		// Ignore cleanup failure
	}

	logSuccess("Milhouse daemon timer installed (Task Scheduler).");
	logInfo(`Task: ${taskName}`);
	logInfo(`Interval: every ${opts.intervalMinutes} minutes`);
	logInfo(`Check status: schtasks /Query /TN "${taskName}"`);
}
