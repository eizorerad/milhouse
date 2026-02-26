/**
 * Daemon loop — cost extraction, budget enforcement, and run completion tracking
 *
 * Provides helpers for reading cost data from completed child runs,
 * accumulating totalCost across runs, and enforcing budget safety rails.
 *
 * The daemon spawns milhouse child processes. After each child exits,
 * extractRunCost reads its report.json and the cost is passed to
 * recordRunComplete, which stores it on the run entry. The accumulated
 * state.totalCost is then checked against the configured budget.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentRunId, getRunDir } from "../state/runs.ts";

// ============================================================================
// DAEMON STATE TYPES
// ============================================================================

/** A single run entry tracked by the daemon */
export interface DaemonRunEntry {
	/** Run ID from the child process */
	runId?: string;
	/** Child process exit code */
	exitCode: number;
	/** Whether the child was killed by the watchdog */
	killedByWatchdog: boolean;
	/** Run duration in milliseconds */
	duration: number;
	/** Cost of this run in USD (extracted from report.json) */
	cost?: number;
	/** Timestamp when the run completed */
	completedAt: string;
}

/** Daemon session state — tracks accumulated cost across child runs */
export interface DaemonState {
	/** Total accumulated cost across all child runs (USD) */
	totalCost: number;
	/** Completed run entries */
	runs: DaemonRunEntry[];
	/** Daemon start time */
	startedAt: string;
}

/** Result from a child process spawn */
export interface WatchdogResult {
	exitCode: number;
	killedByWatchdog: boolean;
	duration: number;
}

/** Safety rail check result */
export interface SafetyRailResult {
	/** The rail that was violated, or null if all clear */
	violated: "budget-exceeded" | null;
	/** Human-readable message */
	message?: string;
}

// ============================================================================
// STATE FACTORY
// ============================================================================

/** Create initial daemon state */
export function createDaemonState(): DaemonState {
	return {
		totalCost: 0,
		runs: [],
		startedAt: new Date().toISOString(),
	};
}

// ============================================================================
// COST EXTRACTION
// ============================================================================

/**
 * Extract the total cost from a completed run's report.json.
 *
 * Reads `.milhouse/runs/<runId>/reports/report.json`, parses JSON,
 * and returns `cost.total` (USD). Returns null when cost cannot be
 * determined:
 * - Missing report.json (child crashed before generating it)
 * - Corrupt / invalid JSON
 * - Missing or non-numeric cost.total field
 * - Child killed by watchdog before report generation
 * - Negative cost values (defensive)
 *
 * A return value of 0 means the run genuinely cost nothing.
 * A return value of null means cost extraction failed.
 */
export function extractRunCost(runId: string, workDir: string): number | null {
	try {
		const runDir = getRunDir(runId, workDir);
		const reportPath = join(runDir, "reports", "report.json");

		if (!existsSync(reportPath)) {
			return null;
		}

		const raw = readFileSync(reportPath, "utf-8");
		const report = JSON.parse(raw);

		const total = report?.cost?.total;
		if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
			return null;
		}

		return total;
	} catch {
		return null;
	}
}

// ============================================================================
// RUN COMPLETION
// ============================================================================

/**
 * Record a completed child run with cost data.
 *
 * Creates a DaemonRunEntry from the watchdog result and extracted cost,
 * then pushes it onto state.runs.
 */
export function recordRunComplete(
	state: DaemonState,
	result: WatchdogResult & { runId?: string; cost?: number },
): DaemonRunEntry {
	const entry: DaemonRunEntry = {
		runId: result.runId,
		exitCode: result.exitCode,
		killedByWatchdog: result.killedByWatchdog,
		duration: result.duration,
		cost: result.cost,
		completedAt: new Date().toISOString(),
	};
	state.runs.push(entry);
	return entry;
}

/**
 * Process a completed child run: extract cost, record, and accumulate totalCost.
 *
 * This is the core wiring that fixes the budget enforcement bug.
 * After spawnWithWatchdog returns:
 * 1. Read the child's run ID via getCurrentRunId
 * 2. Extract cost from the child's report.json
 * 3. Record the run with cost data
 * 4. Accumulate state.totalCost so the budget safety rail can trigger
 */
export function processRunCompletion(
	state: DaemonState,
	result: WatchdogResult,
	workDir: string,
): DaemonRunEntry {
	// 1. Get the run ID the child process created
	const childRunId = getCurrentRunId(workDir) ?? undefined;

	// 2. Extract cost from the child's report.json
	const runCost = childRunId ? extractRunCost(childRunId, workDir) : null;

	// 3. Record the run with cost data
	const entry = recordRunComplete(state, {
		exitCode: result.exitCode,
		killedByWatchdog: result.killedByWatchdog,
		duration: result.duration,
		runId: childRunId,
		cost: runCost ?? undefined,
	});

	// 4. CRITICAL: Accumulate totalCost — this was the missing line that
	//    caused the budget safety rail to never trigger
	state.totalCost += entry.cost ?? 0;

	return entry;
}

// ============================================================================
// SAFETY RAILS
// ============================================================================

/**
 * Check safety rails before starting the next run.
 *
 * Returns a result indicating which rail was violated (if any).
 * Budget check: if budget > 0 and state.totalCost >= budget, return budget-exceeded.
 */
export function checkSafetyRails(state: DaemonState, budget: number): SafetyRailResult {
	if (budget > 0 && state.totalCost >= budget) {
		return {
			violated: "budget-exceeded",
			message: `Budget limit $${budget.toFixed(2)} reached (spent: $${state.totalCost.toFixed(2)})`,
		};
	}
	return { violated: null };
}
