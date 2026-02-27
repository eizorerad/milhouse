/**
 * Shared test helpers and mock factories for phase testing.
 *
 * Provides reusable mock factories for AIEngine, PhaseContext,
 * ResolvedConfig, Issue, and Task objects used across all phase tests.
 *
 * @module tests/unit/runner/helpers
 */

import type { AIEngine, AIResult, EngineOptions, ProgressCallback } from "../../../src/engines/types.ts";
import type { ResolvedFullConfig } from "../../../src/config/define.ts";
import type { PhaseContext, ResolvedConfig } from "../../../src/runner/types.ts";
import type { Issue, Task } from "../../../src/state/types.ts";

// ============================================================================
// Mock AIEngine
// ============================================================================

interface MockEngineOptions {
	/** Default result returned by execute/executeStreaming */
	defaultResult?: Partial<AIResult>;
	/** Custom execute implementation */
	executeFn?: (prompt: string, workDir: string, options?: EngineOptions) => Promise<AIResult>;
	/** Whether to include executeStreaming method */
	includeStreaming?: boolean;
}

const DEFAULT_AI_RESULT: AIResult = {
	success: true,
	response: "{}",
	inputTokens: 100,
	outputTokens: 50,
};

/**
 * Create a mock AIEngine with configurable execute/executeStreaming.
 */
export function createMockEngine(options: MockEngineOptions = {}): AIEngine {
	const result: AIResult = { ...DEFAULT_AI_RESULT, ...options.defaultResult };
	const executeFn = options.executeFn ?? (async () => result);

	const engine: AIEngine = {
		name: "mock",
		cliCommand: "mock-cli",
		isAvailable: async () => true,
		execute: executeFn,
	};

	if (options.includeStreaming !== false) {
		engine.executeStreaming = async (
			prompt: string,
			workDir: string,
			_onProgress: ProgressCallback,
			engineOpts?: EngineOptions,
		) => {
			return executeFn(prompt, workDir, engineOpts);
		};
	}

	return engine;
}

// ============================================================================
// Mock ResolvedConfig
// ============================================================================

const DEFAULT_RESOLVED_CONFIG: ResolvedConfig = {
	engine: "mock",
	model: "mock-model",
	phases: {},
	workers: 1,
	cost: {
		inputPerMillion: 5,
		outputPerMillion: 25,
		budgetLimit: 100,
	},
	report: {
		enabled: false,
		format: "json",
		autoGenerate: false,
	},
	skipTests: false,
	skipLint: false,
	autoCommit: false,
	createPr: false,
	isolate: false,
	skipMerge: false,
	verbose: false,
	dryRun: false,
	failFast: false,
	maxRetries: 0,
	baseBranch: "main",
	draftPr: false,
	maxValidationRetries: 2,
	retryUnvalidated: true,
	tmux: false,
	tmuxAutoAttach: false,
	autoInstall: false,
	unsafeDoDChecks: false,
	execByIssue: true,
};

/**
 * Create a mock ResolvedConfig with sensible defaults.
 */
export function createMockResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_RESOLVED_CONFIG, ...overrides };
}

// ============================================================================
// Mock ResolvedFullConfig (userConfig)
// ============================================================================

const DEFAULT_USER_CONFIG: ResolvedFullConfig = {
	engine: "mock",
	model: "mock-model",
	pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
	failFast: true,
	phases: {
		scan: { model: "mock", workers: 1, retries: 2, retryDelay: 5000, timeout: 60000 },
		validate: { model: "mock", workers: 5, retries: 2, retryDelay: 3000, timeout: 120000 },
		plan: { model: "mock", workers: 5, retries: 3, retryDelay: 5000, timeout: 180000 },
		consolidate: { model: "mock", workers: 1, retries: 2, retryDelay: 5000, timeout: 180000 },
		exec: { model: "mock", workers: 3, retries: 3, retryDelay: 5000, timeout: 4000000 },
		verify: { model: "mock", workers: 1, retries: 1, retryDelay: 3000, timeout: 120000 },
	},
	cost: { inputPerMillion: 5, outputPerMillion: 25, budgetLimit: 100 },
	project: { name: "test-project", language: "typescript", framework: "bun", description: "Test project" },
	commands: { test: "bun test", lint: "bun lint", build: "bun build", compile: "" },
	rules: [],
	boundaries: { neverTouch: [] },
	execution: { mode: "branch", autoCommit: true, createPr: false, draftPr: true, skipMerge: false },
	report: { enabled: false, format: "json", autoGenerate: false },
	skipTests: false,
	skipLint: false,
	tmux: { enabled: false, autoAttach: false },
};

// ============================================================================
// Mock PhaseContext
// ============================================================================

interface MockPhaseContextOptions {
	runId?: string;
	workDir?: string;
	engine?: AIEngine;
	config?: Partial<ResolvedConfig>;
	userConfig?: Partial<ResolvedFullConfig>;
	store?: Record<string, unknown>;
}

/**
 * Build a valid PhaseContext with a mock engine and default config.
 */
export function createMockPhaseContext(options: MockPhaseContextOptions = {}): PhaseContext {
	const config = createMockResolvedConfig(options.config);
	return {
		runId: options.runId ?? "test-run-001",
		workDir: options.workDir ?? process.cwd(),
		engine: options.engine ?? createMockEngine(),
		config,
		startTime: Date.now(),
		userConfig: { ...DEFAULT_USER_CONFIG, ...options.userConfig } as ResolvedFullConfig,
		store: options.store ?? {},
	};
}

// ============================================================================
// Mock Issue
// ============================================================================

const DEFAULT_ISSUE: Issue = {
	id: "P-test-issue01",
	type: "bug",
	title: "Test issue title",
	rationale: "Test issue rationale",
	symptom: "Test issue symptom",
	hypothesis: "Test issue hypothesis",
	evidence: [],
	status: "UNVALIDATED",
	severity: "MEDIUM",
	related_task_ids: [],
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
};

/**
 * Create a valid Issue object with required fields.
 */
export function createMockIssue(overrides: Partial<Issue> = {}): Issue {
	const now = new Date().toISOString();
	return {
		...DEFAULT_ISSUE,
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

// ============================================================================
// Mock Task
// ============================================================================

const DEFAULT_TASK: Task = {
	id: "P-test-T1",
	issue_id: "P-test-issue01",
	title: "Test task title",
	description: "Test task description",
	files: ["src/test.ts"],
	depends_on: [],
	checks: ["bun test"],
	acceptance: [{ description: "Test passes", verified: false }],
	risk: "Low",
	rollback: "Revert the change",
	parallel_group: 0,
	status: "pending",
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
};

/**
 * Create a valid Task object with required fields.
 */
export function createMockTask(overrides: Partial<Task> = {}): Task {
	const now = new Date().toISOString();
	return {
		...DEFAULT_TASK,
		created_at: now,
		updated_at: now,
		...overrides,
	};
}
