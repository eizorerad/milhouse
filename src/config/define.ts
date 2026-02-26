/**
 * Unified Milhouse configuration — type, defaults, and resolver.
 *
 * This is the single source of truth for all config values.
 * Users edit `.milhouse/config.ts` which exports a `Config` object.
 * At runtime, missing fields are filled from DEFAULTS.
 */

import { logWarn } from "../ui/logger.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export const VALID_PHASES = ["scan", "validate", "plan", "consolidate", "exec", "verify"] as const;

export type PhaseName = "scan" | "validate" | "plan" | "consolidate" | "exec" | "verify";

export interface PhaseConfig {
	/** Model override for this phase */
	model?: string;
	/** Number of parallel agents */
	workers?: number;
	/** Max retry attempts */
	retries?: number;
	/** Delay between retries (ms) */
	retryDelay?: number;
	/** Phase timeout (ms) */
	timeout?: number;
}

export interface Config {
	engine?: string;
	model?: string;

	/** Which phases to run and in what order */
	pipeline?: PhaseName[];
	failFast?: boolean;

	/** Per-phase overrides */
	phases?: Partial<Record<PhaseName, PhaseConfig>>;

	cost?: {
		inputPerMillion?: number;
		outputPerMillion?: number;
		budgetLimit?: number;
	};

	project?: {
		name?: string;
		language?: string;
		framework?: string;
		description?: string;
	};

	commands?: {
		test?: string;
		lint?: string;
		build?: string;
		compile?: string;
	};

	/** Rules injected into agent prompts */
	rules?: string[];

	boundaries?: {
		neverTouch?: string[];
	};

	execution?: {
		mode?: "in-place" | "branch" | "worktree" | "pr";
		autoCommit?: boolean;
		createPr?: boolean;
		draftPr?: boolean;
		skipMerge?: boolean;
	};

	/** Extra instructions appended to agent prompts per phase */
	prompts?: Partial<
		Record<
			PhaseName,
			{
				extraInstructions?: string;
			}
		>
	>;

	report?: {
		enabled?: boolean;
		format?: "json" | "markdown" | "both";
		autoGenerate?: boolean;
	};

	skipTests?: boolean;
	skipLint?: boolean;

	tmux?: {
		enabled?: boolean;
		autoAttach?: boolean;
	};

	/** Daemon orchestrator settings */
	daemon?: {
		orchestrator?: {
			enabled?: boolean;
			engine?: string;
			model?: string;
			maxTokens?: number;
		};
		safety?: {
			budgetLimit?: number;
			maxRuns?: number;
			maxConsecutiveFailures?: number;
			maxSessionDuration?: string;
		};
		interval?: {
			betweenRuns?: number;
			processCheckInterval?: number;
		};
		watchdog?: {
			activityTimeout?: number;
			runTimeout?: number;
			onTimeout?: "kill-and-retry" | "kill-and-skip" | "kill-and-stop";
		};
		processDetection?: {
			waitFor?: string[];
		};
		report?: {
			format?: "markdown" | "json" | "both";
			includeTimeline?: boolean;
			includeOrchestratorDecisions?: boolean;
			delivery?: {
				desktop?: boolean;
			};
		};
	};
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
	engine: "claude",
	model: "opus",

	pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"] as PhaseName[],
	failFast: true,

	phases: {
		scan: { model: "opus", workers: 1, retries: 2, retryDelay: 5000, timeout: 60_000 },
		validate: { model: "opus", workers: 5, retries: 2, retryDelay: 3000, timeout: 120_000 },
		plan: { model: "opus", workers: 5, retries: 3, retryDelay: 5000, timeout: 180_000 },
		consolidate: { model: "opus", workers: 1, retries: 2, retryDelay: 5000, timeout: 180_000 },
		exec: { model: "opus", workers: 3, retries: 3, retryDelay: 5000, timeout: 4_000_000 },
		verify: { model: "opus", workers: 1, retries: 1, retryDelay: 3000, timeout: 120_000 },
	},

	cost: { inputPerMillion: 5, outputPerMillion: 25, budgetLimit: 0 },

	project: { name: "", language: "", framework: "", description: "" },
	commands: { test: "", lint: "", build: "", compile: "" },
	rules: [],
	boundaries: { neverTouch: [] },

	execution: {
		mode: "branch",
		autoCommit: true,
		createPr: false,
		draftPr: true,
		skipMerge: false,
	},

	report: { enabled: true, format: "json", autoGenerate: true },

	skipTests: false,
	skipLint: false,

	tmux: { enabled: false, autoAttach: false },
};

// ─── Resolved type ───────────────────────────────────────────────────────────

/** Fully resolved config — every field guaranteed present */
export interface ResolvedFullConfig {
	engine: string;
	model: string;
	pipeline: PhaseName[];
	failFast: boolean;
	phases: Record<PhaseName, Required<PhaseConfig>>;
	cost: { inputPerMillion: number; outputPerMillion: number; budgetLimit: number };
	project: { name: string; language: string; framework: string; description: string };
	commands: { test: string; lint: string; build: string; compile: string };
	rules: string[];
	boundaries: { neverTouch: string[] };
	execution: {
		mode: string;
		autoCommit: boolean;
		createPr: boolean;
		draftPr: boolean;
		skipMerge: boolean;
	};
	report: { enabled: boolean; format: string; autoGenerate: boolean };
	skipTests: boolean;
	skipLint: boolean;
	tmux: { enabled: boolean; autoAttach: boolean };
	prompts?: Partial<Record<PhaseName, { extraInstructions?: string }>>;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/** Remove undefined values so spread doesn't overwrite defaults */
function strip<T extends Record<string, unknown>>(obj?: T): Partial<T> {
	if (!obj) return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out as Partial<T>;
}

/**
 * Deep-merge user config onto defaults. Returns fully-resolved config
 * where every field is guaranteed present.
 */
export function resolveConfig(user: Config): ResolvedFullConfig {
	return {
		engine: user.engine ?? DEFAULTS.engine,
		model: user.model ?? DEFAULTS.model,
		pipeline: user.pipeline ?? DEFAULTS.pipeline,
		failFast: user.failFast ?? DEFAULTS.failFast,

		phases: mergePhases(user.phases),

		cost: { ...DEFAULTS.cost, ...strip(user.cost) },
		project: { ...DEFAULTS.project, ...strip(user.project) },
		commands: { ...DEFAULTS.commands, ...strip(user.commands) },
		rules: user.rules ?? DEFAULTS.rules,
		boundaries: { ...DEFAULTS.boundaries, ...strip(user.boundaries) },
		execution: { ...DEFAULTS.execution, ...strip(user.execution) },
		report: { ...DEFAULTS.report, ...strip(user.report) },

		skipTests: user.skipTests ?? DEFAULTS.skipTests,
		skipLint: user.skipLint ?? DEFAULTS.skipLint,

		tmux: { ...DEFAULTS.tmux, ...strip(user.tmux) },
		prompts: user.prompts,
	};
}

/** Compute Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

/** Return the closest valid phase name to the given input */
function closestPhaseName(input: string): string {
	let best = VALID_PHASES[0] as string;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const phase of VALID_PHASES) {
		const d = levenshtein(input, phase);
		if (d < bestDist) {
			bestDist = d;
			best = phase;
		}
	}
	return best;
}

function mergePhases(
	user?: Partial<Record<PhaseName, PhaseConfig>>,
): Record<PhaseName, Required<PhaseConfig>> {
	const result = { ...DEFAULTS.phases };
	if (!user) return result;

	for (const key of Object.keys(user) as string[]) {
		if (!(VALID_PHASES as readonly string[]).includes(key)) {
			const suggestion = closestPhaseName(key);
			logWarn(`Unknown phase "${key}" in config — did you mean "${suggestion}"?`);
			continue;
		}
		const phase = key as PhaseName;
		if (user[phase]) {
			result[phase] = { ...result[phase], ...user[phase] };
		}
	}
	return result;
}
