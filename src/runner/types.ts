/**
 * Runner types -- ResolvedConfig, PhaseConfig, PhaseContext, cost types
 */

import type { PipelinePhase } from "../domain/config/types.ts";

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
	/** $ max per run (0 = unlimited) */
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
	skipProbes: boolean;
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
	/** Validation retry settings */
	maxValidationRetries: number;
	retryUnvalidated: boolean;
	/** Tmux mode */
	tmux: boolean;
	tmuxAutoAttach: boolean;
	autoInstall: boolean;
	/** Unsafe DoD checks */
	unsafeDoDChecks: boolean;
}

/**
 * Resolve the model for a specific phase
 */
export function resolvePhaseModel(config: ResolvedConfig, phase: string): string {
	return config.phases[phase]?.model ?? config.model;
}
