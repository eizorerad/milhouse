/** Shared types: config and the domain model. */

export const PHASES = ["scan", "validate", "plan", "consolidate", "exec", "merge"] as const;
/** The coding agents Milhouse can drive. */
export const HARNESS_NAMES = ["claude", "codex"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
/** The model used when the config names none. Codex: whatever the user's own Codex config says. */
export const DEFAULT_MODEL: Record<HarnessName, string> = { claude: "sonnet", codex: "" };
export type Phase = (typeof PHASES)[number];
/** Steps that call the agent. `verify` is the reviewer that runs inside `exec`, once per issue. */
export type AgentStep = Exclude<Phase, "merge"> | "verify";
export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface StepOptions {
	retries: number;
	/** Minutes that one call of this step may take. */
	timeoutMinutes: number;
	/** Empty string = the global model (when the step runs on the global harness) or the harness default. */
	model: string;
	/** Empty string = the global harness. */
	harness: HarnessName | "";
	/** Extra rules for this step only, added to the global `rules`. */
	rules: string[];
	/** Parallel agents. Only for steps that run items in parallel (validate, plan). */
	workers?: number;
}

export interface Config {
	/** The agent that runs every step that does not name its own. */
	harness: HarnessName;
	/** Model of the global harness. Empty = that harness's default. */
	model: string;
	/** Extra command-line arguments for each harness. Trusted: they are part of the config file. */
	harnessArgs: Record<HarnessName, string[]>;
	pipeline: Phase[];
	/** Stop after the first phase with a failed item. Otherwise continue with what worked. */
	failFast: boolean;
	phases: Record<AgentStep, StepOptions>;
	/** USD limit for one run. 0 = unlimited. */
	budget: number;
	/** Tokens (input and output) for the calls of a run that report no USD cost (Codex). 0 = unlimited. */
	maxTokens: number;
	/** Minutes that one command may run in all, whatever the agent. 0 = unlimited. */
	maxMinutes: number;
	project: { name: string; language: string; framework: string; description: string };
	/** Shell commands run inside the worktree. An empty string skips the command. */
	commands: { setup: string; build: string; lint: string; test: string };
	/** Minutes that one setup, build, lint or test command may take. */
	commandTimeoutMinutes: number;
	/** Run exec although no build, lint or test command is set: an agent alone reviews the work. */
	allowUnchecked: boolean;
	/** Extra rules injected into every prompt. */
	rules: string[];
	/** Globs agents must not change. Enforced after every exec attempt. */
	neverTouch: string[];
	gates: {
		evidence: boolean;
		diffHygiene: boolean;
		placeholder: boolean;
		dod: boolean;
		/** The checks must pass on the starting commit before the run spends anything. */
		baseline: boolean;
		/** Files that the `placeholder` and `diffHygiene` gates do not look at (patterns as in .gitignore). */
		ignore: string[];
	};
}

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type IssueStatus = "UNVALIDATED" | "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED";
/** Validated statuses that still describe real work to do. */
export const ACTIONABLE: readonly IssueStatus[] = ["CONFIRMED", "PARTIAL", "MISDIAGNOSED"];

export interface Evidence {
	file: string;
	line_start: number;
	line_end: number;
	snippet: string;
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
	/** The validator's one-sentence reason for the status. For the report: no prompt contains it. */
	verdict_reason?: string;
	scope_impact?: string;
	strategy?: string;
	/** Set once the issue has been planned, even if consolidate later removed all its tasks. */
	planned?: boolean;
}

/** pending -> verified (committed, checked, reviewed) -> merged into the user's branch. */
export type TaskStatus = "pending" | "verified" | "merged" | "failed";

export interface Task {
	id: string;
	issue_id: string;
	title: string;
	description: string;
	files: string[];
	/** Ids of tasks that must be done first. */
	depends_on: string[];
	/** Commands the executor should run. */
	checks: string[];
	/** Criteria the reviewer verifies. */
	acceptance: string[];
	status: TaskStatus;
	error?: string;
	/** The commit accepted for this task. Written just before the run's ref moves to it. */
	sha?: string;
	/** Milhouse ran at least one build, lint or test on this SHA and all passed. */
	checks_passed?: boolean;
}

export interface RunMeta {
	id: string;
	scope?: string;
	status: RunStatus;
	phase: string;
	/** Phases that finished without a failed item. */
	done: Phase[];
	/** Branch and commit the run started from. Verified work is merged back into this branch. */
	base_branch: string;
	base_sha: string;
	created_at: string;
	updated_at: string;
}

export interface RunCost {
	/** USD, from harnesses that report it (Claude). */
	total: number;
	byPhase: Partial<Record<AgentStep, number>>;
	/** Tokens of calls whose cost is not reported in USD (Codex). Absent in runs made before Codex was supported. */
	tokens?: { input: number; output: number };
}
