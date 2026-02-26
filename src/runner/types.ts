import type { AIEngine } from "../engines/types.ts";
import type { AgentRole, RunPhase, Severity } from "../state/types.ts";
import type { RunCost } from "./cost.ts";

/** Per-phase model override */
export interface PhaseModelConfig {
	model?: string;
}

/** Cost tracking configuration */
export interface CostConfig {
	/** $/1M input tokens */
	inputPerMillion: number;
	/** $/1M output tokens */
	outputPerMillion: number;
	/** $ max per run (default: 50; set to 0 for unlimited) */
	budgetLimit: number;
}

/** Report configuration */
export interface ReportConfig {
	/** Whether reports are enabled */
	enabled: boolean;
	/** Report format: json, markdown, or both */
	format: "json" | "markdown" | "both";
	/** Auto-generate after pipeline completes */
	autoGenerate: boolean;
}

/**
 * Resolved configuration -- the single truth after merging defaults + config.yml + CLI flags
 */
export interface ResolvedConfig {
	/** AI engine (claude, gemini, opencode, etc.) */
	engine: string;
	/** Default model */
	model: string;
	/** Per-phase model overrides */
	phases: Record<string, PhaseModelConfig>;
	/** Number of parallel workers */
	workers: number;
	/** Cost tracking */
	cost: CostConfig;
	/** Report settings */
	report: ReportConfig;
	/** Skip options */
	skipTests: boolean;
	skipLint: boolean;
	/** Execution settings */
	autoCommit: boolean;
	createPr: boolean;
	isolate: boolean;
	skipMerge: boolean;
	/** Verbose mode */
	verbose: boolean;
	/** Run ID if explicitly provided */
	runId?: string;
	/** Scope for scan */
	scanFocus?: string;
	/** Dry run mode */
	dryRun: boolean;
	/** Fail fast mode */
	failFast: boolean;
	/** Max retries */
	maxRetries: number;
	/** Base branch for PRs */
	baseBranch: string;
	/** Draft PR mode */
	draftPr: boolean;
	/** Issue filtering */
	issueIds?: string[];
	excludeIssueIds?: string[];
	/** Severity filtering */
	severityFilter?: Severity[];
	minSeverity?: Severity;
	/** Validation retry settings */
	maxValidationRetries: number;
	retryUnvalidated: boolean;
	/** Tmux mode */
	tmux: boolean;
	tmuxAutoAttach: boolean;
	autoInstall: boolean;
	/** Unsafe DoD checks */
	unsafeDoDChecks: boolean;
	/** Use issue-based parallel execution (default true) */
	execByIssue: boolean;
	/** Execute a single specific task by ID */
	taskId?: string;
}

/**
 * Resolve the model for a specific phase
 */
export function resolvePhaseModel(config: ResolvedConfig, phase: string): string {
	return config.phases[phase]?.model ?? config.model;
}

// ============================================================================
// PHASE RUNNER TYPES
// ============================================================================

/** How the phase processes items */
export type PhaseMode = "per-item" | "single-agent";

/** Result of processing a single item */
export interface PhaseItemResult<TResult = unknown> {
	item: unknown;
	result: TResult;
	success: boolean;
	error?: string;
	inputTokens: number;
	outputTokens: number;
}

/** Overall result of a phase run */
export interface PhaseRunResult<TResult = unknown> {
	phase: string;
	runId: string;
	success: boolean;
	items: PhaseItemResult<TResult>[];
	totalInputTokens: number;
	totalOutputTokens: number;
	cost: number;
	duration: number;
	/** Data passed to next phase */
	data?: Record<string, unknown>;
}

/** Context passed to phase hooks and functions */
export interface PhaseContext {
	runId: string;
	workDir: string;
	engine: AIEngine;
	config: ResolvedConfig;
	/** Timestamp (ms) when this phase started */
	startTime: number;
	/** Unified user config (rules, prompts, boundaries, project, commands) */
	userConfig: import("../config/define.ts").ResolvedFullConfig;
	/** Shared store for passing data between hooks */
	store: Record<string, unknown>;
}

/**
 * PhaseConfig — the single interface that all phases implement
 *
 * Each phase provides:
 * - Identity (name, role)
 * - JSON schema for structured output
 * - Mode (per-item or single-agent)
 * - Functions to load items, build prompts, parse responses, save results
 * - Lifecycle hooks
 * - Retry configuration (optional)
 */
export interface PhaseConfig<TItem = unknown, TResult = unknown> {
	/** Phase identity */
	name: string;
	role: AgentRole;

	/** JSON schema for --json-schema (forces structured output) */
	jsonSchema?: Record<string, unknown>;

	/** Extra metadata forwarded to the engine (e.g. { maxTokens: 32000 }) */
	engineMetadata?: Record<string, unknown>;

	/** How to run: one agent for all items, or one agent per item */
	mode: PhaseMode;

	/** Default parallel agents (overridden by config.workers) */
	defaultParallel: number;

	/** Load work items for this phase */
	loadItems(ctx: PhaseContext): Promise<TItem[]> | TItem[];

	/** Build the prompt for one item (per-item) or all items (single-agent) */
	buildPrompt(item: TItem, ctx: PhaseContext): string;

	/** Parse AI response into structured result */
	parseResponse(response: string, item: TItem, ctx: PhaseContext): TResult;

	/** Save all results to state */
	saveResults(results: PhaseItemResult<TResult>[], ctx: PhaseContext): Promise<void> | void;

	/** Determine next pipeline phase based on results */
	nextPhase?(results: PhaseItemResult<TResult>[], ctx: PhaseContext): RunPhase;

	/** Format summary for terminal output */
	formatSummary?(results: PhaseItemResult<TResult>[], ctx: PhaseContext): void;

	// --- Custom execution (exec phase) ---
	/** Replace the standard loadItems/executePool flow with custom logic.
	 *  When provided, loadItems/buildPrompt/parseResponse are NOT called.
	 *  Must return results in standard PhaseItemResult format for cost tracking. */
	customExecute?(ctx: PhaseContext, runCost: RunCost): Promise<PhaseItemResult<TResult>[]>;

	// --- Lifecycle hooks ---
	beforeRun?(ctx: PhaseContext): Promise<void> | void;
	afterRun?(results: PhaseItemResult<TResult>[], ctx: PhaseContext): Promise<void> | void;
	beforeItem?(item: TItem, ctx: PhaseContext): Promise<TItem> | TItem;

	// --- Retry (validate only) ---
	isRetryable?: boolean;
	maxRetryRounds?: number;
	retryFilter?(items: TItem[], results: PhaseItemResult<TResult>[]): TItem[];
}
