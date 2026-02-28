/**
 * Daemon session state and logging
 *
 * Manages daemon-log.jsonl (append-only event log) and daemon-state.json
 * (current session state). Both files live in .milhouse/.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getMilhouseDir } from "../state/paths.ts";
import { saveJsonFile } from "../state/json-io.ts";
import type {
	DaemonLogEntry,
	DaemonEventType,
	DaemonRunEntry,
	DaemonState,
	RunDirective,
} from "./types.ts";

const DAEMON_LOG_FILE = "daemon-log.jsonl";
const DAEMON_STATE_FILE = "daemon-state.json";
const DAEMON_PID_FILE = "daemon.pid";

// ─── Paths ──────────────────────────────────────────────────────────────────

export function getDaemonLogPath(workDir: string): string {
	return join(getMilhouseDir(workDir), DAEMON_LOG_FILE);
}

export function getDaemonStatePath(workDir: string): string {
	return join(getMilhouseDir(workDir), DAEMON_STATE_FILE);
}

export function getDaemonPidPath(workDir: string): string {
	return join(getMilhouseDir(workDir), DAEMON_PID_FILE);
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

/**
 * Create a new daemon session. Writes initial state and PID file.
 */
export function createSession(
	scope: string,
	workDir: string,
	inputPath?: string,
): DaemonState {
	const milDir = getMilhouseDir(workDir);
	if (!existsSync(milDir)) {
		mkdirSync(milDir, { recursive: true });
	}

	const sessionId = `daemon-${formatDateForId(new Date())}-${randomSuffix()}`;

	const state: DaemonState = {
		sessionId,
		startedAt: new Date().toISOString(),
		scope,
		inputPath,
		pid: process.pid,
		status: "running",
		runs: [],
		consecutiveFailures: 0,
		totalCost: 0,
		costExtractionFailures: 0,
		totalRuns: 0,
		orchestratorDecisions: [],
	};

	saveState(state, workDir);
	writePidFile(workDir);

	return state;
}

/**
 * Mark session as stopped and clean up PID file.
 */
export function endSession(
	state: DaemonState,
	workDir: string,
): void {
	state.status = "stopped";
	saveState(state, workDir);
	removePidFile(workDir);
}

/**
 * Mark session as crashed.
 */
export function markSessionCrashed(workDir: string): void {
	const state = loadState(workDir);
	if (state) {
		state.status = "crashed";
		saveState(state, workDir);
	}
	removePidFile(workDir);
}

// ─── State persistence ──────────────────────────────────────────────────────

export function saveState(state: DaemonState, workDir: string): void {
	const path = getDaemonStatePath(workDir);
	saveJsonFile(path, state);
}

export function loadState(workDir: string): DaemonState | null {
	const path = getDaemonStatePath(workDir);
	if (!existsSync(path)) return null;

	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Retry once after a short delay — handles transient read during atomic write
		try {
			Bun.sleepSync(50);
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return null;
		}
	}
}

// ─── Run tracking ───────────────────────────────────────────────────────────

/**
 * Record the start of a new daemon run iteration.
 */
export function recordRunStart(
	state: DaemonState,
	directive?: RunDirective,
): DaemonRunEntry {
	const entry: DaemonRunEntry = {
		number: state.totalRuns + 1,
		startedAt: new Date().toISOString(),
		result: "pending",
		killedByWatchdog: false,
		issuesFixed: [],
		issuesFailed: [],
		directive,
	};

	state.runs.push(entry);
	state.totalRuns++;

	return entry;
}

/**
 * Record the completion of a daemon run iteration.
 */
export function recordRunComplete(
	entry: DaemonRunEntry,
	result: {
		exitCode: number;
		killedByWatchdog: boolean;
		duration: number;
		runId?: string;
		cost?: number;
		issuesFixed?: string[];
		issuesFailed?: string[];
		error?: string;
	},
): void {
	entry.finishedAt = new Date().toISOString();
	entry.duration = result.duration;
	entry.exitCode = result.exitCode;
	entry.killedByWatchdog = result.killedByWatchdog;
	entry.runId = result.runId;
	entry.cost = result.cost;
	entry.issuesFixed = result.issuesFixed ?? [];
	entry.issuesFailed = result.issuesFailed ?? [];
	entry.error = result.error;

	if (result.killedByWatchdog) {
		entry.result = "killed";
	} else if (result.exitCode === 0) {
		entry.result = "success";
	} else if (result.issuesFixed && result.issuesFixed.length > 0) {
		entry.result = "partial";
	} else {
		entry.result = "failed";
	}
}

/**
 * Record an orchestrator decision.
 */
export function recordOrchestratorDecision(
	state: DaemonState,
	directive: RunDirective,
): void {
	state.orchestratorDecisions.push({
		timestamp: new Date().toISOString(),
		directive,
	});
}

// ─── Event logging (daemon-log.jsonl) ───────────────────────────────────────

/**
 * Append an event to daemon-log.jsonl.
 * Each line is a standalone JSON object for easy parsing and streaming.
 */
export function appendLog(
	workDir: string,
	event: DaemonEventType,
	details: Record<string, unknown> = {},
	runId?: string,
	runNumber?: number,
): void {
	const entry: DaemonLogEntry = {
		ts: new Date().toISOString(),
		event,
		runId,
		runNumber,
		details,
	};

	const path = getDaemonLogPath(workDir);
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Read all log entries from daemon-log.jsonl.
 */
export function readLog(workDir: string): DaemonLogEntry[] {
	const path = getDaemonLogPath(workDir);
	if (!existsSync(path)) return [];

	try {
		const content = readFileSync(path, "utf-8");
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/**
 * Read log entries filtered by event types.
 */
export function readLogFiltered(
	workDir: string,
	eventTypes: DaemonEventType[],
): DaemonLogEntry[] {
	return readLog(workDir).filter((e) => eventTypes.includes(e.event));
}

// ─── PID file ───────────────────────────────────────────────────────────────

function writePidFile(workDir: string): void {
	writeFileSync(getDaemonPidPath(workDir), String(process.pid));
}

function removePidFile(workDir: string): void {
	const path = getDaemonPidPath(workDir);
	try {
		if (existsSync(path)) {
			rmSync(path);
		}
	} catch {
		// Best effort
	}
}

/**
 * Read daemon PID from file. Returns null if no daemon is running
 * or PID is dead.
 */
export function readDaemonPid(workDir: string): number | null {
	const path = getDaemonPidPath(workDir);
	if (!existsSync(path)) return null;

	try {
		const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
		if (Number.isNaN(pid)) return null;

		// Check if PID is alive
		process.kill(pid, 0);
		return pid;
	} catch {
		// PID is dead or file is corrupt — clean up
		try {
			rmSync(path);
		} catch {
			// Best effort
		}
		return null;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateForId(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function randomSuffix(): string {
	return Math.random().toString(36).substring(2, 8);
}
