/**
 * Daemon Orchestrator types
 *
 * Two-layer architecture:
 *   Layer 1 (DaemonShell): deterministic process management, safety rails
 *   Layer 2 (Orchestrator): AI-driven strategic decisions
 */

// ─── Run Directive (output of orchestrator) ─────────────────────────────────

export interface RunDirective {
	/** Core decision: run another iteration or stop */
	action: "run" | "stop";

	/** Reasoning for the decision (logged + included in report) */
	reasoning: string;

	// ── Fields for action = "run" ──

	/** Focus scope for this run */
	scope?: string;
	/** High-level strategy hint */
	strategy?: string;
	/** Phase list override */
	phases?: string[];
	/** Start from specific phase */
	startPhase?: string;
	/** Resume last incomplete run */
	resume?: boolean;
	/** Specific run to resume */
	runId?: string;
	/** Severity filter */
	minSeverity?: string;
	/** Specific issues to target */
	issueIds?: string[];
	/** Issues to skip */
	excludeIssueIds?: string[];

	// ── Fields for action = "stop" ──

	/** Human-readable stop reason */
	stopReason?: string;
	/** One-paragraph summary for report */
	summary?: string;
}

// ─── Daemon Configuration ───────────────────────────────────────────────────

export interface DaemonOrchestratorConfig {
	/** Enable AI orchestrator (false = hardcoded fallback only) */
	enabled: boolean;
	/** Engine for orchestrator agent (can differ from pipeline engine) */
	engine: string;
	/** Model for orchestrator (lightweight model recommended) */
	model: string;
	/** Max output tokens for orchestrator response */
	maxTokens: number;
}

export interface DaemonSafetyConfig {
	/** Max $ per daemon session */
	budgetLimit: number;
	/** Max pipeline iterations */
	maxRuns: number;
	/** Stop after N consecutive failures */
	maxConsecutiveFailures: number;
	/** Absolute session time limit (e.g., "10h", "8h30m") */
	maxSessionDuration: string;
}

export interface DaemonIntervalConfig {
	/** Minutes to wait between pipeline runs */
	betweenRuns: number;
	/** Seconds between process detection polls */
	processCheckInterval: number;
}

export interface DaemonWatchdogConfig {
	/** Kill process after N minutes with no stdout/stderr activity */
	activityTimeout: number;
	/** Kill process after N minutes total wall time */
	runTimeout: number;
	/** What to do when watchdog triggers */
	onTimeout: "kill-and-retry" | "kill-and-skip" | "kill-and-stop";
}

export interface DaemonReportConfig {
	/** Report format */
	format: "markdown" | "json" | "both";
	/** Include timeline in report */
	includeTimeline: boolean;
	/** Include orchestrator decisions in report */
	includeOrchestratorDecisions: boolean;
	/** Delivery methods */
	delivery: {
		/** Desktop notification via node-notifier */
		desktop: boolean;
	};
}

export interface DaemonConfig {
	orchestrator: DaemonOrchestratorConfig;
	safety: DaemonSafetyConfig;
	interval: DaemonIntervalConfig;
	watchdog: DaemonWatchdogConfig;
	processDetection: {
		/** Process names to wait for */
		waitFor: string[];
	};
	report: DaemonReportConfig;
}

// ─── Daemon Defaults ────────────────────────────────────────────────────────

export const DAEMON_DEFAULTS: DaemonConfig = {
	orchestrator: {
		enabled: true,
		engine: "claude",
		model: "sonnet",
		maxTokens: 2000,
	},
	safety: {
		budgetLimit: 50,
		maxRuns: 20,
		maxConsecutiveFailures: 3,
		maxSessionDuration: "10h",
	},
	interval: {
		betweenRuns: 15,
		processCheckInterval: 30,
	},
	watchdog: {
		activityTimeout: 30,
		runTimeout: 180,
		onTimeout: "kill-and-retry",
	},
	processDetection: {
		waitFor: ["milhouse", "claude", "aider", "gemini", "opencode", "codex"],
	},
	report: {
		format: "markdown",
		includeTimeline: true,
		includeOrchestratorDecisions: true,
		delivery: {
			desktop: true,
		},
	},
};

// ─── Daemon Session State ───────────────────────────────────────────────────

export interface DaemonRunEntry {
	/** Run number within this session (1-based) */
	number: number;
	/** Milhouse run ID */
	runId?: string;
	/** When this run started */
	startedAt: string;
	/** When this run finished */
	finishedAt?: string;
	/** Duration in ms */
	duration?: number;
	/** Outcome */
	result: "success" | "partial" | "failed" | "killed" | "pending";
	/** Exit code from milhouse process */
	exitCode?: number;
	/** Whether watchdog killed the process */
	killedByWatchdog: boolean;
	/** Issues fixed in this run */
	issuesFixed: string[];
	/** Issues that failed in this run */
	issuesFailed: string[];
	/** Cost of this run */
	cost?: number;
	/** Orchestrator directive that triggered this run */
	directive?: RunDirective;
	/** Error message if failed */
	error?: string;
}

export interface DaemonState {
	/** Unique session ID */
	sessionId: string;
	/** When the daemon session started */
	startedAt: string;
	/** Original user scope */
	scope: string;
	/** Input path (specs dir or PRD file) */
	inputPath?: string;
	/** Daemon PID */
	pid: number;
	/** Current status */
	status: "running" | "stopped" | "crashed";
	/** Run history */
	runs: DaemonRunEntry[];
	/** Consecutive failure counter */
	consecutiveFailures: number;
	/** Total cost across all runs */
	totalCost: number;
	/** Total runs completed */
	totalRuns: number;
	/** Orchestrator decision history */
	orchestratorDecisions: Array<{
		timestamp: string;
		directive: RunDirective;
	}>;
}

// ─── Daemon Log Events ──────────────────────────────────────────────────────

export type DaemonEventType =
	| "daemon:start"
	| "daemon:stop"
	| "daemon:crash"
	| "run:start"
	| "run:complete"
	| "run:failed"
	| "run:killed"
	| "watchdog:activity-timeout"
	| "watchdog:run-timeout"
	| "watchdog:kill"
	| "lock:cleaned"
	| "process:detected"
	| "process:cleared"
	| "orchestrator:decision"
	| "orchestrator:fallback"
	| "orchestrator:error"
	| "safety:budget-exceeded"
	| "safety:max-runs-reached"
	| "safety:consecutive-failures"
	| "safety:time-limit"
	| "stop:condition"
	| "report:generated";

export interface DaemonLogEntry {
	/** ISO timestamp */
	ts: string;
	/** Event type */
	event: DaemonEventType;
	/** Associated run ID */
	runId?: string;
	/** Run number in session */
	runNumber?: number;
	/** Event details */
	details: Record<string, unknown>;
}

// ─── Watchdog Result ────────────────────────────────────────────────────────

export interface WatchdogResult {
	/** Process exit code */
	exitCode: number;
	/** Captured stdout */
	stdout: string;
	/** Captured stderr */
	stderr: string;
	/** Duration in ms */
	duration: number;
	/** Whether watchdog killed the process */
	killedByWatchdog: boolean;
	/** Kill reason if watchdog triggered */
	killReason?: "activity-timeout" | "run-timeout";
}

// ─── Daemon Start Options (from CLI) ────────────────────────────────────────

export interface DaemonStartOptions {
	/** User-provided scope */
	scope: string;
	/** Working directory */
	workDir: string;
	/** Input path (specs dir or PRD file) */
	inputPath?: string;
	/** Run in background (detach) */
	background?: boolean;
	/** Minutes between runs (overrides config) */
	interval?: number;
	/** Session budget limit (overrides config) */
	budget?: number;
	/** Max iterations (overrides config) */
	maxRuns?: number;
	/** Stop at this time (HH:MM) */
	until?: string;
	/** Minimum severity filter */
	minSeverity?: string;
	/** Engine override */
	engine?: string;
	/** Model override */
	model?: string;
	/** Resume last incomplete run on first iteration */
	resume?: boolean;
	/** Start from this phase */
	startPhase?: string;
	/** End at this phase */
	endPhase?: string;
	/** Disable AI orchestrator */
	noOrchestrator?: boolean;
	/** Disable watchdog */
	noWatchdog?: boolean;
	/** Watchdog activity timeout override (minutes) */
	activityTimeout?: number;
	/** Watchdog run timeout override (minutes) */
	runTimeout?: number;
}

// ─── Session Report ─────────────────────────────────────────────────────────

export interface SessionReportDifficulty {
	type:
		| "crash"
		| "timeout"
		| "merge_conflict"
		| "test_failure"
		| "budget_warning"
		| "repeated_failure";
	description: string;
	resolution: string;
	runNumber: number;
	runId?: string;
	taskId?: string;
	occurredAt: string;
}

export interface SessionReportIssueSummary {
	id: string;
	title: string;
	severity: string;
	status: "fixed" | "failed" | "remaining";
	fixedInRun?: number;
	error?: string;
}

export interface SessionReport {
	sessionId: string;
	startedAt: string;
	finishedAt: string;
	totalDuration: string;
	stopReason: string;

	summary: {
		totalRuns: number;
		successfulRuns: number;
		failedRuns: number;
		totalCost: string;
		totalTokens: string;
	};

	issues: {
		foundTotal: number;
		fixed: number;
		remaining: number;
		bySeverity: Record<string, { found: number; fixed: number; remaining: number }>;
	};

	fixedIssues: SessionReportIssueSummary[];
	failedIssues: SessionReportIssueSummary[];
	remainingIssues: SessionReportIssueSummary[];

	difficulties: SessionReportDifficulty[];
	timeline: DaemonLogEntry[];

	costBreakdown: Array<{
		runNumber: number;
		duration: string;
		phases: string;
		cost: string;
		fixed: number;
	}>;

	orchestratorDecisions: Array<{
		timestamp: string;
		directive: RunDirective;
	}>;
}
