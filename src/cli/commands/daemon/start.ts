/**
 * milhouse daemon start [scope] [options]
 */

import { loadUserConfig } from "../../../config/loader.ts";
import { DAEMON_DEFAULTS } from "../../../daemon/types.ts";
import type { DaemonConfig, DaemonStartOptions } from "../../../daemon/types.ts";
import { runDaemonLoop } from "../../../daemon/runner.ts";
import { readDaemonPid } from "../../../daemon/session-state.ts";
import { logError, logWarn } from "../../../ui/logger.ts";
import type { DaemonCommandOptions } from "../daemon.ts";
import type { RuntimeOptions } from "../../runtime-options.ts";

/**
 * Parse CLI args and start the daemon loop.
 */
export async function daemonStart(
	args: string[],
	opts: DaemonCommandOptions,
): Promise<void> {
	const { workDir } = opts;
	const runtimeOpts = opts.options;

	// Check if daemon is already running
	const existingPid = readDaemonPid(workDir);
	if (existingPid !== null) {
		logError(
			`Daemon is already running (PID ${existingPid}). ` +
				"Use 'milhouse daemon stop' first.",
		);
		process.exit(1);
	}

	// Scope is the first non-flag arg, or from --scope
	const scope = args.find((a) => !a.startsWith("--")) ?? runtimeOpts?.scanFocus ?? "";
	if (!scope) {
		logWarn(
			'No scope provided. Usage: milhouse daemon start "fix critical bugs"',
		);
		logWarn("Proceeding with empty scope (will use existing run state)");
	}

	// Load user config and merge daemon section
	const userConfig = await loadUserConfig(workDir);
	const daemonUserConfig = (userConfig as { daemon?: Partial<DaemonConfig> }).daemon;
	const daemonConfig = resolveDaemonConfig(daemonUserConfig);

	// Parse --flags from args
	const startOptions = parseStartFlags(args, scope, workDir, runtimeOpts ?? null);

	await runDaemonLoop(startOptions, daemonConfig);
}

function resolveDaemonConfig(
	user?: Partial<DaemonConfig>,
): DaemonConfig {
	if (!user) return DAEMON_DEFAULTS;

	return {
		orchestrator: {
			...DAEMON_DEFAULTS.orchestrator,
			...(user.orchestrator ? pick(user.orchestrator) : {}),
		},
		safety: {
			...DAEMON_DEFAULTS.safety,
			...(user.safety ? pick(user.safety) : {}),
		},
		interval: {
			...DAEMON_DEFAULTS.interval,
			...(user.interval ? pick(user.interval) : {}),
		},
		watchdog: {
			...DAEMON_DEFAULTS.watchdog,
			...(user.watchdog ? pick(user.watchdog) : {}),
		},
		processDetection: {
			...DAEMON_DEFAULTS.processDetection,
			...(user.processDetection ? pick(user.processDetection) : {}),
		},
		report: {
			...DAEMON_DEFAULTS.report,
			...(user.report ? pick(user.report) : {}),
			delivery: {
				...DAEMON_DEFAULTS.report.delivery,
				...(user.report?.delivery ? pick(user.report.delivery) : {}),
			},
		},
	};
}

function parseStartFlags(
	args: string[],
	scope: string,
	workDir: string,
	runtimeOpts: RuntimeOptions | null,
): DaemonStartOptions {
	const result: DaemonStartOptions = { scope, workDir };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];

		switch (arg) {
			case "--background":
			case "-bg":
				result.background = true;
				break;
			case "--interval":
				result.interval = Number.parseInt(next, 10);
				i++;
				break;
			case "--budget":
				result.budget = Number.parseFloat(next);
				i++;
				break;
			case "--max-runs":
				result.maxRuns = Number.parseInt(next, 10);
				i++;
				break;
			case "--until":
				result.until = next;
				i++;
				break;
			case "--min-severity":
				result.minSeverity = next;
				i++;
				break;
			case "--engine":
				result.engine = next;
				i++;
				break;
			case "--model":
				result.model = next;
				i++;
				break;
			case "--input":
				result.inputPath = next;
				i++;
				break;
			case "--resume":
				result.resume = true;
				break;
			case "--start-phase":
				result.startPhase = next;
				i++;
				break;
			case "--end-phase":
				result.endPhase = next;
				i++;
				break;
			case "--no-orchestrator":
				result.noOrchestrator = true;
				break;
			case "--no-watchdog":
				result.noWatchdog = true;
				break;
			case "--activity-timeout":
				result.activityTimeout = Number.parseInt(next, 10);
				i++;
				break;
			case "--run-timeout":
				result.runTimeout = Number.parseInt(next, 10);
				i++;
				break;
		}
	}

	// Inherit from runtime options if available
	if (runtimeOpts) {
		if (!result.engine && runtimeOpts.aiEngine && runtimeOpts.aiEngine !== "claude") {
			result.engine = runtimeOpts.aiEngine;
		}
		if (!result.model && runtimeOpts.modelOverride) {
			result.model = runtimeOpts.modelOverride;
		}
		if (!result.inputPath && runtimeOpts.prdFile && runtimeOpts.prdFile !== "PRD.md") {
			result.inputPath = runtimeOpts.prdFile;
		}
	}

	return result;
}

/** Remove undefined values from an object */
function pick<T extends object>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out as Partial<T>;
}
