/**
 * Exec phase config — Executor (EX)
 *
 * Uses customExecute to delegate to the existing execution system
 * (issue-based parallel, task-based parallel, or sequential).
 * The PhaseRunner handles all boilerplate (locking, engine, cost, summary).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { AIEngine, AIResult } from "../../engines/types.ts";
import {
	type IssueExecutionResult,
	type MergeBranchResult,
	runParallelByIssue,
} from "../../execution/issue-executor.ts";
import { runParallelWithGroupOrdering } from "../../execution/steps/parallel.ts";
import { getConfigService } from "../../services/config/index.ts";
import { createExecutionSafe, updateExecution } from "../../state/executions.ts";
import { filterIssues, loadIssuesForRun } from "../../state/issues.ts";
import { getMilhouseDir, updateProgress } from "../../state/manager.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import {
	loadTasksForRun,
	readTask,
	updateTaskForRun,
	updateTaskForRunSafe,
} from "../../state/tasks.ts";
import type { Issue, RunPhase } from "../../state/types.ts";
import { AGENT_ROLES, type Task } from "../../state/types.ts";
import { formatTokens, logDebug, logInfo, logSuccess, logWarn } from "../../ui/logger.ts";
import { ProgressSpinner } from "../../ui/spinners.ts";
import {
	createTaskBranch,
	getCurrentBranch,
	returnToBaseBranch,
} from "../../vcs/services/branch-service.ts";
import { createPullRequest } from "../../vcs/services/pr-service.ts";
import type { RunCost } from "../cost.ts";
import { calculateCost } from "../cost.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import { resolvePhaseModel, resolvePhaseWorkers } from "../types.ts";
import type { PhaseConfig, PhaseContext, PhaseItemResult } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

/** Result stored per-task in PhaseItemResult */
interface ExecTaskResult {
	taskId: string;
	status: "done" | "failed";
	error?: string;
}

// ============================================================================
// Exported utility functions (used externally)
// ============================================================================

/**
 * Build the Executor prompt for a task
 */
export function buildExecutorPrompt(task: Task, workDir: string): string {
	const parts: string[] = [];

	parts.push(`## Role: Executor (EX)
${AGENT_ROLES.EX}

You are executing a specific task from the Execution Plan.
Your task is to implement the changes with minimal, focused modifications.`);

	const config = getConfigService(workDir).getConfig();

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

	if (config) {
		if (config.commands.test) parts.push(`Test command: ${config.commands.test}`);
		if (config.commands.lint) parts.push(`Lint command: ${config.commands.lint}`);
		if (config.commands.build) parts.push(`Build command: ${config.commands.build}`);
	}

	parts.push(`## Task to Execute

**ID**: ${task.id}
**Title**: ${task.title}
**Status**: ${task.status}
${task.issue_id ? `**Issue**: ${task.issue_id}` : ""}
${task.description ? `**Description**: ${task.description}` : ""}`);

	if (task.files.length > 0) {
		parts.push(`### Files to Modify
${task.files.map((f) => `- \`${f}\``).join("\n")}`);
	}

	if (task.checks.length > 0) {
		parts.push(`### Verification Commands
Run these commands after making changes:
${task.checks.map((c) => `- \`${c}\``).join("\n")}`);
	}

	if (task.acceptance.length > 0) {
		parts.push(`### Acceptance Criteria
${task.acceptance
	.map(
		(a) =>
			`- [ ] ${a.description}${a.check_command ? ` (verify with: \`${a.check_command}\`)` : ""}`,
	)
	.join("\n")}`);
	}

	if (task.risk) {
		parts.push(`### Risk Assessment
${task.risk}`);
	}

	if (task.rollback) {
		parts.push(`### Rollback Plan
${task.rollback}`);
	}

	parts.push(`## Instructions

1. Implement the task described above
2. Make minimal, focused changes - only modify what is necessary
3. Run the verification commands to ensure changes work
4. Verify all acceptance criteria are met
5. Commit your changes with a descriptive message

## Important Guidelines

- Do NOT modify files outside the scope of this task
- Do NOT refactor unrelated code
- Do NOT add TODO/mock/placeholder implementations
- Do NOT leave console.log statements
- Keep changes small and reviewable
- Write tests if the task requires new functionality
- Ensure all verification commands pass before committing`);

	return parts.join("\n\n");
}

/**
 * Reset tasks stuck in 'running' status back to 'pending'.
 *
 * When the pipeline crashes during execution, tasks that were set to 'running'
 * become permanently orphaned. This function recovers them so they can be
 * retried. Safe to call at beforeRun time when no tasks are legitimately
 * executing yet.
 */
export function resetStaleRunningTasks(runId: string, workDir: string): number {
	const tasks = loadTasksForRun(runId, workDir);
	let resetCount = 0;

	for (const task of tasks) {
		if (task.status === "running") {
			updateTaskForRun(runId, task.id, { status: "pending" }, workDir);
			logWarn(`Resetting stale running task ${task.id} to pending`);
			resetCount++;
		}
	}

	return resetCount;
}

/**
 * Get tasks ready for execution (pending or merge_error with all deps satisfied)
 */
export function getReadyTasksForRun(runId: string, workDir: string): Task[] {
	const tasks = loadTasksForRun(runId, workDir);
	const readyTasks: Task[] = [];

	for (const task of tasks) {
		if (task.status !== "pending" && task.status !== "merge_error") continue;

		const allDepsDone = task.depends_on.every((depId: string) => {
			const dep = tasks.find((t: Task) => t.id === depId);
			if (!dep) {
				logWarn(`Task '${task.id}' has dangling dependency '${depId}' (not found in task list), treating as satisfied`);
				return true;
			}
			return dep.status === "done";
		});

		if (allDepsDone) readyTasks.push(task);
	}

	return readyTasks.sort((a, b) => {
		if (a.parallel_group !== b.parallel_group) return a.parallel_group - b.parallel_group;
		return a.id.localeCompare(b.id);
	});
}

// ============================================================================
// Internal helpers
// ============================================================================

function writeIssueReport(
	issueId: string,
	issue: Issue | undefined,
	issueResult: {
		success: boolean;
		completedTasks: string[];
		failedTasks: string[];
		error?: string;
	},
	workDir: string,
): void {
	const milDir = getMilhouseDir(workDir);
	const progressPath = join(milDir, "progress.txt");
	if (!existsSync(milDir)) mkdirSync(milDir, { recursive: true });

	const timestamp = new Date().toISOString();
	const separator = "=".repeat(60);
	const lines: string[] = [
		"",
		separator,
		`[${timestamp}] ISSUE EXECUTION REPORT: ${issueId}`,
		separator,
	];

	if (issue) {
		lines.push(`Symptom: ${issue.symptom}`);
		lines.push(`Hypothesis: ${issue.hypothesis}`);
		lines.push(`Severity: ${issue.severity}`);
		lines.push(`Status: ${issue.status}`);
		if (issue.corrected_description)
			lines.push(`Corrected Description: ${issue.corrected_description}`);
		const fileEvidence = issue.evidence.find((e) => e.type === "file" && e.file);
		if (fileEvidence?.file) {
			lines.push(
				`Source File: ${fileEvidence.file}${fileEvidence.line_start ? `:${fileEvidence.line_start}` : ""}`,
			);
		}
	}

	lines.push("", `Result: ${issueResult.success ? "SUCCESS" : "FAILED"}`);
	lines.push(`Completed Tasks: ${issueResult.completedTasks.length}`);
	lines.push(`Failed Tasks: ${issueResult.failedTasks.length}`);

	if (issueResult.completedTasks.length > 0) {
		lines.push("", "Completed Tasks:");
		for (const taskId of issueResult.completedTasks) lines.push(`  + ${taskId}`);
	}
	if (issueResult.failedTasks.length > 0) {
		lines.push("", "Failed Tasks:");
		for (const taskId of issueResult.failedTasks) lines.push(`  x ${taskId}`);
	}
	if (issueResult.error) lines.push("", `Error: ${issueResult.error}`);

	lines.push(separator, "");
	appendFileSync(progressPath, lines.join("\n"));
}

async function executeSingleTask(
	task: Task,
	engine: AIEngine,
	workDir: string,
	modelOverride: string | undefined,
	spinner: ProgressSpinner,
): Promise<{
	success: boolean;
	inputTokens: number;
	outputTokens: number;
	response?: string;
	error?: string;
}> {
	const prompt = buildExecutorPrompt(task, workDir);
	logDebug(`Executing task ${task.id}: ${task.title}`);

	let result: AIResult;
	try {
		if (engine.executeStreaming) {
			result = await engine.executeStreaming(
				prompt,
				workDir,
				(step) => {
					if (step && typeof step === "object") {
						const detail = step.shortDetail ? ` ${step.shortDetail}` : "";
						spinner.updateStep(`${task.id}: ${step.category}${detail}`);
					} else if (step) {
						spinner.updateStep(`${task.id}: ${step}`);
					} else {
						spinner.updateStep(`${task.id}: Executing`);
					}
				},
				{ modelOverride },
			);
		} else {
			spinner.updateStep(`${task.id}: Executing`);
			result = await engine.execute(prompt, workDir, { modelOverride });
		}
	} catch (error) {
		return {
			success: false,
			inputTokens: 0,
			outputTokens: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return {
		success: result.success,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		response: result.response,
		error: result.error,
	};
}

async function executeTaskWithTracking(
	runId: string,
	task: Task,
	engine: AIEngine,
	workDir: string,
	config: import("../types.ts").ResolvedConfig,
	spinner: ProgressSpinner,
): Promise<{ success: boolean; inputTokens: number; outputTokens: number; error?: string }> {
	const modelOverride = resolvePhaseModel(config, "exec");
	const useBranches = !!(config.isolate && config.baseBranch);

	updateTaskForRun(runId, task.id, { status: "running" }, workDir);

	const executionRecord = await createExecutionSafe(
		{
			task_id: task.id,
			started_at: new Date().toISOString(),
			agent_role: "EX",
			input_tokens: 0,
			output_tokens: 0,
			follow_up_task_ids: [],
		},
		workDir,
	);

	let branch: string | undefined;
	if (useBranches && config.baseBranch) {
		const branchResult = await createTaskBranch(task.title, config.baseBranch, workDir);
		if (branchResult.ok) {
			branch = branchResult.value.branchName;
			logDebug(`Created branch: ${branch}`);
			if (branchResult.value.stashed && !branchResult.value.stashRestored) {
				logWarn("Stashed changes could not be restored after branch creation. Run 'git stash pop' manually.");
			}
			updateTaskForRun(runId, task.id, { branch }, workDir);
		} else {
			logDebug(`Failed to create branch: ${branchResult.error.message}`);
		}
	}

	const result = await executeSingleTask(task, engine, workDir, modelOverride, spinner);

	updateExecution(
		executionRecord.id,
		{
			completed_at: new Date().toISOString(),
			success: result.success,
			error: result.error,
			input_tokens: result.inputTokens,
			output_tokens: result.outputTokens,
			branch,
		},
		workDir,
	);

	if (result.success) {
		updateTaskForRun(
			runId,
			task.id,
			{ status: "done", completed_at: new Date().toISOString() },
			workDir,
		);

		if (config.createPr && branch && config.baseBranch) {
			const prResult = await createPullRequest(
				branch,
				config.baseBranch,
				`[${task.id}] ${task.title}`,
				`## Task\n\n${task.description || task.title}\n\n## Changes\n\nAutomated by Milhouse Executor (EX) agent.\n\n## Acceptance Criteria\n\n${task.acceptance.map((a) => `- [ ] ${a.description}`).join("\n") || "None specified"}`,
				{ draft: config.draftPr, workDir },
			);
			if (prResult.ok) {
				logSuccess(`PR created: ${prResult.value.url}`);
				updateExecution(executionRecord.id, { pr_url: prResult.value.url }, workDir);
			} else {
				logDebug(`Failed to create PR: ${prResult.error.message}`);
			}
		}
	} else {
		updateTaskForRun(runId, task.id, { status: "failed", error: result.error }, workDir);
	}

	if (useBranches && config.baseBranch) {
		await returnToBaseBranch(config.baseBranch, workDir);
	}

	return result;
}

// ============================================================================
// Phase config
// ============================================================================

export const execPhaseConfig: PhaseConfig<Task, ExecTaskResult> = {
	name: "exec",
	role: "EX",
	mode: "per-item",
	defaultParallel: 3,

	beforeRun(ctx: PhaseContext) {
		resetStaleRunningTasks(ctx.runId, ctx.workDir);
	},

	// Not used — customExecute replaces the standard flow
	loadItems() {
		throw new Error("exec uses customExecute");
	},
	buildPrompt() {
		throw new Error("exec uses customExecute");
	},
	parseResponse() {
		throw new Error("exec uses customExecute");
	},

	async customExecute(
		ctx: PhaseContext,
		runCost: RunCost,
	): Promise<PhaseItemResult<ExecTaskResult>[]> {
		const { runId, workDir, engine, config } = ctx;
		const modelOverride = resolvePhaseModel(config, "exec");

		// Load tasks
		const allTasks = loadTasksForRun(runId, workDir);
		let pendingTasks = allTasks.filter((t) => t.status === "pending" || t.status === "merge_error");

		// Severity filtering
		const hasSeverityFilter = !!(config.minSeverity || config.severityFilter?.length);
		if (hasSeverityFilter && pendingTasks.some((t) => t.issue_id)) {
			const allIssues = loadIssuesForRun(runId, workDir);
			const allowedIssues = filterIssues(allIssues, {
				issueIds: config.issueIds,
				excludeIssueIds: config.excludeIssueIds,
				severityFilter: config.severityFilter,
				minSeverity: config.minSeverity,
			});
			const allowedIssueIds = new Set(allowedIssues.map((i) => i.id));
			const before = pendingTasks.length;
			pendingTasks = pendingTasks.filter((t) => !t.issue_id || allowedIssueIds.has(t.issue_id));
			const filtered = before - pendingTasks.length;
			if (filtered > 0) logInfo(`Severity filter excluded ${filtered} task(s) from execution`);
		}

		if (pendingTasks.length === 0) {
			logWarn("No pending or merge_error tasks found.");
			return [];
		}

		const maxParallel = Math.min(resolvePhaseWorkers(config, 'exec') ?? config.workers ?? 3, pendingTasks.length);
		const useParallel = maxParallel > 1;
		const useExecByIssue = config.execByIssue;

		logInfo(`Pending tasks: ${pendingTasks.length}`);
		if (config.minSeverity) logInfo(`Minimum severity: ${config.minSeverity}`);
		if (config.severityFilter?.length)
			logInfo(`Severity filter: ${config.severityFilter.join(", ")}`);
		if (useParallel) logInfo(`Running up to ${maxParallel} tasks in parallel`);
		console.log("");

		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let tasksCompleted = 0;
		let tasksFailed = 0;
		const errors: string[] = [];

		// Single task mode
		if (config.taskId) {
			const specificTask = readTask(config.taskId, workDir);
			if (!specificTask) throw new Error(`Task not found: ${config.taskId}`);
			if (specificTask.status !== "pending")
				throw new Error(`Task not pending (status: ${specificTask.status}): ${config.taskId}`);

			const spinner = new ProgressSpinner("Executing tasks", ["EX"]);
			const result = await executeTaskWithTracking(
				runId,
				specificTask,
				engine,
				workDir,
				config,
				spinner,
			);
			totalInputTokens += result.inputTokens;
			totalOutputTokens += result.outputTokens;

			if (result.success) {
				tasksCompleted = 1;
				spinner.success(`Task ${config.taskId} completed`);
			} else {
				tasksFailed = 1;
				if (result.error) errors.push(`${config.taskId}: ${result.error}`);
				spinner.warn(`Task ${config.taskId} failed: ${result.error}`);
			}
		} else if (useExecByIssue) {
			// Issue-based parallel execution (DEFAULT)
			logInfo("Using issue-based parallel execution");

			let issues = loadIssuesForRun(runId, workDir);

			// Derive synthetic issues from tasks if needed
			if (issues.length === 0 && pendingTasks.some((t) => t.issue_id)) {
				logWarn("No issues found in current run, deriving from task issue_ids...");
				const issueIds = new Set(pendingTasks.map((t) => t.issue_id).filter(Boolean) as string[]);
				issues = Array.from(issueIds).map((id) => ({
					id,
					type: "task" as const,
					title: `Work item ${id} (derived from tasks)`,
					symptom: `Work item ${id} (derived from tasks)`,
					hypothesis: "Derived from task assignments",
					evidence: [],
					status: "CONFIRMED" as const,
					severity: "MEDIUM" as const,
					related_task_ids: pendingTasks.filter((t) => t.issue_id === id).map((t) => t.id),
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				}));
				logInfo(`Derived ${issues.length} issue(s) from task assignments`);
			}

			const validIssues = filterIssues(issues, {
				issueIds: config.issueIds,
				excludeIssueIds: config.excludeIssueIds,
				severityFilter: config.severityFilter,
				minSeverity: config.minSeverity,
				statusFilter: ["CONFIRMED", "PARTIAL"],
			});

			if (validIssues.length === 0) {
				logWarn("No validated issues found.");
				return [];
			}

			let currentBranch = config.baseBranch;
			if (!currentBranch) {
				const branchResult = await getCurrentBranch(workDir);
				if (!branchResult.ok)
					throw new Error(`Failed to get current branch: ${branchResult.error.message}`);
				currentBranch = branchResult.value;
			}
			logInfo(`Base branch: ${currentBranch}`);
			logInfo(`Issues to process: ${validIssues.length}`);
			console.log("");

			const issueResult = await runParallelByIssue(pendingTasks, validIssues, {
				engine,
				workDir,
				baseBranch: currentBranch,
				maxConcurrent: maxParallel,
				maxRetries: config.maxRetries,
				retryDelay: 5000,
				skipTests: config.skipTests,
				skipLint: config.skipLint,
				browserEnabled: "auto",
				modelOverride,
				skipMerge: config.skipMerge,
				failFast: config.failFast,
				tmuxMode: config.tmux,
				tmuxConfig: { autoAttach: config.tmuxAutoAttach, showAttachCommand: true },
				onIssueComplete: async (issueId: string, result: IssueExecutionResult) => {
					for (const taskId of result.completedTasks) {
						await updateTaskForRunSafe(
							runId,
							taskId,
							{ status: "done", completed_at: new Date().toISOString() },
							workDir,
						);
						await createExecutionSafe(
							{
								task_id: taskId,
								started_at: new Date().toISOString(),
								completed_at: new Date().toISOString(),
								agent_role: "EX",
								success: true,
								input_tokens: 0,
								output_tokens: 0,
								follow_up_task_ids: [],
							},
							workDir,
						);
					}
					for (const taskId of result.failedTasks) {
						await updateTaskForRunSafe(
							runId,
							taskId,
							{ status: "failed", error: result.error },
							workDir,
						);
						await createExecutionSafe(
							{
								task_id: taskId,
								started_at: new Date().toISOString(),
								completed_at: new Date().toISOString(),
								agent_role: "EX",
								success: false,
								error: result.error,
								input_tokens: 0,
								output_tokens: 0,
								follow_up_task_ids: [],
							},
							workDir,
						);
					}
					const issue = validIssues.find((i) => i.id === issueId);
					writeIssueReport(issueId, issue, result, workDir);
					logInfo(
						`Issue ${issueId}: ${result.completedTasks.length} completed, ${result.failedTasks.length} failed`,
					);
				},
				onMergeComplete: async (mergeResults: MergeBranchResult[]) => {
					logInfo(`onMergeComplete callback invoked with ${mergeResults.length} merge result(s)`);
					const failedMerges = mergeResults.filter((r) => !r.success);
					if (failedMerges.length > 0) {
						logWarn(`Updating task status for ${failedMerges.length} failed merge(s)...`);
						for (const failedMerge of failedMerges) {
							const tasksForIssue = loadTasksForRun(runId, workDir).filter(
								(t: Task) => t.issue_id === failedMerge.issueId && t.status === "done",
							);
							for (const task of tasksForIssue) {
								await updateTaskForRunSafe(
									runId,
									task.id,
									{
										status: "merge_error",
										error: `Merge failed: ${failedMerge.error || "Unknown error"}`,
										completed_at: undefined,
									},
									workDir,
								);
								logDebug(`Task ${task.id} status changed from "done" to "merge_error"`);
							}
							logWarn(
								`Issue ${failedMerge.issueId}: ${tasksForIssue.length} task(s) marked as merge_error`,
							);
						}
					}
				},
			});

			tasksCompleted = issueResult.tasksCompleted;
			tasksFailed = issueResult.tasksFailed;
			totalInputTokens = issueResult.totalInputTokens;
			totalOutputTokens = issueResult.totalOutputTokens;

			if (issueResult.callbackErrors && issueResult.callbackErrors.length > 0) {
				for (const cbError of issueResult.callbackErrors) {
					logWarn(`Callback error during execution — task state may be inconsistent: ${cbError}`);
				}
			}

			const reloadedTasks = loadTasksForRun(runId, workDir);
			for (const task of reloadedTasks) {
				if (task.status === "failed" && task.error) errors.push(`${task.id}: ${task.error}`);
			}
		} else if (useParallel) {
			// Task-based parallel execution
			logInfo("Using worktree-based parallel execution (task-based)");

			let currentBranch = config.baseBranch;
			if (!currentBranch) {
				const branchResult = await getCurrentBranch(workDir);
				if (!branchResult.ok)
					throw new Error(`Failed to get current branch: ${branchResult.error.message}`);
				currentBranch = branchResult.value;
			}
			logInfo(`Base branch: ${currentBranch}`);

			const parallelResult = await runParallelWithGroupOrdering(pendingTasks, {
				engine,
				workDir,
				baseBranch: currentBranch,
				maxConcurrent: maxParallel,
				maxRetries: config.maxRetries,
				retryDelay: 5000,
				skipTests: config.skipTests,
				skipLint: config.skipLint,
				browserEnabled: "auto",
				prdSource: "state",
				prdFile: ".milhouse/tasks.json",
				modelOverride,
				skipMerge: config.skipMerge,
				failFast: config.failFast,
				onTaskComplete: async (taskId: string, success: boolean) => {
					await updateTaskForRunSafe(
						runId,
						taskId,
						{
							status: success ? "done" : "failed",
							completed_at: success ? new Date().toISOString() : undefined,
						},
						workDir,
					);
					await createExecutionSafe(
						{
							task_id: taskId,
							started_at: new Date().toISOString(),
							completed_at: new Date().toISOString(),
							agent_role: "EX",
							success,
							input_tokens: 0,
							output_tokens: 0,
							follow_up_task_ids: [],
						},
						workDir,
					);
				},
				onGroupComplete: (group, groupResult) => {
					logInfo(
						`Group ${group} complete: ${groupResult.completedTasks.length} completed, ${groupResult.failedTasks.length} failed`,
					);
				},
			});

			tasksCompleted = parallelResult.tasksCompleted;
			tasksFailed = parallelResult.tasksFailed;
			totalInputTokens = parallelResult.totalInputTokens;
			totalOutputTokens = parallelResult.totalOutputTokens;

			const reloadedTasks = loadTasksForRun(runId, workDir);
			for (const task of reloadedTasks) {
				if (task.status === "failed" && task.error) errors.push(`${task.id}: ${task.error}`);
			}
		} else {
			// Sequential execution
			const spinner = new ProgressSpinner("Executing tasks", ["EX"]);
			const maxIterations = pendingTasks.length;
			let iteration = 0;

			while (iteration < maxIterations) {
				const readyTasks = getReadyTasksForRun(runId, workDir);
				if (readyTasks.length === 0) {
					const remaining = loadTasksForRun(runId, workDir).filter(
						(t: Task) => t.status === "pending",
					);
					if (remaining.length > 0)
						logWarn(`${remaining.length} tasks blocked due to failed dependencies`);
					break;
				}

				const task = readyTasks[0];
				spinner.updateStep(`${task.id}: Starting`);

				const result = await executeTaskWithTracking(runId, task, engine, workDir, config, spinner);
				totalInputTokens += result.inputTokens;
				totalOutputTokens += result.outputTokens;
				iteration++;

				if (result.success) {
					tasksCompleted++;
				} else {
					tasksFailed++;
					if (result.error) errors.push(`${task.id}: ${result.error}`);
				}
			}

			if (errors.length > 0) {
				spinner.warn(`Execution completed with ${errors.length} error(s)`);
			} else if (tasksCompleted > 0) {
				spinner.success(`Execution complete ${formatTokens(totalInputTokens, totalOutputTokens)}`);
			} else {
				spinner.success("No tasks executed");
			}
		}

		// Update runCost for budget tracking
		const execCost = calculateCost(
			{ input: totalInputTokens, output: totalOutputTokens },
			config.cost,
		);
		runCost.totalCost += execCost;
		runCost.inputTokens += totalInputTokens;
		runCost.outputTokens += totalOutputTokens;
		runCost.totalTokens += totalInputTokens + totalOutputTokens;

		updateProgress(`Execution: ${tasksCompleted} completed, ${tasksFailed} failed`, workDir);

		// Store counters for formatSummary
		ctx.store.tasksCompleted = tasksCompleted;
		ctx.store.tasksFailed = tasksFailed;
		ctx.store.errors = errors;

		// Build PhaseItemResult array for the runner
		const results: PhaseItemResult<ExecTaskResult>[] = [];
		const finalTasks = loadTasksForRun(runId, workDir);
		for (const t of finalTasks) {
			if (t.status === "done" || t.status === "failed") {
				results.push({
					item: t,
					result: { taskId: t.id, status: t.status as "done" | "failed", error: t.error },
					success: t.status === "done",
					error: t.error,
					inputTokens: 0,
					outputTokens: 0,
				});
			}
		}
		// Attach aggregate tokens to first result so runner counts them
		if (results.length > 0) {
			results[0].inputTokens = totalInputTokens;
			results[0].outputTokens = totalOutputTokens;
		} else {
			// No results at all — create a synthetic result for token tracking
			results.push({
				item: {},
				result: { taskId: "aggregate", status: "done" },
				success: tasksCompleted > 0 && tasksFailed === 0,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			});
		}

		return results;
	},

	async saveResults(_results, ctx) {
		const finalTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		await updateRunStatsWithLock(
			ctx.runId,
			{
				tasks_completed: finalTasks.filter((t: Task) => t.status === "done").length,
				tasks_failed: finalTasks.filter((t: Task) => t.status === "failed").length,
			},
			ctx.workDir,
		);
	},

	formatSummary(results, ctx) {
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}
		displayPhaseSummaryHeader("exec", results, totalInput, totalOutput, ctx.config, ctx.startTime);

		const tasksCompleted = (ctx.store.tasksCompleted as number) ?? 0;
		const tasksFailed = (ctx.store.tasksFailed as number) ?? 0;
		const errors = (ctx.store.errors as string[]) ?? [];

		console.log("");
		console.log(`  ${pc.bold("Execution:")}`);
		console.log(`    Tasks completed: ${pc.green(String(tasksCompleted))}`);
		console.log(`    Tasks failed:    ${pc.red(String(tasksFailed))}`);

		if (errors.length > 0) {
			console.log("");
			logWarn("Errors encountered:");
			for (const err of errors) console.log(`    ${pc.red(err)}`);
		}

		const finalTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		const remainingPending = finalTasks.filter((t: Task) => t.status === "pending").length;
		const remainingMergeError = finalTasks.filter((t: Task) => t.status === "merge_error").length;

		if (remainingPending > 0 || remainingMergeError > 0) {
			console.log("");
			if (remainingPending > 0)
				logInfo(`Remaining pending tasks: ${pc.yellow(String(remainingPending))}`);
			if (remainingMergeError > 0)
				logWarn(`Tasks with merge errors: ${pc.yellow(String(remainingMergeError))}`);
		}

		console.log("");
		console.log(`  ${pc.dim("->")} Next: ${pc.cyan("milhouse --verify")}`);
		console.log(pc.dim("=".repeat(47)));
		console.log("");
	},

	nextPhase(_results, ctx): RunPhase {
		const finalTasks = loadTasksForRun(ctx.runId, ctx.workDir);
		const completedCount = finalTasks.filter((t: Task) => t.status === "done").length;
		const allDone = finalTasks.every((t: Task) => t.status === "done" || t.status === "skipped");

		// Always verify if ANY tasks completed — verify checks what was actually done.
		// Only signal 'failed' if zero tasks completed (nothing to verify).
		if (completedCount > 0 || allDone) return "verify";
		return "failed";
	},
};
