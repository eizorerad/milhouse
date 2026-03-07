/**
 * Milhouse v0.3 — All types in one place.
 * No Zod. No deprecated fields. No dual naming.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export const PHASES = ["scan", "validate", "plan", "consolidate", "exec", "verify"] as const;
export type Phase = (typeof PHASES)[number];
export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface PhaseOptions {
	workers: number;
	retries: number;
	model?: string;
}

export interface Config {
	engine: string;
	model: string;
	pipeline: Phase[];
	failFast: boolean;
	phases: Record<Phase, PhaseOptions>;
	cost: { inputPerMillion: number; outputPerMillion: number; budget: number };
	project: { name: string; language: string; framework: string; description: string };
	commands: { test: string; lint: string; build: string };
	rules: string[];
	boundaries: { neverTouch: string[] };
	gates: { evidence: boolean; diffHygiene: boolean; placeholder: boolean; dod: boolean };
}

// ─── Domain ──────────────────────────────────────────────────────────────────

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type IssueStatus = "UNVALIDATED" | "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface Evidence {
	type: "file" | "log" | "command";
	file?: string;
	line_start?: number;
	line_end?: number;
	output?: string;
}

export interface Issue {
	id: string;
	type: "bug" | "feature" | "refactor" | "improvement" | "task";
	title: string;
	rationale: string;
	severity: Severity;
	status: IssueStatus;
	evidence: Evidence[];
	corrected_description?: string;
	scope_impact?: string;
	strategy?: string;
	created_at: string;
	updated_at: string;
}

export interface DoDCriteria {
	description: string;
	check_command?: string;
}

export interface Task {
	id: string;
	issue_id: string;
	title: string;
	description?: string;
	files: string[];
	depends_on: string[];
	checks: string[];
	acceptance: DoDCriteria[];
	parallel_group: number;
	status: TaskStatus;
	error?: string;
	created_at: string;
	updated_at: string;
}

export interface IssueGroup {
	issueId: string;
	issue: Issue;
	tasks: Task[];
}

export interface RunMeta {
	id: string;
	scope?: string;
	phase: string;
	status?: RunStatus;
	last_completed_phase?: Phase;
	issues_found: number;
	issues_validated: number;
	tasks_total: number;
	tasks_completed: number;
	tasks_failed: number;
	created_at: string;
	updated_at: string;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface EngineResult {
	response: string;
	inputTokens: number;
	outputTokens: number;
}

export interface ExecuteResult {
	result: EngineResult;
	proc: { kill(): void; readonly exited: Promise<number> };
}

// ─── Phase Runner ────────────────────────────────────────────────────────────

export interface PhaseResult<T = unknown> {
	item: unknown;
	result: T;
	success: boolean;
	error?: string;
	tokens: EngineResult;
}

/** RunStore is passed by reference to avoid circular imports */
export interface PhaseConfig<TItem = unknown, TResult = unknown> {
	name: Phase;
	schema?: Record<string, unknown>;
	maxTurns?: number;
	/** Timeout per item in milliseconds */
	timeout?: number;
	loadItems(store: any, config: Config): TItem[] | Promise<TItem[]>;
	buildPrompt(item: TItem, store: any, config: Config): string;
	parseResponse(response: string, item: TItem): TResult;
	saveResults(results: PhaseResult<TResult>[], store: any): void | Promise<void>;
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export interface RunCost {
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
}
