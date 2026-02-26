/**
 * Main daemon runner
 *
 * Wires together: process detection, lock cleanup, watchdog,
 * orchestrator/fallback decision, cost tracking, and safety rails.
 *
 * Uses helpers from loop.ts for cost extraction and budget enforcement.
 * Uses session-state.ts for persistent logging and state.
 */

import { logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { hardcodedDecision } from "./hardcoded-fallback.ts";
import {
	checkSafetyRails,
	createDaemonState,
	processRunCompletion,
} from "./loop.ts";
import { getOrchestratorDirective } from "./orchestrator.ts";
import { isAnyProcessRunning, waitForProcesses } from "./process-detect.ts";
import {
	appendLog,
	createSession,
	endSession,
	loadState,
	markSessionCrashed,
	recordOrchestratorDecision,
	recordRunStart,
	saveState,
} from "./session-state.ts";
import { writeSessionReport } from "./session-report.ts";
import { cleanStaleLocks } from "./stale-locks.ts";
import type {
	DaemonConfig,
	DaemonStartOptions,
	RunDirective,
} from "./types.ts";
import { spawnWithWatchdog } from "./watchdog.ts";

/**
 * Run the main daemon loop.
 * Entry point called by `milhouse daemon start`.
 */
export async function runDaemonLoop(
	options: DaemonStartOptions,
	config: DaemonConfig,
): Promise<void> {
	const { workDir, scope } = options;
	const abortController = new AbortController();

	// Handle graceful shutdown
	const shutdownHandler = () => {
		logWarn("Shutdown signal received, finishing current iteration...");
		abortController.abort();
	};
	process.on("SIGINT", shutdownHandler);
	process.on("SIGTERM", shutdownHandler);

	// Create session state (persistent)
	const sessionState = createSession(scope, workDir, options.inputPath);

	// Create daemon state (cost tracking from loop.ts)
	const daemonState = createDaemonState();

	appendLog(workDir, "daemon:start", {
		scope,
		inputPath: options.inputPath,
		budget: resolve(options.budget, config.safety.budgetLimit),
		maxRuns: resolve(options.maxRuns, config.safety.maxRuns),
		interval: resolve(options.interval, config.interval.betweenRuns),
	});

	logInfo(`Daemon started (session: ${sessionState.sessionId})`);
	logInfo(`Scope: ${scope}`);
	logInfo(
		`Budget: $${resolve(options.budget, config.safety.budgetLimit)} | ` +
			`Max runs: ${resolve(options.maxRuns, config.safety.maxRuns)} | ` +
			`Interval: ${resolve(options.interval, config.interval.betweenRuns)}min`,
	);

	const sessionStart = Date.now();
	let consecutiveFailures = 0;
	let totalRuns = 0;

	try {
		while (!abortController.signal.aborted) {
			// ── Step 1: Hard safety checks ──

			// Budget (from loop.ts helpers)
			const budgetLimit = resolve(options.budget, config.safety.budgetLimit);
			const budgetCheck = checkSafetyRails(daemonState, budgetLimit);
			if (budgetCheck.violated) {
				appendLog(workDir, "safety:budget-exceeded", { reason: budgetCheck.message });
				logWarn(`Safety stop: ${budgetCheck.message}`);
				break;
			}

			// Max runs
			const maxRuns = resolve(options.maxRuns, config.safety.maxRuns);
			if (maxRuns > 0 && totalRuns >= maxRuns) {
				appendLog(workDir, "safety:max-runs-reached", { maxRuns });
				logWarn(`Max runs limit (${maxRuns}) reached`);
				break;
			}

			// Consecutive failures
			if (consecutiveFailures >= config.safety.maxConsecutiveFailures) {
				appendLog(workDir, "safety:consecutive-failures", {
					count: consecutiveFailures,
				});
				logWarn(`${consecutiveFailures} consecutive failures — stopping`);
				break;
			}

			// Session duration
			const maxDuration = parseDuration(config.safety.maxSessionDuration);
			if (maxDuration > 0 && Date.now() - sessionStart > maxDuration) {
				appendLog(workDir, "safety:time-limit", {
					duration: config.safety.maxSessionDuration,
				});
				logInfo(`Session duration limit reached`);
				break;
			}

			// --until time
			if (options.until && isTimeReached(options.until)) {
				appendLog(workDir, "safety:time-limit", { until: options.until });
				logInfo(`Time limit reached (--until ${options.until})`);
				break;
			}

			// ── Step 2: Process detection ──

			const processNames = config.processDetection.waitFor;
			if (isAnyProcessRunning(processNames)) {
				logInfo("Detected running process, waiting...");
				appendLog(workDir, "process:detected", { names: processNames });

				const cleared = await waitForProcesses(processNames, {
					pollIntervalMs: config.interval.processCheckInterval * 1000,
					timeoutMs: 2 * 60 * 60 * 1000,
					signal: abortController.signal,
				});

				if (!cleared) {
					logWarn("Timed out waiting for processes");
					continue;
				}
				appendLog(workDir, "process:cleared");
			}

			// ── Step 3: Clean stale locks ──

			const cleaned = cleanStaleLocks(workDir);
			if (cleaned.length > 0) {
				appendLog(workDir, "lock:cleaned", { count: cleaned.length });
				logInfo(`Cleaned ${cleaned.length} stale lock(s)`);
			}

			// ── Step 4: Get directive ──

			let directive: RunDirective;

			if (options.noOrchestrator || !config.orchestrator.enabled) {
				directive = hardcodedDecision(sessionState, workDir, options.minSeverity);
				appendLog(workDir, "orchestrator:fallback", {
					action: directive.action,
					reasoning: directive.reasoning,
				});
			} else {
				directive = await getOrchestratorDirective(sessionState, config, options);
			}

			recordOrchestratorDecision(sessionState, directive);

			// ── Step 5: Act on directive ──

			if (directive.action === "stop") {
				appendLog(workDir, "stop:condition", {
					reason: directive.stopReason ?? directive.reasoning,
				});
				logSuccess(`Stop: ${directive.stopReason ?? directive.reasoning}`);
				break;
			}

			// ── Step 6: Build CLI args and spawn ──

			const args = buildMilhouseArgs(directive, options);
			const runEntry = recordRunStart(sessionState, directive);
			totalRuns++;

			appendLog(workDir, "run:start", { args, reasoning: directive.reasoning }, undefined, runEntry.number);
			logInfo(`\nRun #${runEntry.number}: ${directive.reasoning}`);

			const watchdogConfig = {
				activityTimeout: resolve(options.activityTimeout, config.watchdog.activityTimeout),
				runTimeout: resolve(options.runTimeout, config.watchdog.runTimeout),
				onTimeout: config.watchdog.onTimeout,
			};

			const result = options.noWatchdog
				? await spawnWithWatchdog(args, { ...watchdogConfig, activityTimeout: 0, runTimeout: 0 }, { workDir })
				: await spawnWithWatchdog(args, watchdogConfig, {
						workDir,
						signal: abortController.signal,
					});

			// ── Step 7: Record result with cost extraction ──

			const entry = processRunCompletion(daemonState, result, workDir);

			// Sync cost to persistent session state
			sessionState.totalCost = daemonState.totalCost;

			// Track consecutive failures
			if (result.exitCode === 0) {
				consecutiveFailures = 0;
			} else {
				consecutiveFailures++;
			}

			const durationMin = Math.round(result.duration / 60_000);
			if (result.killedByWatchdog) {
				appendLog(workDir, "watchdog:kill", { reason: result.killReason, duration: result.duration }, entry.runId, runEntry.number);
				logWarn(`Run #${runEntry.number} killed by watchdog after ${durationMin}min`);
			} else if (result.exitCode === 0) {
				appendLog(workDir, "run:complete", { duration: result.duration, cost: entry.cost }, entry.runId, runEntry.number);
				const costStr = typeof entry.cost === "number" ? `$${entry.cost.toFixed(2)}` : "unknown";
				logSuccess(`Run #${runEntry.number} completed in ${durationMin}min (cost: ${costStr})`);
			} else {
				appendLog(workDir, "run:failed", { exitCode: result.exitCode, duration: result.duration }, entry.runId, runEntry.number);
				logError(`Run #${runEntry.number} failed (exit ${result.exitCode}) after ${durationMin}min`);
			}

			if (daemonState.costExtractionFailures > 0) {
				logWarn(`Cost data unreliable: ${daemonState.costExtractionFailures} of ${daemonState.runs.length} runs have missing cost data`);
			}

			sessionState.totalRuns = totalRuns;
			sessionState.consecutiveFailures = consecutiveFailures;
			saveState(sessionState, workDir);

			// ── Step 8: Sleep ──

			if (!abortController.signal.aborted) {
				const intervalMin = resolve(options.interval, config.interval.betweenRuns);
				logInfo(`Sleeping ${intervalMin}min before next iteration...`);
				await sleep(intervalMin * 60 * 1000, abortController.signal);
			}
		}
	} catch (error) {
		appendLog(workDir, "daemon:crash", {
			error: error instanceof Error ? error.message : String(error),
		});
		markSessionCrashed(workDir);
		throw error;
	} finally {
		process.off("SIGINT", shutdownHandler);
		process.off("SIGTERM", shutdownHandler);
	}

	// Generate report and end session
	try {
		const reportResult = writeSessionReport(
			{ id: sessionState.sessionId, created_at: sessionState.startedAt, updated_at: new Date().toISOString(), phase: "completed" as const, issues_found: 0, issues_validated: 0, tasks_total: 0, tasks_completed: 0, tasks_failed: 0 },
			workDir,
		);
		appendLog(workDir, "report:generated", { path: reportResult });
		logInfo(`Report generated`);
	} catch {
		logWarn("Failed to generate session report");
	}

	appendLog(workDir, "daemon:stop", {
		totalRuns,
		totalCost: daemonState.totalCost,
		consecutiveFailures,
	});

	endSession(sessionState, workDir);
	logSuccess(`\nDaemon session complete. Runs: ${totalRuns}, Cost: $${daemonState.totalCost.toFixed(2)}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildMilhouseArgs(
	directive: RunDirective,
	options: DaemonStartOptions,
): string[] {
	const args: string[] = [];

	if (directive.resume) {
		args.push("--resume");
		if (directive.runId) args.push("--run-id", directive.runId);
	} else {
		args.push("--run");
	}

	if (directive.scope) args.push("--scope", directive.scope);
	if (directive.startPhase) args.push("--start-phase", directive.startPhase);
	if (directive.minSeverity ?? options.minSeverity) {
		args.push("--min-severity", (directive.minSeverity ?? options.minSeverity)!);
	}
	if (options.inputPath) args.push("--input", options.inputPath);
	if (options.engine) args.push(`--${options.engine}`);
	if (options.model) args.push("--model", options.model);
	if (options.endPhase) args.push("--end-phase", options.endPhase);
	if (directive.issueIds?.length) args.push("--issues", directive.issueIds.join(","));
	if (directive.excludeIssueIds?.length) args.push("--exclude-issues", directive.excludeIssueIds.join(","));

	return args;
}

function resolve<T>(override: T | undefined, fallback: T): T {
	return override !== undefined ? override : fallback;
}

function isTimeReached(until: string): boolean {
	const [hours, minutes] = until.split(":").map(Number);
	if (Number.isNaN(hours) || Number.isNaN(minutes)) return false;
	const now = new Date();
	const target = new Date();
	target.setHours(hours, minutes, 0, 0);
	return now >= target;
}

function parseDuration(str: string): number {
	let ms = 0;
	const h = str.match(/(\d+)h/);
	const m = str.match(/(\d+)m/);
	if (h) ms += Number.parseInt(h[1], 10) * 3_600_000;
	if (m) ms += Number.parseInt(m[1], 10) * 60_000;
	return ms;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}
