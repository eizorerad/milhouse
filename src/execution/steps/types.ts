/**
 * Milhouse Step Execution Types
 *
 * This module defines types for step-based execution in Milhouse.
 * Steps are the atomic units of work in the Milhouse pipeline,
 * executed either sequentially or in parallel.
 *
 * @module execution/steps/types
 * @since 1.0.0
 */

import type { AIEngine, AIResult } from "../../engines/types.ts";
import type { Task as StateTask } from "../../state/types.ts";
import type { LegacyTask as Task, LegacyTaskSource as TaskSource } from "../../tasks/index.ts";
import type { TokenUsage } from "../runtime/types.ts";

// ============================================================================
// Step Status Types
// ============================================================================

/**
 * Step execution status
 */
export type StepStatus =
	| "pending"
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled";

/**
 * Step execution phase
 */
export type StepPhase =
	| "initializing"
	| "branching"
	| "prompting"
	| "executing"
	| "verifying"
	| "committing"
	| "creating-pr"
	| "cleanup";

// ============================================================================
// Step Configuration Types
// ============================================================================

/**
 * Milhouse step execution options
 */
export interface MilhouseStepOptions {
	/** AI engine to use */
	engine: AIEngine;
	/** Task source for task management */
	taskSource: TaskSource;
	/** Working directory */
	workDir: string;
	/** Skip tests during execution */
	skipTests: boolean;
	/** Skip linting during execution */
	skipLint: boolean;
	/** Dry run mode (no actual execution) */
	dryRun: boolean;
	/** Maximum iterations (0 = unlimited) */
	maxIterations: number;
	/** Maximum retries per task */
	maxRetries: number;
	/** Retry delay in milliseconds */
	retryDelay: number;
	/** Create branch per task */
	branchPerTask: boolean;
	/** Base branch for branching */
	baseBranch: string;
	/** Create pull requests */
	createPr: boolean;
	/** Create draft PRs */
	draftPr: boolean;
	/** Auto-commit changes */
	autoCommit: boolean;
	/** Browser mode */
	browserEnabled: "auto" | "true" | "false";
	/** Active settings to display */
	activeSettings?: string[];
	/** Model override for AI engine */
	modelOverride?: string;
	/** Skip merge phase after parallel execution */
	skipMerge?: boolean;
}

/**
 * Default step options
 */
export const DEFAULT_STEP_OPTIONS: Partial<MilhouseStepOptions> = {
	skipTests: false,
	skipLint: false,
	dryRun: false,
	maxIterations: 0,
	maxRetries: 3,
	retryDelay: 5000,
	branchPerTask: true,
	createPr: false,
	draftPr: true,
	autoCommit: true,
	browserEnabled: "auto",
	skipMerge: false,
};

/**
 * Parallel step execution options
 */
export interface MilhouseParallelStepOptions extends MilhouseStepOptions {
	/** Maximum parallel workers */
	maxParallel: number;
	/** PRD source type */
	prdSource: string;
	/** PRD file path */
	prdFile: string;
	/** Whether PRD is a folder */
	prdIsFolder?: boolean;
}

// ============================================================================
// Step Result Types
// ============================================================================

/**
 * Result of a single step execution
 */
export interface MilhouseStepResult {
	/** Task that was executed */
	task: Task;
	/** Execution status */
	status: StepStatus;
	/** Whether execution was successful */
	success: boolean;
	/** Token usage */
	tokenUsage: TokenUsage;
	/** Duration in milliseconds */
	durationMs: number;
	/** Branch created (if any) */
	branch?: string;
	/** PR URL (if created) */
	prUrl?: string;
	/** Error message (if failed) */
	error?: string;
	/** AI result (if available) */
	aiResult?: AIResult;
}

/**
 * Create an empty step result
 */
export function createEmptyStepResult(task: Task): MilhouseStepResult {
	return {
		task,
		status: "pending",
		success: false,
		tokenUsage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		},
		durationMs: 0,
	};
}

/**
 * Simplified execution result for issue-based parallel execution
 *
 * Used by runParallelByIssue to return execution statistics
 * without detailed per-step results.
 */
export interface ExecutionResult {
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of tasks failed */
	tasksFailed: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
}

/**
 * Aggregate result of multiple step executions
 */
export interface MilhouseStepBatchResult {
	/** Individual step results */
	results: MilhouseStepResult[];
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of tasks failed */
	tasksFailed: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total duration in milliseconds */
	totalDurationMs: number;
	/** Whether all steps succeeded */
	allSucceeded: boolean;
}

/**
 * Create an empty batch result
 */
export function createEmptyBatchResult(): MilhouseStepBatchResult {
	return {
		results: [],
		tasksCompleted: 0,
		tasksFailed: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalDurationMs: 0,
		allSucceeded: true,
	};
}

/**
 * Add a step result to a batch result
 */
export function addStepResultToBatch(
	batch: MilhouseStepBatchResult,
	step: MilhouseStepResult,
): MilhouseStepBatchResult {
	return {
		results: [...batch.results, step],
		tasksCompleted: batch.tasksCompleted + (step.success ? 1 : 0),
		tasksFailed: batch.tasksFailed + (step.success ? 0 : 1),
		totalInputTokens: batch.totalInputTokens + step.tokenUsage.inputTokens,
		totalOutputTokens: batch.totalOutputTokens + step.tokenUsage.outputTokens,
		totalDurationMs: batch.totalDurationMs + step.durationMs,
		allSucceeded: batch.allSucceeded && step.success,
	};
}

// ============================================================================
// Parallel Group Types
// ============================================================================

/**
 * Parallel group with tasks
 */
export interface MilhouseParallelGroup {
	/** Group number */
	group: number;
	/** Tasks in this group */
	tasks: StateTask[];
	/** Maximum concurrent executions */
	maxConcurrent: number;
}

/**
 * Result of parallel group execution
 */
export interface MilhouseParallelGroupResult {
	/** Group number */
	group: number;
	/** Tasks that completed successfully */
	completedTasks: string[];
	/** Tasks that failed */
	failedTasks: string[];
	/** Input tokens used */
	inputTokens: number;
	/** Output tokens used */
	outputTokens: number;
	/** Whether all tasks succeeded */
	success: boolean;
	/** Branches created */
	branches: string[];
}

// ============================================================================
// Worktree Types
// ============================================================================

/**
 * Worktree agent result
 */
export interface WorktreeAgentResult {
	/** Task that was executed */
	task: Task;
	/** Worktree directory */
	worktreeDir: string;
	/** Branch name */
	branchName: string;
	/** AI result */
	result: AIResult | null;
	/** Error message (if failed) */
	error?: string;
}

// ============================================================================
// PR Creation Types
// ============================================================================

/**
 * Milhouse PR metadata
 */
export interface MilhousePRMetadata {
	/** PR title */
	title: string;
	/** PR body */
	body: string;
	/** Source branch */
	sourceBranch: string;
	/** Target branch */
	targetBranch: string;
	/** Whether PR is a draft */
	isDraft: boolean;
	/** Labels to add */
	labels?: string[];
	/** Assignees */
	assignees?: string[];
}

/**
 * Create Milhouse PR body
 *
 * @param taskTitle - Task title
 * @param aiResponse - AI response summary
 * @param additionalContext - Additional context
 * @returns Formatted PR body
 */
export function createMilhousePRBody(
	taskTitle: string,
	aiResponse: string,
	additionalContext?: string,
): string {
	const parts: string[] = [
		"## Automated PR created by Milhouse",
		"",
		`### Task: ${taskTitle}`,
		"",
		"### Changes",
		aiResponse,
	];

	if (additionalContext) {
		parts.push("", "### Additional Context", additionalContext);
	}

	parts.push("", "---", "*This PR was automatically generated by the Milhouse pipeline.*");

	return parts.join("\n");
}

/**
 * Create Milhouse PR metadata
 *
 * @param task - Task being completed
 * @param sourceBranch - Source branch
 * @param targetBranch - Target branch
 * @param aiResponse - AI response
 * @param isDraft - Whether PR is a draft
 * @returns PR metadata
 */
export function createMilhousePRMetadata(
	task: Task,
	sourceBranch: string,
	targetBranch: string,
	aiResponse: string,
	isDraft = true,
): MilhousePRMetadata {
	return {
		title: task.title,
		body: createMilhousePRBody(task.title, aiResponse),
		sourceBranch,
		targetBranch,
		isDraft,
		labels: ["milhouse", "automated"],
	};
}

// ============================================================================
// Step Hooks Types
// ============================================================================

/**
 * Step lifecycle hooks
 */
export interface MilhouseStepHooks {
	/** Called before step execution */
	onStepStart?: (task: Task, phase: StepPhase) => void;
	/** Called during step execution */
	onStepProgress?: (task: Task, phase: StepPhase, detail?: string) => void;
	/** Called after step completion */
	onStepComplete?: (result: MilhouseStepResult) => void;
	/** Called on step error */
	onStepError?: (task: Task, error: Error) => void;
	/** Called on retry */
	onStepRetry?: (task: Task, attempt: number, error: string) => void;
}

/**
 * Create default step hooks (no-op)
 */
export function createDefaultStepHooks(): MilhouseStepHooks {
	return {};
}

