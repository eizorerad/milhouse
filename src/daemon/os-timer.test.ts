import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	getTimerPlatform,
	generateSystemdUnit,
	generateLaunchdPlist,
	generateSchtasksXml,
	type TimerOptions,
} from "./os-timer.ts";

const defaultOpts: TimerOptions = {
	execPath: "/usr/local/bin/milhouse",
	workDir: "/home/user/project",
	intervalMinutes: 30,
};

describe("getTimerPlatform", () => {
	test("returns a valid platform for the current OS", () => {
		const platform = getTimerPlatform();
		expect(["systemd", "launchd", "schtasks"]).toContain(platform);
	});

	test("returns schtasks on win32", () => {
		// On this Windows CI, process.platform === 'win32'
		if (process.platform === "win32") {
			expect(getTimerPlatform()).toBe("schtasks");
		}
	});

	test("returns launchd on darwin", () => {
		if (process.platform === "darwin") {
			expect(getTimerPlatform()).toBe("launchd");
		}
	});

	test("returns systemd on linux", () => {
		if (process.platform === "linux") {
			expect(getTimerPlatform()).toBe("systemd");
		}
	});
});

describe("generateSystemdUnit", () => {
	test("produces service with correct ExecStart", () => {
		const result = generateSystemdUnit(defaultOpts);
		expect(result.service).toContain(
			`ExecStart=${defaultOpts.execPath} daemon tick`,
		);
	});

	test("produces service with correct WorkingDirectory", () => {
		const result = generateSystemdUnit(defaultOpts);
		expect(result.service).toContain(
			`WorkingDirectory=${defaultOpts.workDir}`,
		);
	});

	test("produces timer with OnUnitActiveSec", () => {
		const result = generateSystemdUnit(defaultOpts);
		expect(result.timer).toContain("OnUnitActiveSec=1800s");
	});

	test("produces timer with [Unit], [Service], [Timer], [Install] sections", () => {
		const result = generateSystemdUnit(defaultOpts);
		expect(result.service).toContain("[Unit]");
		expect(result.service).toContain("[Service]");
		expect(result.service).toContain("[Install]");
		expect(result.timer).toContain("[Unit]");
		expect(result.timer).toContain("[Timer]");
		expect(result.timer).toContain("[Install]");
	});

	test("computes paths under ~/.config/systemd/user/", () => {
		const result = generateSystemdUnit(defaultOpts);
		const configDir = join(homedir(), ".config", "systemd", "user");
		expect(result.servicePath).toBe(join(configDir, "milhouse.service"));
		expect(result.timerPath).toBe(join(configDir, "milhouse.timer"));
	});

	test("handles custom interval values", () => {
		const result = generateSystemdUnit({ ...defaultOpts, intervalMinutes: 5 });
		expect(result.timer).toContain("OnUnitActiveSec=300s");
	});

	test("handles paths with spaces", () => {
		const opts: TimerOptions = {
			execPath: "/usr/local/my tools/milhouse",
			workDir: "/home/user/my project",
			intervalMinutes: 15,
		};
		const result = generateSystemdUnit(opts);
		expect(result.service).toContain("ExecStart=/usr/local/my tools/milhouse daemon tick");
		expect(result.service).toContain("WorkingDirectory=/home/user/my project");
	});
});

describe("generateLaunchdPlist", () => {
	test("produces valid plist XML with ProgramArguments", () => {
		const result = generateLaunchdPlist(defaultOpts);
		expect(result.plist).toContain("<key>ProgramArguments</key>");
		expect(result.plist).toContain(`<string>${defaultOpts.execPath}</string>`);
		expect(result.plist).toContain("<string>daemon</string>");
		expect(result.plist).toContain("<string>tick</string>");
	});

	test("produces plist with correct StartInterval", () => {
		const result = generateLaunchdPlist(defaultOpts);
		expect(result.plist).toContain("<key>StartInterval</key>");
		expect(result.plist).toContain("<integer>1800</integer>");
	});

	test("produces plist with WorkingDirectory", () => {
		const result = generateLaunchdPlist(defaultOpts);
		expect(result.plist).toContain("<key>WorkingDirectory</key>");
		expect(result.plist).toContain(`<string>${defaultOpts.workDir}</string>`);
	});

	test("computes plistPath under ~/Library/LaunchAgents/", () => {
		const result = generateLaunchdPlist(defaultOpts);
		expect(result.plistPath).toBe(
			join(homedir(), "Library", "LaunchAgents", "com.milhouse.daemon.plist"),
		);
	});

	test("handles custom interval values", () => {
		const result = generateLaunchdPlist({ ...defaultOpts, intervalMinutes: 10 });
		expect(result.plist).toContain("<integer>600</integer>");
	});

	test("handles paths with spaces", () => {
		const opts: TimerOptions = {
			execPath: "/usr/local/my tools/milhouse",
			workDir: "/home/user/my project",
			intervalMinutes: 15,
		};
		const result = generateLaunchdPlist(opts);
		expect(result.plist).toContain("<string>/usr/local/my tools/milhouse</string>");
		expect(result.plist).toContain("<string>/home/user/my project</string>");
	});

	test("produces valid XML structure", () => {
		const result = generateLaunchdPlist(defaultOpts);
		expect(result.plist).toContain('<?xml version="1.0"');
		expect(result.plist).toContain("<plist version=\"1.0\">");
		expect(result.plist).toContain("<dict>");
		expect(result.plist).toContain("</dict>");
		expect(result.plist).toContain("</plist>");
	});
});

describe("generateSchtasksXml", () => {
	test("produces XML with Triggers and Actions elements", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.xml).toContain("<Triggers>");
		expect(result.xml).toContain("</Triggers>");
		expect(result.xml).toContain("<Actions>");
		expect(result.xml).toContain("</Actions>");
	});

	test("produces XML with correct Command", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.xml).toContain(`<Command>${defaultOpts.execPath}</Command>`);
	});

	test("produces XML with correct Arguments", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.xml).toContain("<Arguments>daemon tick</Arguments>");
	});

	test("produces XML with correct repetition interval", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.xml).toContain("<Interval>PT30M</Interval>");
	});

	test("produces correct task name", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.taskName).toBe("milhouse-daemon");
	});

	test("handles custom interval values", () => {
		const result = generateSchtasksXml({ ...defaultOpts, intervalMinutes: 60 });
		expect(result.xml).toContain("<Interval>PT60M</Interval>");
	});

	test("handles paths with spaces", () => {
		const opts: TimerOptions = {
			execPath: "C:\\Program Files\\milhouse\\milhouse.exe",
			workDir: "C:\\Users\\user\\My Project",
			intervalMinutes: 15,
		};
		const result = generateSchtasksXml(opts);
		expect(result.xml).toContain("<Command>C:\\Program Files\\milhouse\\milhouse.exe</Command>");
		expect(result.xml).toContain("<WorkingDirectory>C:\\Users\\user\\My Project</WorkingDirectory>");
	});

	test("produces XML with WorkingDirectory", () => {
		const result = generateSchtasksXml(defaultOpts);
		expect(result.xml).toContain(
			`<WorkingDirectory>${defaultOpts.workDir}</WorkingDirectory>`,
		);
	});
});
