/**
 * OS timer template generators for daemon install/uninstall
 *
 * Pure functions that generate OS-specific timer configuration content
 * and resolve file paths. This module has NO side effects (no fs writes).
 */

import { join } from "node:path";
import { homedir } from "node:os";

export interface TimerOptions {
	/** Path to the milhouse executable */
	execPath: string;
	/** Working directory for the daemon */
	workDir: string;
	/** Interval between daemon runs in minutes */
	intervalMinutes: number;
	/** Optional scope label for the timer */
	scope?: string;
}

export type TimerPlatform = "systemd" | "launchd" | "schtasks";

/**
 * Detect the timer platform based on the current OS.
 */
export function getTimerPlatform(): TimerPlatform {
	switch (process.platform) {
		case "linux":
			return "systemd";
		case "darwin":
			return "launchd";
		case "win32":
			return "schtasks";
		default:
			return "systemd";
	}
}

// ============================================================================
// SYSTEMD (Linux)
// ============================================================================

export interface SystemdUnit {
	service: string;
	timer: string;
	servicePath: string;
	timerPath: string;
}

/**
 * Generate systemd user service + timer unit files.
 */
export function generateSystemdUnit(opts: TimerOptions): SystemdUnit {
	const intervalSec = opts.intervalMinutes * 60;
	const unitName = "milhouse";

	const configDir = join(homedir(), ".config", "systemd", "user");
	const servicePath = join(configDir, `${unitName}.service`);
	const timerPath = join(configDir, `${unitName}.timer`);

	const service = `[Unit]
Description=Milhouse daemon tick
After=default.target

[Service]
Type=oneshot
ExecStart=${opts.execPath} daemon tick
WorkingDirectory=${opts.workDir}
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;

	const timer = `[Unit]
Description=Milhouse daemon timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=${intervalSec}s
Persistent=true

[Install]
WantedBy=timers.target
`;

	return { service, timer, servicePath, timerPath };
}

// ============================================================================
// LAUNCHD (macOS)
// ============================================================================

export interface LaunchdPlist {
	plist: string;
	plistPath: string;
}

/**
 * Generate launchd plist for macOS.
 */
export function generateLaunchdPlist(opts: TimerOptions): LaunchdPlist {
	const label = "com.milhouse.daemon";
	const intervalSec = opts.intervalMinutes * 60;
	const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${opts.execPath}</string>
		<string>daemon</string>
		<string>tick</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${opts.workDir}</string>
	<key>StartInterval</key>
	<integer>${intervalSec}</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${join(homedir(), "Library", "Logs", "milhouse-daemon.log")}</string>
	<key>StandardErrorPath</key>
	<string>${join(homedir(), "Library", "Logs", "milhouse-daemon.err")}</string>
</dict>
</plist>
`;

	return { plist, plistPath };
}

// ============================================================================
// SCHTASKS (Windows)
// ============================================================================

export interface SchtasksXml {
	xml: string;
	taskName: string;
}

/**
 * Generate Windows Task Scheduler XML.
 */
export function generateSchtasksXml(opts: TimerOptions): SchtasksXml {
	const taskName = "milhouse-daemon";
	const intervalMinutes = opts.intervalMinutes;

	const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${intervalMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions>
    <Exec>
      <Command>${opts.execPath}</Command>
      <Arguments>daemon tick</Arguments>
      <WorkingDirectory>${opts.workDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

	return { xml, taskName };
}
