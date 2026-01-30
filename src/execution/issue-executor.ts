/**
 * Issue-Based Parallel Execution Module
 *
 * Provides issue-based parallel execution for the Milhouse pipeline.
 * Each issue's tasks run in a dedicated worktree, enabling parallel
 * execution of multiple issues while maintaining task ordering within
 * each issue.
 *
 * Features:
 * - Issue-based worktree isolation
 * - Parallel issue execution with configurable concurrency
 * - Deferred merge phase to prevent race conditions
 * - Partial success detection via git commit analysis
 * - AI-assisted conflict resolution
 *
 * @module execution/issue-executor
 * @since 1.0.0
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import { MILHOUSE_DIR } from "../domain/config/directories.ts";
import { getConfigService } from "../services/config/index.ts";
import type { AIEngine } from "../engines/types.ts";
import {
	OpencodeServerExecutor,
	PortManager,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	displayTmuxModeHeader,
	updateAgentStatus,
	clearAgentStatuses,
	getMessageOptionsForPhase,
	type ServerInfo,
	type AgentStatus,
} from "../engines/opencode/index.ts";
import { TmuxSessionManager, ensureTmuxInstalled, getInstallationInstructions } from "../engines/tmux/index.ts";
import {
	getMilhouseDir,
	getCurrentPlansDir,
	readIssueWbsPlan,
	hasLegacyPlansToImport,
	importLegacyPlans,
} from "../state/index.ts";
import { AGENT_ROLES, type Issue, type Task as StateTask } from "../state/types.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { DynamicAgentSpinner } from "../ui/spinners.ts";
import { branchExists, deleteLocalBranch } from "../vcs/services/branch-service.ts";
import {
	type RebaseResult,
	abortMerge,
	abortRebase,
	checkMergeReadiness,
	mergeAgentBranch,
	rebaseBranch,
	stashChanges,
	popStash,
} from "../vcs/services/merge-service.ts";
import { cleanupWorktree, createWorktree } from "../vcs/services/worktree-service.ts";
import { createMergeConflictInfo, resolveConflictsWithEngine } from "./runtime/conflict-resolution.ts";
import { executeWithRetry, isRetryableError } from "./runtime/retry.ts";
import { DEFAULT_RETRY_CONFIG, type MilhouseRetryConfig } from "./runtime/types.ts";
import type { ExecutionResult } from "./steps/types.ts";
import { analyzeIssueTaskCompletion } from "./utils/task-commit-matcher.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Issue group with all its tasks
 */
export interface IssueGroup {
	/** Issue ID */
	issueId: string;
	/** Issue data */
	issue: Issue;
	/** All tasks for this issue */
	tasks: StateTask[];
	/** Plan file path */
	planPath?: string;
	/** Validation report path */
	validationReportPath?: string;
}

/**
 * Result of issue-based execution
 *
 * Supports partial success detection - if some tasks were committed before
 * a failure occurred, completedTasks will contain those task IDs even if
 * the overall execution failed.
 *
 * @example
 * // Partial success scenario: 3 tasks, 2 committed, 1 failed
 * {
 *   issueId: "ISSUE-123",
 *   completedTasks: ["task-1", "task-2"],  // Tasks with matching commits
 *   failedTasks: ["task-3"],               // Tasks without commits
 *   success: false,                        // Overall execution failed
 *   ...
 * }
 */
export interface IssueExecutionResult {
	/** Issue ID */
	issueId: string;
	/**
	 * Tasks that completed successfully (have matching git commits).
	 * These are determined by analyzing git commits in the worktree,
	 * matching commit messages to the pattern `[{issueId}] Task N: <title>`.
	 * May contain tasks even when `success` is false (partial completion).
	 */
	completedTasks: string[];
	/**
	 * Tasks that failed or were not completed (no matching git commits).
	 * These tasks were either:
	 * - Never executed before a failure occurred
	 * - Executed but not committed
	 * - Part of an execution that failed before any commits
	 */
	failedTasks: string[];
	/** Total input tokens used */
	inputTokens: number;
	/** Total output tokens used */
	outputTokens: number;
	/** Whether all tasks in the issue succeeded (no failures) */
	success: boolean;
	/** Branch name used */
	branchName?: string;
	/** Error message if failed */
	error?: string;
}

/**
 * Result of merge for a single branch
 */
export interface MergeBranchResult {
	/** Branch name */
	branch: string;
	/** Whether merge succeeded */
	success: boolean;
	/** Issue ID this branch belongs to */
	issueId: string;
	/** Error message if failed */
	error?: string;
}

/**
 * Branch status for detailed reporting
 */
export interface BranchStatus {
	/** Branch name */
	branch: string;
	/** Issue ID */
	issueId: string;
	/** Status category */
	status: "complete" | "partial" | "failed";
	/** Number of completed tasks */
	completedTasks: number;
	/** Number of failed tasks */
	failedTasks: number;
	/** Total tasks */
	totalTasks: number;
	/** Whether branch was merged */
	merged: boolean;
	/** Error if any */
	error?: string;
}

/**
 * Options for issue-based execution
 */
export interface IssueBasedExecutionOptions {
	/** AI engine to use */
	engine: AIEngine;
	/** Working directory */
	workDir: string;
	/** Base branch for worktrees */
	baseBranch: string;
	/** Maximum concurrent issues to execute */
	maxConcurrent: number;
	/** Maximum retries per issue */
	maxRetries: number;
	/** Retry delay in milliseconds */
	retryDelay: number;
	/** Skip tests during execution */
	skipTests: boolean;
	/** Skip linting during execution */
	skipLint: boolean;
	/** Browser enabled mode */
	browserEnabled: "auto" | "true" | "false";
	/** Model override for AI engine */
	modelOverride?: string;
	/** Whether to skip merge phase */
	skipMerge?: boolean;
	/** Callback when an issue completes (can be sync or async for concurrent-safe updates) */
	onIssueComplete?: (issueId: string, result: IssueExecutionResult) => void | Promise<void>;
	/** Callback when merge phase completes (called after all agents finish and merge is attempted) */
	onMergeComplete?: (results: MergeBranchResult[]) => void | Promise<void>;
	/** Whether to stop on first failure */
	failFast?: boolean;
	/**
	 * Retry any failure, not just retryable errors (safety net mode).
	 * When true, all failures are retried up to maxRetries.
	 * When false (default), only retryable errors trigger retries.
	 * @default false
	 */
	retryOnAnyFailure?: boolean;
	/**
	 * Enable tmux mode for interactive observation (OpenCode only).
	 * When enabled, creates tmux sessions with OpenCode TUI attached.
	 * @default false
	 */
	tmuxMode?: boolean;
	/**
	 * Configuration for tmux mode.
	 */
	tmuxConfig?: {
		/** Show attach command in output */
		showAttachCommand?: boolean;
		/** Automatically attach to tmux session (not recommended for parallel execution) */
		autoAttach?: boolean;
		/** Prefix for tmux session names */
		sessionPrefix?: string;
	};
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Result of a single branch merge attempt
 */
interface BranchMergeResult {
	branch: string;
	success: boolean;
	error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of retry attempts for merge conflicts
 */
const MAX_MERGE_RETRIES = 3;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Group tasks by issue_id
 */
export function groupTasksByIssue(tasks: StateTask[], issues: Issue[]): IssueGroup[] {
	const issueMap = new Map<string, Issue>();
	for (const issue of issues) {
		issueMap.set(issue.id, issue);
	}

	const groupMap = new Map<string, StateTask[]>();

	for (const task of tasks) {
		const issueId = task.issue_id || "UNASSIGNED";
		if (!groupMap.has(issueId)) {
			groupMap.set(issueId, []);
		}
		groupMap.get(issueId)?.push(task);
	}

	const groups: IssueGroup[] = [];

	for (const [issueId, issueTasks] of groupMap) {
		const issue = issueMap.get(issueId);
		if (!issue) {
			logWarn(`Issue ${issueId} not found for ${issueTasks.length} task(s)`);
			continue;
		}

		groups.push({
			issueId,
			issue,
			tasks: issueTasks,
		});
	}

	// Sort by issue severity (CRITICAL > HIGH > MEDIUM > LOW)
	const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
	groups.sort((a, b) => {
		const aSeverity = severityOrder[a.issue.severity] ?? 4;
		const bSeverity = severityOrder[b.issue.severity] ?? 4;
		return aSeverity - bSeverity;
	});

	return groups;
}

/**
 * Build comprehensive prompt for issue-based execution
 * Includes: issue details, validation report, WBS plan, all tasks
 */
export function buildIssueExecutorPrompt(issueGroup: IssueGroup, workDir: string): string {
	const parts: string[] = [];
	const { issue, tasks } = issueGroup;

	// Role definition
	parts.push(`## Role: Milhouse Executor Agent (EX)
${AGENT_ROLES.EX}

You are executing ALL tasks for a single issue as part of the Milhouse pipeline.
Each task should be implemented with minimal, focused changes.
Complete tasks in order, respecting dependencies.

⚠️ **CRITICAL**: You must complete ALL ${tasks.length} task(s) in this session.
After each task, commit your changes before proceeding to the next.`);

	// Load config using modern service
	const config = getConfigService(workDir).getConfig();

	// Add project context if available
	if (config?.project) {
		const contextParts: string[] = [];
		if (config.project.name) contextParts.push(`Project: ${config.project.name}`);
		if (config.project.language) contextParts.push(`Language: ${config.project.language}`);
		if (config.project.framework) contextParts.push(`Framework: ${config.project.framework}`);
		if (config.project.description) contextParts.push(`Description: ${config.project.description}`);
		if (contextParts.length > 0) {
			parts.push(`## Project Context\n${contextParts.join("\n")}`);
		}
	}

	// Add config info
	if (config) {
		const configParts: string[] = [];
		if (config.commands.test) configParts.push(`Test command: ${config.commands.test}`);
		if (config.commands.lint) configParts.push(`Lint command: ${config.commands.lint}`);
		if (config.commands.build) configParts.push(`Build command: ${config.commands.build}`);
		if (configParts.length > 0) {
			parts.push(`## Available Commands\n${configParts.join("\n")}`);
		}
	}

	// Issue summary
	parts.push(`## Issue to Fix

| Field | Value |
|-------|-------|
| **ID** | ${issue.id} |
| **Status** | ${issue.status} |
| **Severity** | ${issue.severity} |
| **Symptom** | ${issue.symptom} |
| **Hypothesis** | ${issue.hypothesis} |
${issue.corrected_description ? `| **Corrected Description** | ${issue.corrected_description} |` : ""}
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}`);

	// Load and include validation report if exists
	// Use run-aware path for validation reports
	const milhouseDir = getMilhouseDir(workDir);
	const validationReportPath = join(milhouseDir, "validation-reports", `${issue.id}.json`);
	if (existsSync(validationReportPath)) {
		try {
			const reportContent = readFileSync(validationReportPath, "utf-8");
			const report = JSON.parse(reportContent);

			parts.push(`## Validation Report

### Summary
${report.summary || "N/A"}

### Root Cause Analysis
${report.root_cause_analysis?.confirmed_cause || "Not determined"}

### Recommended Fix Approach
${report.recommendations?.fix_approach || "See tasks below"}

### Files Examined During Validation
${(report.investigation?.files_examined || []).map((f: string) => `- \`${f}\``).join("\n") || "None documented"}

### Related Code Locations
${
	(report.investigation?.related_code || [])
		.map(
			(c: { file: string; line_start: number; line_end: number; relevance: string }) =>
				`- \`${c.file}:${c.line_start}-${c.line_end}\` - ${c.relevance}`,
		)
		.join("\n") || "None documented"
}`);
		} catch {
			logDebug(`Failed to load validation report for ${issue.id}`);
		}
	}

	// Load and include WBS plan if exists
	// Use PlanStore for run-aware plan reading
	const planContent = readIssueWbsPlan(workDir, issue.id);
	if (planContent) {
		// Extract just the research findings and task overview sections
		const researchMatch = planContent.match(/## Research Findings[\s\S]*?(?=## Tasks|$)/);
		if (researchMatch) {
			parts.push(`## Research Findings (from WBS)

${researchMatch[0]}`);
		}
	}

	// Tasks to execute
	parts.push(`## Tasks to Execute (${tasks.length} total)

Execute these tasks IN ORDER. Commit after each task.
`);

	// Sort tasks by parallel_group, then by dependencies
	const sortedTasks = [...tasks].sort((a, b) => {
		if (a.parallel_group !== b.parallel_group) {
			return a.parallel_group - b.parallel_group;
		}
		return a.id.localeCompare(b.id);
	});

	for (let i = 0; i < sortedTasks.length; i++) {
		const task = sortedTasks[i];
		parts.push(`### Task ${i + 1}: ${task.id}

**Title**: ${task.title}
**Status**: ${task.status}
${task.description ? `**Description**: ${task.description}` : ""}

#### Files to Modify
${task.files.length > 0 ? task.files.map((f) => `- \`${f}\``).join("\n") : "- To be determined based on implementation"}

#### Dependencies
${task.depends_on.length > 0 ? task.depends_on.join(", ") : "None"}

#### Verification Commands
${task.checks.length > 0 ? task.checks.map((c) => `- \`${c}\``).join("\n") : "- Run tests after changes"}

#### Acceptance Criteria
${
	task.acceptance.length > 0
		? task.acceptance
				.map(
					(a) =>
						`- [ ] ${a.description}${a.check_command ? ` (verify: \`${a.check_command}\`)` : ""}`,
				)
				.join("\n")
		: "- All tests pass\n- No lint errors\n- Code review ready"
}

${task.risk ? `#### Risk: ${task.risk}` : ""}
${task.rollback ? `#### Rollback: ${task.rollback}` : ""}

---
`);
	}

	// Execution instructions
	parts.push(`## Execution Protocol

1. **For each task in order:**
	  a. Read and understand the task requirements
	  b. Examine the files mentioned
	  c. Implement the changes with minimal modifications
	  d. Run verification commands
	  e. Commit with message: "[${issue.id}] Task N: <title>"

2. **Important Guidelines:**
	  - Complete ALL ${tasks.length} tasks before finishing
	  - Keep changes focused and minimal
	  - Run tests after each task
	  - Do NOT add TODO/placeholder code
	  - Do NOT modify unrelated files
	  - Commit after EACH task

3. **After completing all tasks:**
	  - Ensure all tests pass
	  - Run lint checks
	  - Review all changes

## Start Now

Begin with Task 1. Good luck!`);

	return parts.join("\n\n");
}

// ============================================================================
// Merge Functions
// ============================================================================

/**
 * Display detailed branch status summary with actionable instructions
 *
 * Shows status for ALL branches (complete, partial, failed) and provides
 * specific instructions for each branch based on its status.
 */
export function displayBranchStatusSummary(
	branchStatuses: BranchStatus[],
	targetBranch: string,
): void {
	if (branchStatuses.length === 0) {
		logInfo("No branches to report.");
		return;
	}

	const complete = branchStatuses.filter((b) => b.status === "complete");
	const partial = branchStatuses.filter((b) => b.status === "partial");
	const failed = branchStatuses.filter((b) => b.status === "failed");
	const merged = branchStatuses.filter((b) => b.merged);
	const unmerged = branchStatuses.filter((b) => !b.merged);

	logInfo(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         BRANCH STATUS SUMMARY                                  ║
╚═══════════════════════════════════════════════════════════════════════════════╝

  Total branches:     ${branchStatuses.length}
  ✓ Complete:         ${complete.length} (all tasks done)
  ◐ Partial:          ${partial.length} (some tasks done)
  ✗ Failed:           ${failed.length} (no tasks done)
  
  Merged:             ${merged.length}
  Unmerged:           ${unmerged.length}
`);

	// Show complete branches
	if (complete.length > 0) {
		logInfo(`
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✓ COMPLETE BRANCHES (${complete.length})                                              │
└─────────────────────────────────────────────────────────────────────────────┘`);
		for (const b of complete) {
			const mergeStatus = b.merged ? "✓ merged" : "⏳ pending merge";
			logInfo(`  ${b.branch}`);
			logInfo(`    Issue: ${b.issueId} | Tasks: ${b.completedTasks}/${b.totalTasks} | ${mergeStatus}`);
			if (!b.merged) {
				logSuccess(`    → Ready to merge: git checkout ${targetBranch} && git merge --no-ff ${b.branch}`);
			}
		}
	}

	// Show partial branches
	if (partial.length > 0) {
		logInfo(`
┌─────────────────────────────────────────────────────────────────────────────┐
│ ◐ PARTIAL BRANCHES (${partial.length}) - Some tasks completed                         │
└─────────────────────────────────────────────────────────────────────────────┘`);
		for (const b of partial) {
			logWarn(`  ${b.branch}`);
			logWarn(`    Issue: ${b.issueId} | Tasks: ${b.completedTasks}/${b.totalTasks} completed`);
			logInfo(`    Options:`);
			logInfo(`      1. Merge partial work: git checkout ${targetBranch} && git merge --no-ff ${b.branch}`);
			logInfo(`      2. Re-run failed tasks: milhouse exec --issue ${b.issueId}`);
			logInfo(`      3. Inspect branch: git checkout ${b.branch} && git log --oneline`);
		}
	}

	// Show failed branches
	if (failed.length > 0) {
		logInfo(`
┌─────────────────────────────────────────────────────────────────────────────┐
│ ✗ FAILED BRANCHES (${failed.length}) - No tasks completed                             │
└─────────────────────────────────────────────────────────────────────────────┘`);
		for (const b of failed) {
			logError(`  ${b.branch}`);
			logError(`    Issue: ${b.issueId} | Error: ${b.error || "Unknown error"}`);
			logInfo(`    Options:`);
			logInfo(`      1. Re-run: milhouse exec --issue ${b.issueId}`);
			logInfo(`      2. Delete branch: git branch -D ${b.branch}`);
			logInfo(`      3. Inspect: git checkout ${b.branch} && git status`);
		}
	}

	// Show unmerged branches that need attention
	const unmergableComplete = complete.filter((b) => !b.merged);
	if (unmergableComplete.length > 0) {
		logInfo(`
┌─────────────────────────────────────────────────────────────────────────────┐
│ MANUAL MERGE REQUIRED (${unmergableComplete.length} branches)                                  │
└─────────────────────────────────────────────────────────────────────────────┘

To merge all complete branches manually:

  git checkout ${targetBranch}`);
		for (const b of unmergableComplete) {
			logInfo(`  git merge --no-ff ${b.branch}`);
		}
		logInfo(`
After successful merge, clean up branches:
`);
		for (const b of unmergableComplete) {
			logInfo(`  git branch -d ${b.branch}`);
		}
	}

	logInfo(`
═════════════════════════════════════════════════════════════════════════════════
`);
}

/**
 * Display helpful manual merge instructions when automatic merge fails
 *
 * This is shown when Milhouse fails to merge branches due to worktree locks
 * or other issues. After worktrees are cleaned up, branches become available
 * for manual merging.
 */
function displayManualMergeInstructions(failedBranches: string[], targetBranch: string): void {
	logInfo(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         MANUAL MERGE INSTRUCTIONS                             ║
╚═══════════════════════════════════════════════════════════════════════════════╝

Milhouse has cleaned up worktrees (see "Cleaned up worktree: ..." in log above).
This means branches are no longer locked and you can merge them manually.

┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 0: Make ${targetBranch} clean (important!)                                       │
└─────────────────────────────────────────────────────────────────────────────┘

If you have local changes in the main repo, stash them first:

  git stash push -u -m "temp before manual merge"

┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 1: Merge branches into ${targetBranch}                                           │
└─────────────────────────────────────────────────────────────────────────────┘

  git checkout ${targetBranch}
`);

	for (const branch of failedBranches) {
		logInfo(`  git merge --no-ff ${branch}`);
	}

	logInfo(`
If there are no conflicts, you're done!

┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 2: (Optional) Clean up branches after successful merge                 │
└─────────────────────────────────────────────────────────────────────────────┘
`);

	for (const branch of failedBranches) {
		logInfo(`  git branch -d ${branch}`);
	}

	logInfo(`
═════════════════════════════════════════════════════════════════════════════════
`);
}

/**
 * Info about an issue for creating human-readable commit messages
 */
interface IssueInfo {
	/** Issue ID */
	id: string;
	/** Human-readable description (symptom) */
	title: string;
}

/**
 * Merge completed branches back to base using rebase-then-merge strategy
 *
 * This function:
 * 1. Processes branches SEQUENTIALLY to prevent race conditions
 * 2. First tries to rebase each branch onto the latest target
 * 3. If rebase has conflicts, uses AI to resolve them
 * 4. Then performs a fast-forward merge
 * 5. Retries up to MAX_MERGE_RETRIES times on failure
 *
 * IMPORTANT: Sequential processing is critical because:
 * - Each successful merge changes the target branch
 * - Subsequent branches must rebase onto the NEW target state
 * - Parallel merges would cause conflicts and race conditions
 *
 * @param branches - List of branches to merge
 * @param targetBranch - Target branch to merge into
 * @param engine - AI engine for conflict resolution
 * @param workDir - Working directory
 * @param branchToIssueInfo - Map of branch name to issue info for commit messages
 * @param modelOverride - Optional model override
 * @returns Array of results for each branch
 */
async function mergeCompletedBranches(
	branches: string[],
	targetBranch: string,
	engine: AIEngine,
	workDir: string,
	branchToIssueInfo: Map<string, IssueInfo>,
	modelOverride?: string,
): Promise<BranchMergeResult[]> {
	const results: BranchMergeResult[] = [];

	if (branches.length === 0) return results;

	logInfo(
		`Merging ${branches.length} branch(es) into ${targetBranch} using rebase-then-merge strategy`,
	);
	logInfo(`Branches will be merged SEQUENTIALLY to avoid conflicts`);

	// Process branches ONE BY ONE - this is intentional!
	// Each merge changes the target branch, so subsequent branches must rebase onto the new state
	for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
		const branch = branches[branchIndex];
		let success = false;
		let lastError: string | undefined;

		logInfo(`\n[Branch ${branchIndex + 1}/${branches.length}] Processing ${branch}...`);

		// First check if branch exists (it might have been deleted during cleanup)
		const existsResult = await branchExists(branch, workDir);
		if (!existsResult.ok || !existsResult.value) {
			logWarn(`Branch ${branch} does not exist (may have been cleaned up), skipping`);
			results.push({
				branch,
				success: false,
				error: "Branch does not exist",
			});
			continue;
		}

		// Retry loop for this branch
		for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
			logInfo(`  [Attempt ${attempt}/${MAX_MERGE_RETRIES}]`);

			// Step 1: Ensure we're on the target branch before rebase
			// This is important because rebase will checkout the source branch
			logDebug(`  Checking out target branch ${targetBranch} before rebase...`);

			// Step 2: Try to rebase the branch onto the latest target
			const rebaseResultVcs = await rebaseBranch(branch, targetBranch, workDir);

			// Handle VcsResult - extract the RebaseResult or create error result
			let rebaseResult: RebaseResult & { error?: string; stderr?: string; errorCode?: string };
			if (!rebaseResultVcs.ok) {
				// Detailed error handling based on error code
				const errorCode = rebaseResultVcs.error.code;
				const errorMessage = rebaseResultVcs.error.message;
				const stderr = rebaseResultVcs.error.context?.stderr as string | undefined;

				rebaseResult = {
					success: false,
					hasConflicts: false,
					conflictedFiles: [],
					error: errorMessage,
					stderr,
					errorCode,
				};

				// Log specific error types for debugging
				if (errorCode === "DIRTY_WORKTREE") {
					logError(`  ✗ Cannot rebase: worktree has uncommitted changes`);
					logInfo(`    Suggestion: Commit or stash changes before merge`);
				} else if (errorCode === "BRANCH_LOCKED") {
					logError(`  ✗ Cannot rebase: branch is checked out in another worktree`);
					logInfo(`    Suggestion: Remove the worktree first with 'git worktree remove'`);
				} else if (errorCode === "BRANCH_NOT_FOUND") {
					logError(`  ✗ Cannot rebase: branch ${branch} not found`);
				} else {
					logError(`  ✗ Rebase failed: ${errorMessage}`);
				}
			} else {
				rebaseResult = rebaseResultVcs.value;
			}

			if (rebaseResult.success) {
				// Rebase succeeded cleanly, now do the fast-forward merge
				logDebug(`  ✓ Rebase succeeded, performing merge...`);
	
					// Create human-readable commit message from issue info
					const issueInfo = branchToIssueInfo.get(branch);
					const commitMessage = issueInfo
						? issueInfo.title
						: undefined;
	
					const mergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
						message: commitMessage,
					});

				if (mergeResultVcs.ok && mergeResultVcs.value.success) {
					logSuccess(`  ✓ Successfully merged ${branch}`);
					await deleteLocalBranch(branch, workDir, true);
					success = true;
					break;
				}

				lastError = !mergeResultVcs.ok
					? mergeResultVcs.error.message
					: "Merge failed after successful rebase";
				logWarn(`  ✗ Merge failed after rebase: ${lastError}`);
				
				// Abort any in-progress merge before retry
				await abortMerge(workDir);
				continue;
			}

			// Rebase has conflicts
				if (rebaseResult.hasConflicts && rebaseResult.conflictedFiles) {
					logWarn(
						`  ⚠ Rebase conflict (${rebaseResult.conflictedFiles.length} files): ${rebaseResult.conflictedFiles.join(", ")}`,
					);
					logInfo(`  Attempting AI resolution...`);
	
					// Use AI to resolve rebase conflicts
					const conflicts = createMergeConflictInfo(rebaseResult.conflictedFiles, branch, targetBranch);
					const resolutionResult = await resolveConflictsWithEngine(engine, conflicts, workDir, modelOverride);
					const resolved = resolutionResult.success;
	
					// Get issue info for commit message
					const issueInfoForConflict = branchToIssueInfo.get(branch);
	
					if (resolved) {
						// AI resolved conflicts, now complete the merge
						logDebug(`  ✓ AI resolved conflicts`);
	
						const mergeResultVcs2 = await mergeAgentBranch(branch, targetBranch, workDir, {
							message: issueInfoForConflict?.title,
						});

					if (mergeResultVcs2.ok && mergeResultVcs2.value.success) {
						logSuccess(`  ✓ Successfully merged ${branch} after AI conflict resolution`);
						await deleteLocalBranch(branch, workDir, true);
						success = true;
						break;
					}

					// Merge still failed, abort and retry
					lastError = !mergeResultVcs2.ok
						? mergeResultVcs2.error.message
						: "Merge failed after conflict resolution";
					logWarn(`  ✗ Merge failed after AI resolution: ${lastError}`);
					await abortMerge(workDir);
					continue;
				}

				// AI couldn't resolve conflicts
				lastError = `AI failed to resolve rebase conflicts (${rebaseResult.conflictedFiles.join(", ")})`;
				logWarn(`  ✗ ${lastError}`);
				await abortRebase(workDir);

				// Try falling back to direct merge with AI resolution
				if (attempt < MAX_MERGE_RETRIES) {
					logInfo(`  Attempting direct merge as fallback...`);

					const directMergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
						message: issueInfoForConflict?.title,
					});

					if (directMergeResultVcs.ok && directMergeResultVcs.value.success) {
						logSuccess(`  ✓ Direct merge succeeded`);
						await deleteLocalBranch(branch, workDir, true);
						success = true;
						break;
					}

					if (
						directMergeResultVcs.ok &&
						directMergeResultVcs.value.hasConflicts &&
						directMergeResultVcs.value.conflictedFiles
					) {
						logWarn(`  ⚠ Direct merge has conflicts, attempting AI resolution...`);
	
							const directConflicts = createMergeConflictInfo(directMergeResultVcs.value.conflictedFiles, branch, targetBranch);
							const directResolutionResult = await resolveConflictsWithEngine(engine, directConflicts, workDir, modelOverride);
	
							if (directResolutionResult.success) {
							logSuccess(`  ✓ Direct merge with AI resolution succeeded`);
							await deleteLocalBranch(branch, workDir, true);
							success = true;
							break;
						}

						await abortMerge(workDir);
					}
				}

				continue;
			}

			// Some other rebase error (not conflict)
			lastError = rebaseResult.error || "Unknown rebase error";
			logError(`  ✗ Rebase error: ${lastError}`);
			
			// Log detailed debug info
			if (rebaseResult.stderr) {
				logDebug(`  Git stderr: ${rebaseResult.stderr}`);
			}
			if (rebaseResult.errorCode) {
				logDebug(`  Error code: ${rebaseResult.errorCode}`);
			}
			
			await abortRebase(workDir);
			
			// For non-conflict errors, try direct merge as fallback
			if (attempt < MAX_MERGE_RETRIES) {
				logInfo(`  Attempting direct merge as fallback for non-conflict error...`);
				
				const issueInfoForDirect = branchToIssueInfo.get(branch);
				const directMergeResultVcs = await mergeAgentBranch(branch, targetBranch, workDir, {
					message: issueInfoForDirect?.title,
				});
				
				if (directMergeResultVcs.ok && directMergeResultVcs.value.success) {
					logSuccess(`  ✓ Direct merge succeeded (bypassed rebase)`);
					await deleteLocalBranch(branch, workDir, true);
					success = true;
					break;
				}
				
				if (directMergeResultVcs.ok && directMergeResultVcs.value.hasConflicts) {
					logWarn(`  ⚠ Direct merge has conflicts`);
					// Will retry with rebase on next attempt
					await abortMerge(workDir);
				}
			}
		}

		results.push({
			branch,
			success,
			error: success ? undefined : lastError,
		});

		if (!success) {
			logError(`  ✗ Failed to merge ${branch} after ${MAX_MERGE_RETRIES} attempts`);
			logWarn(`  Branch preserved for manual inspection`);
			logInfo(`  Manual merge: git checkout ${targetBranch} && git merge --no-ff ${branch}`);
		}
	}

	// Summary
	logInfo(`\n${"─".repeat(60)}`);
	const succeeded = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;

	if (failed > 0) {
		logWarn(`Merge summary: ${succeeded}/${branches.length} succeeded, ${failed} failed`);
		logInfo(`\nFailed branches:`);
		for (const result of results.filter((r) => !r.success)) {
			logError(`  - ${result.branch}: ${result.error}`);
		}
	} else {
		logSuccess(`All ${succeeded} branch(es) merged successfully`);
	}

	return results;
}

// ============================================================================
// Tmux Mode Types
// ============================================================================

/**
 * Information about a running OpenCode server for tmux mode
 */
interface TmuxServerInfo {
	/** Issue ID */
	issueId: string;
	/** Server port */
	port: number;
	/** Server URL */
	url: string;
	/** Tmux session name */
	tmuxSession: string;
	/** Attach command */
	attachCommand: string;
	/** OpenCode server executor */
	executor: OpencodeServerExecutor;
}

// ============================================================================
// Tmux Mode Functions
// ============================================================================

/**
 * Convert TmuxServerInfo to ServerInfo for UI display
 */
function toServerInfo(server: TmuxServerInfo, status: ServerInfo["status"] = "running"): ServerInfo {
	return {
		issueId: server.issueId,
		port: server.port,
		sessionName: server.tmuxSession,
		status,
		url: server.url,
	};
}

/**
 * Display tmux mode instructions with server URLs and attach commands
 * Uses the new UI components from engines/opencode/ui
 */
function displayTmuxModeInstructions(servers: TmuxServerInfo[]): void {
	const serverInfos: ServerInfo[] = servers.map((s) => toServerInfo(s, "running"));
	displayAttachInstructions(serverInfos);
}

/**
 * Execute an issue using tmux mode with OpenCode server
 *
 * This function:
 * 1. Starts an OpenCode server for the issue
 * 2. Creates a tmux session with `opencode attach` command
 * 3. Sends the prompt via the Server API
 * 4. Waits for completion
 * 5. Returns the result
 */
async function executeIssueTmuxMode(
	issueGroup: IssueGroup,
	worktreeDir: string,
	prompt: string,
	tmuxManager: TmuxSessionManager,
	options: {
		showAttachCommand?: boolean;
		modelOverride?: string;
	},
): Promise<{
	success: boolean;
	inputTokens: number;
	outputTokens: number;
	serverInfo: TmuxServerInfo;
	error?: string;
}> {
	const executor = new OpencodeServerExecutor({
		autoInstall: true,
		verbose: false,
	});

	let serverInfo: TmuxServerInfo | null = null;

	try {
		// Start the OpenCode server
		const port = await executor.startServer(worktreeDir);
		const url = `http://localhost:${port}`;

		// Create the session FIRST via the API so we have the session ID
		// This allows us to pass the session ID to the attach command
		const session = await executor.createSession({
			title: `Milhouse: ${issueGroup.issueId}`,
		});

		// Create tmux session with opencode attach, including the session ID
		// The -s flag tells opencode attach to navigate directly to this session
		const sessionName = tmuxManager.buildSessionName(issueGroup.issueId);
		const attachCmd = `opencode attach ${url} -s ${session.id}`;

		// Kill any existing session with the same name before creating a new one
		// This handles retry scenarios where old sessions still exist
		await tmuxManager.killSessionIfExists(issueGroup.issueId);

		const tmuxResult = await tmuxManager.createSession({
			name: issueGroup.issueId,
			command: attachCmd,
			workDir: worktreeDir,
		});

		if (!tmuxResult.success) {
			logWarn(`Failed to create tmux session: ${tmuxResult.error}`);
		}

		serverInfo = {
			issueId: issueGroup.issueId,
			port,
			url,
			tmuxSession: sessionName,
			attachCommand: tmuxManager.getAttachCommand(sessionName),
			executor,
		};

		// Show attach instructions if requested
		if (options.showAttachCommand) {
			logInfo(`  Issue ${issueGroup.issueId}: ${url}`);
			logInfo(`    Attach: opencode attach ${url} -s ${session.id}`);
			logInfo(`    Tmux:   ${serverInfo.attachCommand}`);
		}

		// Send the prompt and wait for completion
		// Use execution phase options with full tool access (EXECUTION_TOOLS)
		// and autonomy system prompt to prevent questions/hangs
		const response = await executor.sendMessage(
			session.id,
			prompt,
			getMessageOptionsForPhase("exec", options.modelOverride)
		);

		// Calculate tokens from response
		const inputTokens = response.info.inputTokens ?? 0;
		const outputTokens = response.info.outputTokens ?? 0;

		return {
			success: true,
			inputTokens,
			outputTokens,
			serverInfo,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			inputTokens: 0,
			outputTokens: 0,
			serverInfo: serverInfo ?? {
				issueId: issueGroup.issueId,
				port: 0,
				url: "",
				tmuxSession: "",
				attachCommand: "",
				executor,
			},
			error: errorMessage,
		};
	}
}

/**
 * Cleanup tmux mode resources (servers and sessions)
 */
async function cleanupTmuxResources(
	servers: TmuxServerInfo[],
	tmuxManager: TmuxSessionManager,
	killSessions = false,
): Promise<void> {
	for (const server of servers) {
		try {
			// Stop the OpenCode server
			await server.executor.stopServer();
			logDebug(`Stopped OpenCode server for ${server.issueId}`);
		} catch (error) {
			logWarn(`Failed to stop server for ${server.issueId}: ${error}`);
		}

		if (killSessions) {
			try {
				// Kill the tmux session
				await tmuxManager.killSession(server.issueId);
				logDebug(`Killed tmux session for ${server.issueId}`);
			} catch (error) {
				logWarn(`Failed to kill tmux session for ${server.issueId}: ${error}`);
			}
		}
	}

	// Release all ports
	PortManager.releaseAllPorts();
}

// ============================================================================
// Main Execution Function
// ============================================================================

/**
 * Run tasks grouped by issue with parallel worktree execution
 * Each issue's tasks run in a dedicated worktree
 *
 * IMPORTANT: Branches are queued and merged AFTER all agents complete
 * to prevent race conditions that cause merge conflicts.
 */
export async function runParallelByIssue(
	tasks: StateTask[],
	issues: Issue[],
	options: IssueBasedExecutionOptions,
): Promise<ExecutionResult> {
	const { engine, workDir, baseBranch, maxConcurrent, maxRetries, retryDelay, modelOverride } =
		options;

	// Group tasks by issue
	const issueGroups = groupTasksByIssue(tasks, issues);

	if (issueGroups.length === 0) {
		logWarn("No issue groups found");
		return {
			tasksCompleted: 0,
			tasksFailed: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
		};
	}

	// ============================================================================
	// TMUX MODE CHECK: Validate tmux mode requirements
	// ============================================================================
	let tmuxManager: TmuxSessionManager | null = null;
	const tmuxServers: TmuxServerInfo[] = [];

	if (options.tmuxMode) {
		// Try to ensure tmux is installed (with auto-install if possible)
		const tmuxResult = await ensureTmuxInstalled({ autoInstall: true, verbose: true });
		
		if (!tmuxResult.installed) {
			// Installation failed or not possible (e.g., Windows)
			logWarn("tmux is not available and could not be installed automatically.");
			if (tmuxResult.error) {
				logInfo(tmuxResult.error);
			}
			logInfo("Falling back to standard execution.");
			logInfo("");
			logInfo(getInstallationInstructions());
			options.tmuxMode = false;
		} else {
			// tmux is available (either was already installed or just installed)
			if (tmuxResult.installedNow) {
				logSuccess(`tmux ${tmuxResult.version ?? "unknown"} was installed successfully via ${tmuxResult.method}`);
			} else {
				logDebug(`tmux ${tmuxResult.version ?? "unknown"} is already installed`);
			}
			
			// Initialize tmux manager
			tmuxManager = new TmuxSessionManager({
				sessionPrefix: options.tmuxConfig?.sessionPrefix ?? "milhouse",
				verbose: false,
			});
			logInfo("Tmux mode enabled - OpenCode servers will be started with TUI attachment");
		}
	}

	// Setup graceful shutdown handler for tmux mode
	const cleanupHandler = async () => {
		if (tmuxServers.length > 0 && tmuxManager) {
			logInfo("\nCleaning up tmux resources...");
			await cleanupTmuxResources(tmuxServers, tmuxManager, true);
		}
	};

	// Register signal handlers for graceful shutdown
	if (options.tmuxMode) {
		process.on("SIGINT", async () => {
			await cleanupHandler();
			process.exit(130);
		});
		process.on("SIGTERM", async () => {
			await cleanupHandler();
			process.exit(143);
		});
	}

	const limit = pLimit(maxConcurrent);
	let totalCompleted = 0;
	let totalFailed = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	// Queue to collect successful branches for deferred merging
	// Map branch name to issue ID for tracking merge results
	const branchesToMerge: string[] = [];
	const branchToIssueMap = new Map<string, string>();
	// Map branch name to issue info for human-readable commit messages
	const branchToIssueInfo = new Map<string, IssueInfo>();

	// Track ALL branches for detailed status reporting (complete, partial, failed)
	const allBranchStatuses: BranchStatus[] = [];

	// Queue worktrees for cleanup BEFORE merge phase
	// Worktrees must be removed before merge so branches are not locked
	// Format: { worktreeDir, branchName }
	const worktreesToCleanup: { worktreeDir: string; branchName: string }[] = [];

	// Create spinner for issue-based execution
	const spinner = new DynamicAgentSpinner(
		maxConcurrent,
		issueGroups.length,
		"Issue execution in progress",
	);

	logInfo(
		`Starting parallel execution of ${issueGroups.length} issue(s) with ${maxConcurrent} concurrent agents`,
	);

	// ============================================================================
	// TMUX MODE: Display attach instructions header before execution starts
	// This shows users how to attach to the tmux sessions that will be created
	// ============================================================================
	if (options.tmuxMode && tmuxManager) {
		// Display the tmux mode header with placeholder instructions
		// Individual server info will be shown as each server starts
		displayTmuxModeHeader();
		logInfo("  Servers will be started for each issue. Attach commands will be shown below.");
		console.log("");
	}

	// Execute each issue in parallel (up to maxConcurrent)
	// NOTE: We do NOT merge inside this loop to prevent race conditions
	const promises = issueGroups.map((issueGroup, _idx) => {
		return limit(async () => {
			let worktreeDir = "";
			let branchName = "";
			const completedTasks: string[] = [];
			const failedTasks: string[] = [];
			let issueInputTokens = 0;
			let issueOutputTokens = 0;
			let slotNum = 0;

			try {
				// Acquire a slot
				slotNum = spinner.acquireSlot(issueGroup.issueId.slice(0, 12));

				// Create worktree for this issue
				// Use issueId as the runId for better traceability
				// The worktree will be created in .milhouse/work/worktrees/{runId}-{taskId}
				const runId = issueGroup.issueId;
				const worktreeResult = await createWorktree({
					task: `agent-${slotNum}`,
					agent: `agent-${slotNum}`,
					baseBranch,
					runId,
					workDir,
				});
				if (!worktreeResult.ok) {
					throw new Error(`Failed to create worktree: ${worktreeResult.error.message}`);
				}
				worktreeDir = worktreeResult.value.worktreePath;
				branchName = worktreeResult.value.branchName;

				spinner.updateSlot(slotNum, "worktree");

				// Ensure .milhouse/ exists and copy state files
				const milhouseDir = join(worktreeDir, MILHOUSE_DIR);
				if (!existsSync(milhouseDir)) {
					mkdirSync(milhouseDir, { recursive: true });
				}

				// Check for legacy plans that need to be imported before copying
				// This implements the fallback policy: if active run but no plans in run dir,
				// while legacy .milhouse/plans has plans, import them first
				if (hasLegacyPlansToImport(workDir)) {
					logWarn(
						`Legacy plans detected in .milhouse/plans but not in current run. Importing...`,
					);
					const imported = importLegacyPlans(workDir);
					if (imported > 0) {
						logInfo(`Imported ${imported} plan file(s) from legacy directory to current run`);
					}
				}

				// Copy validation reports from the run-aware milhouse directory
				const srcMilhouseDir = getMilhouseDir(workDir);
				const validationReportsSrc = join(srcMilhouseDir, "validation-reports");
				const validationReportsDest = join(milhouseDir, "validation-reports");
				if (existsSync(validationReportsSrc)) {
					cpSync(validationReportsSrc, validationReportsDest, { recursive: true });
				}

				// Copy plans from the run-scoped plans directory (not legacy .milhouse/plans)
				// This ensures worktrees get plans from the correct run
				const runScopedPlansDir = getCurrentPlansDir(workDir);
				const plansDest = join(milhouseDir, "plans");
				if (existsSync(runScopedPlansDir)) {
					cpSync(runScopedPlansDir, plansDest, { recursive: true });
					logDebug(`Copied plans from ${runScopedPlansDir} to worktree`);
				}

				// Build comprehensive prompt for this issue
				const prompt = buildIssueExecutorPrompt(issueGroup, worktreeDir);

				spinner.updateSlot(slotNum, `executing ${issueGroup.tasks.length} tasks`);

				// ============================================================================
				// EXECUTION: Choose between tmux mode and standard mode
				// ============================================================================
				if (options.tmuxMode && tmuxManager) {
					// TMUX MODE: Use OpenCode server with tmux session
					logDebug(`Executing issue ${issueGroup.issueId} in tmux mode`);

					const tmuxResult = await executeIssueTmuxMode(
						issueGroup,
						worktreeDir,
						prompt,
						tmuxManager,
						{
							showAttachCommand: options.tmuxConfig?.showAttachCommand ?? true,
							modelOverride,
						},
					);

					// Track server for cleanup
					tmuxServers.push(tmuxResult.serverInfo);

					if (tmuxResult.success) {
						issueInputTokens = tmuxResult.inputTokens;
						issueOutputTokens = tmuxResult.outputTokens;
					} else {
						throw new Error(tmuxResult.error ?? "Tmux mode execution failed");
					}
				} else {
					// STANDARD MODE: Use engine.execute directly
					// Execute with retry using modern API
					const engineOptions = modelOverride ? { modelOverride } : undefined;
					const retryConfig: MilhouseRetryConfig = {
						...DEFAULT_RETRY_CONFIG,
						maxRetries,
						baseDelayMs: retryDelay,
						retryOnAnyFailure: options.retryOnAnyFailure,
					};
					const retryResult = await executeWithRetry(
						async () => {
							const res = await engine.execute(prompt, worktreeDir, engineOptions);
							if (!res.success && res.error && isRetryableError(res.error)) {
								throw new Error(res.error);
							}
							return res;
						},
						retryConfig,
					);

					// Handle retry result
					if (!retryResult.success || !retryResult.value) {
						throw retryResult.error ?? new Error("Execution failed after retries");
					}

					const result = retryResult.value;
					issueInputTokens = result.inputTokens;
					issueOutputTokens = result.outputTokens;
				}

				// Analyze task completion by checking git commits in the worktree
				// This enables partial success detection - if some tasks were committed
				// before a failure, they will be correctly marked as completed
				const taskAnalysis = await analyzeIssueTaskCompletion(
					{ issueId: issueGroup.issueId, tasks: issueGroup.tasks },
					worktreeDir,
					baseBranch,
				);

				// Use analysis results instead of atomic success/failure
				completedTasks.push(...taskAnalysis.completedTaskIds);
				failedTasks.push(...taskAnalysis.failedTaskIds);

				logDebug(
					`Issue ${issueGroup.issueId} task analysis: ${taskAnalysis.completedTaskIds.length} completed, ${taskAnalysis.failedTaskIds.length} failed`,
				);

				// Report success only if all tasks completed
				const allTasksCompleted = failedTasks.length === 0;
				spinner.releaseSlot(slotNum, allTasksCompleted);
			} catch (_error) {
				// Even on exception, try to analyze partial completion
				// Some tasks may have been committed before the error occurred
				logDebug(
					`Issue ${issueGroup.issueId} execution threw exception, attempting partial completion analysis`,
				);
				if (worktreeDir) {
					try {
						const taskAnalysis = await analyzeIssueTaskCompletion(
							{ issueId: issueGroup.issueId, tasks: issueGroup.tasks },
							worktreeDir,
							baseBranch,
						);
						completedTasks.push(...taskAnalysis.completedTaskIds);
						failedTasks.push(...taskAnalysis.failedTaskIds);
						logDebug(
							`Issue ${issueGroup.issueId} partial analysis: ${taskAnalysis.completedTaskIds.length} completed, ${taskAnalysis.failedTaskIds.length} failed`,
						);
					} catch {
						// If analysis fails, mark all tasks as failed
						logDebug(
							`Issue ${issueGroup.issueId} partial analysis failed, marking all tasks as failed`,
						);
						for (const task of issueGroup.tasks) {
							failedTasks.push(task.id);
						}
					}
				} else {
					// No worktree available, mark all tasks as failed
					logDebug(
						`Issue ${issueGroup.issueId} no worktree available, marking all tasks as failed`,
					);
					for (const task of issueGroup.tasks) {
						failedTasks.push(task.id);
					}
				}
				if (slotNum > 0) {
					spinner.releaseSlot(slotNum, false);
				}
			}

			// Queue worktree for cleanup BEFORE merge phase
			// The worktree must be removed before merge so the branch is not locked
			// Branch commits are preserved - only the worktree directory is removed
			if (worktreeDir && branchName) {
				worktreesToCleanup.push({ worktreeDir, branchName });
				logDebug(
					`Queued worktree for cleanup before merge: ${worktreeDir} (branch: ${branchName})`,
				);
			}

			// Create issue result
			const issueResult: IssueExecutionResult = {
				issueId: issueGroup.issueId,
				completedTasks,
				failedTasks,
				inputTokens: issueInputTokens,
				outputTokens: issueOutputTokens,
				success: failedTasks.length === 0,
				branchName,
			};

			// Call callback (await for async-safe updates)
			await options.onIssueComplete?.(issueGroup.issueId, issueResult);

			// Track ALL branches for detailed status reporting
			if (branchName) {
				const totalTasks = issueGroup.tasks.length;
				const completedCount = completedTasks.length;
				const failedCount = failedTasks.length;

				// Determine status category
				let status: "complete" | "partial" | "failed";
				if (completedCount === totalTasks && failedCount === 0) {
					status = "complete";
				} else if (completedCount > 0) {
					status = "partial";
				} else {
					status = "failed";
				}

				allBranchStatuses.push({
					branch: branchName,
					issueId: issueGroup.issueId,
					status,
					completedTasks: completedCount,
					failedTasks: failedCount,
					totalTasks,
					merged: false, // Will be updated after merge phase
					error: issueResult.error,
				});

				branchToIssueMap.set(branchName, issueGroup.issueId);
					// Store issue info for human-readable commit messages
					branchToIssueInfo.set(branchName, {
						id: issueGroup.issueId,
						title: issueGroup.issue.symptom,
					});

				// Queue branch for merge AFTER all agents complete (do NOT merge here!)
				// This prevents race conditions where parallel merges conflict
				// Only queue complete branches for automatic merge
				if (issueResult.success) {
					branchesToMerge.push(branchName);
				}
			}

			return issueResult;
		});
	});

	// Wait for ALL agents to complete
	const results = await Promise.all(promises);

	spinner.success();

	// Aggregate results
	for (const result of results) {
		totalCompleted += result.completedTasks.length;
		totalFailed += result.failedTasks.length;
		totalInputTokens += result.inputTokens;
		totalOutputTokens += result.outputTokens;
	}

	// ============================================================================
	// WORKTREE CLEANUP PHASE: Cleanup worktrees BEFORE merge phase
	// This releases the branch locks so merge can checkout the branches
	// The branch commits are preserved - only the worktree directory is removed
	// ============================================================================
	if (worktreesToCleanup.length > 0) {
		logDebug(
			`Starting worktree cleanup BEFORE merge: ${worktreesToCleanup.length} worktree(s) to clean`,
		);

		for (const { worktreeDir, branchName } of worktreesToCleanup) {
			try {
				await cleanupWorktree({
					path: worktreeDir,
					originalDir: workDir,
				});
				logDebug(`Cleaned up worktree: ${worktreeDir} (branch ${branchName} preserved)`);
			} catch (error) {
				logWarn(`Failed to cleanup worktree ${worktreeDir}: ${error}`);
				// Continue with other cleanups even if one fails
			}
		}

		logDebug("Worktree cleanup completed - branches are now available for merge");
	}

	// ============================================================================
	// DEFERRED MERGE PHASE: Merge all branches AFTER worktree cleanup
	// Branches are now free to be checked out since worktrees are removed
	// ============================================================================
	logDebug(
		`Merge phase check: skipMerge=${options.skipMerge}, branchesToMerge.length=${branchesToMerge.length}`,
	);
	logDebug(
		`branchToIssueMap entries: ${Array.from(branchToIssueMap.entries())
			.map(([b, i]) => `${b}=>${i}`)
			.join(", ")}`,
	);

	// Track whether we stashed changes for later restoration
	let wasStashed = false;

	if (!options.skipMerge && branchesToMerge.length > 0) {
		// Pre-flight check: if workDir has uncommitted changes, auto-stash them
		const readinessResult = await checkMergeReadiness(workDir);
		if (readinessResult.ok && !readinessResult.value.ready) {
			logWarn(`⚠️ Detected dirty worktree: ${readinessResult.value.reason}`);
			logInfo("   Attempting auto-stash to enable merge...");

			// Auto-stash uncommitted changes
			const stashResult = await stashChanges(workDir, "milhouse-auto-stash-before-merge");
			if (stashResult.ok && stashResult.value.stashed) {
				wasStashed = true;
				logSuccess("   ✓ Changes stashed successfully. Will restore after merge.");
			} else {
				logWarn("   ⚠️ Could not stash changes. Merge may fail.");
				logWarn(`   ${readinessResult.value.suggestion}`);
			}
		}

		logInfo(`\n${"=".repeat(60)}`);
		logInfo("Starting deferred merge phase...");
		logInfo(`${branchesToMerge.length} branch(es) queued for merge into ${baseBranch}`);
		logInfo(`${"=".repeat(60)}\n`);

		const mergeResults = await mergeCompletedBranches(
			branchesToMerge,
			baseBranch,
			engine,
			workDir,
			branchToIssueInfo,
			modelOverride,
		);

		logDebug(`mergeCompletedBranches returned ${mergeResults.length} results`);

		// Update branch statuses with merge results
		for (const mergeResult of mergeResults) {
			const branchStatus = allBranchStatuses.find((b) => b.branch === mergeResult.branch);
			if (branchStatus) {
				branchStatus.merged = mergeResult.success;
				if (!mergeResult.success && mergeResult.error) {
					branchStatus.error = mergeResult.error;
				}
			}
		}

		// Log merge summary
		const mergeSucceeded = mergeResults.filter((r) => r.success).length;
		const mergeFailed = mergeResults.filter((r) => !r.success).length;

		if (mergeFailed > 0) {
			logWarn(
				`\nMerge phase completed: ${mergeSucceeded}/${branchesToMerge.length} branches merged successfully`,
			);
			logWarn(`${mergeFailed} branch(es) failed to merge and are preserved for manual inspection:`);
			for (const failedResult of mergeResults.filter((r) => !r.success)) {
				logError(`  - ${failedResult.branch}: ${failedResult.error}`);
			}
		} else {
			logSuccess(`\nMerge phase completed: All ${mergeSucceeded} branch(es) merged successfully!`);
		}

		// Call onMergeComplete callback with enhanced results including issueId (await for async-safe updates)
		logDebug(
			`Checking onMergeComplete callback: ${options.onMergeComplete ? "defined" : "undefined"}`,
		);
		if (options.onMergeComplete) {
			logDebug("Building mergeResultsWithIssue...");
			const mergeResultsWithIssue: MergeBranchResult[] = mergeResults.map((r) => ({
				branch: r.branch,
				success: r.success,
				issueId: branchToIssueMap.get(r.branch) || "UNKNOWN",
				error: r.error,
			}));
			logDebug(
				`Calling onMergeComplete with ${mergeResultsWithIssue.length} results: ${JSON.stringify(mergeResultsWithIssue)}`,
			);
			await options.onMergeComplete(mergeResultsWithIssue);
			logDebug("onMergeComplete callback completed");
		}

		// Restore stashed changes if we stashed them
		if (wasStashed) {
			logInfo("Restoring stashed changes...");
			const popResult = await popStash(workDir);
			if (popResult.ok && popResult.value) {
				logSuccess("   ✓ Stashed changes restored successfully.");
			} else {
				logWarn("   ⚠️ Could not restore stashed changes. Run 'git stash pop' manually.");
			}
		}
	} else if (options.skipMerge) {
		logInfo("Merge phase skipped (--skip-merge flag)");
		if (branchesToMerge.length > 0) {
			logInfo(`${branchesToMerge.length} branch(es) available for manual merge:`);
			for (const branch of branchesToMerge) {
				logInfo(`  - ${branch}`);
			}
		}
	}

	// ============================================================================
	// BRANCH STATUS SUMMARY: Display detailed status for ALL branches
	// Shows complete, partial, and failed branches with actionable instructions
	// ============================================================================
	if (allBranchStatuses.length > 0) {
		displayBranchStatusSummary(allBranchStatuses, baseBranch);
	}

	// ============================================================================
	// TMUX CLEANUP: Stop servers and optionally kill sessions
	// ============================================================================
	if (options.tmuxMode && tmuxManager && tmuxServers.length > 0) {
		// Update server statuses based on results
		const serverInfos: ServerInfo[] = tmuxServers.map((server) => {
			const result = results.find((r) => r.issueId === server.issueId);
			const status: ServerInfo["status"] = result?.success ? "completed" : "error";
			return toServerInfo(server, status);
		});

		// Display completion summary using the new UI component
		displayTmuxCompletionSummary(serverInfos);

		logInfo("Cleaning up tmux resources...");
		// Don't kill sessions by default so users can still attach and inspect
		await cleanupTmuxResources(tmuxServers, tmuxManager, false);
		logInfo("OpenCode servers stopped. Tmux sessions preserved for inspection.");
	}

	return {
		tasksCompleted: totalCompleted,
		tasksFailed: totalFailed,
		totalInputTokens,
		totalOutputTokens,
	};
}
