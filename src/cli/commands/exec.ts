import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { RuntimeOptions } from "../runtime-options.ts";
import { getConfigService } from "../../services/config/index.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngine, AIEngineName, AIResult } from "../../engines/types.ts";
import {
	type MergeBranchResult,
	runParallelByIssue,
} from "../../execution/issue-executor.ts";
import { runParallelWithGroupOrdering } from "../../execution/steps/parallel.ts";
import {
	createTaskBranch,
	getCurrentBranch,
	returnToBaseBranch,
} from "../../vcs/services/branch-service.ts";
import { createPullRequest } from "../../vcs/services/pr-service.ts";
import { createExecution, updateExecution } from "../../state/executions.ts";
import { buildFilterOptionsFromRuntime, filterIssues, loadIssues } from "../../state/issues.ts";
import {
	getMilhouseDir,
	initializeDir,
	updateProgress,
} from "../../state/manager.ts";
import {
	requireActiveRun,
	updateCurrentRunPhase,
	updateCurrentRunStats,
} from "../../state/runs.ts";
import { loadTasks, readTask, updateTask, updateTaskWithLock } from "../../state/tasks.ts";
import type { Issue } from "../../state/types.ts";
import { AGENT_ROLES, type Task } from "../../state/types.ts";
import {
	formatDuration,
	formatTokens,
	logDebug,
	logError,
	logInfo,
	logSuccess,
	logWarn,
	setVerbose,
} from "../../ui/logger.ts";
import { ProgressSpinner } from "../../ui/spinners.ts";

/**
 * Result of execution
 */
export interface ExecResult {
	success: boolean;
	tasksExecuted: number;
	tasksCompleted: number;
	tasksFailed: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}

/**
 * Build the Executor prompt for a task
 */
export function buildExecutorPrompt(task: Task, workDir: string): string {
	const parts: string[] = [];

	// Role definition
	parts.push(`## Role: Executor (EX)
${AGENT_ROLES.EX}

You are executing a specific task from the Execution Plan.
Your task is to implement the changes with minimal, focused modifications.`);

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

	// Add config info if available
	if (config) {
		if (config.commands.test) {
			parts.push(`Test command: ${config.commands.test}`);
		}
		if (config.commands.lint) {
			parts.push(`Lint command: ${config.commands.lint}`);
		}
		if (config.commands.build) {
			parts.push(`Build command: ${config.commands.build}`);
		}
	}

	// Task details
	parts.push(`## Task to Execute

**ID**: ${task.id}
**Title**: ${task.title}
**Status**: ${task.status}
${task.issue_id ? `**Issue**: ${task.issue_id}` : ""}
${task.description ? `**Description**: ${task.description}` : ""}`);

	// Files to modify
	if (task.files.length > 0) {
		parts.push(`### Files to Modify
${task.files.map((f) => `- \`${f}\``).join("\n")}`);
	}

	// Checks to run
	if (task.checks.length > 0) {
		parts.push(`### Verification Commands
Run these commands after making changes:
${task.checks.map((c) => `- \`${c}\``).join("\n")}`);
	}

	// Acceptance criteria
	if (task.acceptance.length > 0) {
		parts.push(`### Acceptance Criteria
${task.acceptance
	.map(
		(a) =>
			`- [ ] ${a.description}${a.check_command ? ` (verify with: \`${a.check_command}\`)` : ""}`,
	)
	.join("\n")}`);
	}

	// Risk and rollback
	if (task.risk) {
		parts.push(`### Risk Assessment
${task.risk}`);
	}

	if (task.rollback) {
		parts.push(`### Rollback Plan
${task.rollback}`);
	}

	// Execution instructions
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
 * Write a detailed report for a completed issue to progress.txt
 */
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

	// Ensure directory exists
	if (!existsSync(milDir)) {
		mkdirSync(milDir, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const separator = "=".repeat(60);
	const lines: string[] = [];

	lines.push("");
	lines.push(separator);
	lines.push(`[${timestamp}] ISSUE EXECUTION REPORT: ${issueId}`);
	lines.push(separator);

	// Issue details
	if (issue) {
		lines.push(`Symptom: ${issue.symptom}`);
		lines.push(`Hypothesis: ${issue.hypothesis}`);
		lines.push(`Severity: ${issue.severity}`);
		lines.push(`Status: ${issue.status}`);
		if (issue.corrected_description) {
			lines.push(`Corrected Description: ${issue.corrected_description}`);
		}
		// Show source file from first evidence entry if available
		const fileEvidence = issue.evidence.find((e) => e.type === "file" && e.file);
		if (fileEvidence?.file) {
			lines.push(
				`Source File: ${fileEvidence.file}${fileEvidence.line_start ? `:${fileEvidence.line_start}` : ""}`,
			);
		}
	}

	lines.push("");
	lines.push(`Result: ${issueResult.success ? "✅ SUCCESS" : "❌ FAILED"}`);
	lines.push(`Completed Tasks: ${issueResult.completedTasks.length}`);
	lines.push(`Failed Tasks: ${issueResult.failedTasks.length}`);

	// List completed tasks
	if (issueResult.completedTasks.length > 0) {
		lines.push("");
		lines.push("Completed Tasks:");
		for (const taskId of issueResult.completedTasks) {
			lines.push(`  ✓ ${taskId}`);
		}
	}

	// List failed tasks
	if (issueResult.failedTasks.length > 0) {
		lines.push("");
		lines.push("Failed Tasks:");
		for (const taskId of issueResult.failedTasks) {
			lines.push(`  ✗ ${taskId}`);
		}
	}

	// Error details
	if (issueResult.error) {
		lines.push("");
		lines.push(`Error: ${issueResult.error}`);
	}

	lines.push(separator);
	lines.push("");

	// Append to progress.txt
	appendFileSync(progressPath, lines.join("\n"));
}

/**
 * Execute a single task
 */
async function executeSingleTask(
	task: Task,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
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
					// Handle both DetailedStep and string
					if (step && typeof step === "object") {
						const detail = step.shortDetail ? ` ${step.shortDetail}` : "";
						spinner.updateStep(`${task.id}: ${step.category}${detail}`);
					} else if (step) {
						spinner.updateStep(`${task.id}: ${step}`);
					} else {
						spinner.updateStep(`${task.id}: Executing`);
					}
				},
				{ modelOverride: options.modelOverride },
			);
		} else {
			spinner.updateStep(`${task.id}: Executing`);
			result = await engine.execute(prompt, workDir, {
				modelOverride: options.modelOverride,
			});
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			inputTokens: 0,
			outputTokens: 0,
			error: errorMsg,
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

/**
 * Get tasks ready for execution (pending or merge_error with all deps satisfied)
 *
 * Tasks with "merge_error" status are included because they executed successfully
 * but failed during the merge phase, so they should be re-executed.
 */
export function getReadyTasks(workDir: string): Task[] {
	const tasks = loadTasks(workDir);
	const readyTasks: Task[] = [];

	for (const task of tasks) {
		// Include both "pending" and "merge_error" tasks
		// merge_error tasks need to be re-executed because their merge failed
		if (task.status !== "pending" && task.status !== "merge_error") {
			continue;
		}

		// Check if all dependencies are done
		const allDepsDone = task.depends_on.every((depId) => {
			const dep = tasks.find((t) => t.id === depId);
			return dep?.status === "done";
		});

		if (allDepsDone) {
			readyTasks.push(task);
		}
	}

	// Sort by parallel_group, then by id
	return readyTasks.sort((a, b) => {
		if (a.parallel_group !== b.parallel_group) {
			return a.parallel_group - b.parallel_group;
		}
		return a.id.localeCompare(b.id);
	});
}

/**
 * Run the exec command - Executor agent
 *
 * Executes tasks from tasks.json in dependency order.
 * Supports parallel execution and branch/PR modes.
 */
export async function runExec(options: RuntimeOptions): Promise<ExecResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Initialize milhouse directory if needed
	initializeDir(workDir);

	// Load current run state using new runs system
	let currentRun;
	try {
		currentRun = requireActiveRun(workDir);
	} catch (error) {
		logError("No active run found. Run the previous pipeline steps first.");
		return {
			success: false,
			tasksExecuted: 0,
			tasksCompleted: 0,
			tasksFailed: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: "No active run",
		};
	}

	// Load tasks
	const allTasks = loadTasks(workDir);
	// Include both "pending" and "merge_error" tasks
	// merge_error tasks need to be re-executed because their merge failed
	const pendingTasks = allTasks.filter((t) => t.status === "pending" || t.status === "merge_error");

	if (pendingTasks.length === 0) {
		logWarn("No pending or merge_error tasks found.");
		return {
			success: true,
			tasksExecuted: 0,
			tasksCompleted: 0,
			tasksFailed: 0,
			inputTokens: 0,
			outputTokens: 0,
		};
	}

	// Update phase to exec using new runs system
	currentRun = updateCurrentRunPhase("exec", workDir);

	// Check engine availability
	const engine = await createEngine(options.aiEngine as AIEngineName);
	let available = false;
	try {
		const plugin = getPlugin(options.aiEngine as AIEngineName);
		available = await plugin.isAvailable();
	} catch {
		available = false;
	}

	if (!available) {
		logError(`${engine.name} CLI not found. Make sure '${engine.cliCommand}' is in your PATH.`);
		return {
			success: false,
			tasksExecuted: 0,
			tasksCompleted: 0,
			tasksFailed: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: `${engine.name} not available`,
		};
	}

	logInfo(`Starting execution with ${engine.name}`);
	logInfo(`Role: ${AGENT_ROLES.EX}`);
	logInfo(`Pending tasks: ${pendingTasks.length}`);
	console.log("");

	// Create progress spinner
	const spinner = new ProgressSpinner("Executing tasks", ["EX"]);

	// Track results
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let tasksExecuted = 0;
	let tasksCompleted = 0;
	let tasksFailed = 0;
	const errors: string[] = [];

	// Determine execution mode
	// Default to exec-by-issue mode if not explicitly disabled
	const useExecByIssue = options.execByIssue !== false;
	const maxParallel = Math.min(options.maxParallel || 3, pendingTasks.length);
	const useParallel = options.parallel && maxParallel > 1;

	if (useParallel) {
		logInfo(`Running up to ${maxParallel} tasks in parallel`);
	}

	// Determine if we should use branches (for sequential mode)
	const useBranches = !!(options.branchPerTask && options.baseBranch);
	if (useBranches && !useParallel) {
		logInfo(`Creating branches based on: ${options.baseBranch}`);
	}

	// Execute specific task if taskId provided
	if (options.taskId) {
		const specificTask = readTask(options.taskId, workDir);
		if (!specificTask) {
			logError(`Task not found: ${options.taskId}`);
			return {
				success: false,
				tasksExecuted: 0,
				tasksCompleted: 0,
				tasksFailed: 0,
				inputTokens: 0,
				outputTokens: 0,
				error: `Task not found: ${options.taskId}`,
			};
		}

		if (specificTask.status !== "pending") {
			logWarn(`Task ${options.taskId} is not pending (status: ${specificTask.status})`);
			return {
				success: false,
				tasksExecuted: 0,
				tasksCompleted: 0,
				tasksFailed: 0,
				inputTokens: 0,
				outputTokens: 0,
				error: `Task not pending: ${options.taskId}`,
			};
		}

		// Execute single task
		const result = await executeTaskWithTracking(
			specificTask,
			engine,
			workDir,
			options,
			spinner,
			useBranches,
		);

		totalInputTokens += result.inputTokens;
		totalOutputTokens += result.outputTokens;
		tasksExecuted = 1;

		if (result.success) {
			tasksCompleted = 1;
		} else {
			tasksFailed = 1;
			if (result.error) {
				errors.push(`${specificTask.id}: ${result.error}`);
			}
		}
	} else if (useExecByIssue) {
		// Issue-based parallel execution (DEFAULT)
		// Each issue runs in its own worktree with all its tasks
		logInfo("Using issue-based parallel execution (default mode)");
		logInfo("Each issue's tasks will run in a dedicated worktree");

		// Load issues
		let issues = loadIssues(workDir);

		// If no issues found but tasks have issue_ids, derive synthetic issues from tasks
		// This handles the case where issues are in a different run than tasks
		if (issues.length === 0 && pendingTasks.some((t) => t.issue_id)) {
			logWarn("No issues found in current run, deriving from task issue_ids...");
			const issueIds = new Set(pendingTasks.map((t) => t.issue_id).filter(Boolean) as string[]);
			issues = Array.from(issueIds).map((id) => ({
				id,
				symptom: `Issue ${id} (derived from tasks)`,
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

		// Build filter options from CLI arguments
		const filterOptions = buildFilterOptionsFromRuntime(options, ["CONFIRMED", "PARTIAL"]);
		const validIssues = filterIssues(issues, filterOptions);

		// Log active filters
		if (options.issueIds?.length) {
			logInfo(`Filtering to specific issues: ${options.issueIds.join(", ")}`);
		}
		if (options.excludeIssueIds?.length) {
			logInfo(`Excluding issues: ${options.excludeIssueIds.join(", ")}`);
		}
		if (options.minSeverity) {
			logInfo(`Minimum severity: ${options.minSeverity}`);
		}
		if (options.severityFilter?.length) {
			logInfo(`Severity filter: ${options.severityFilter.join(", ")}`);
		}

		if (validIssues.length === 0) {
			logWarn("No validated issues found. Run 'milhouse validate' first.");
			return {
				success: false,
				tasksExecuted: 0,
				tasksCompleted: 0,
				tasksFailed: 0,
				inputTokens: 0,
				outputTokens: 0,
				error: "No validated issues",
			};
		}

		// Get current branch for base
		let currentBranch = options.baseBranch;
		if (!currentBranch) {
			const branchResult = await getCurrentBranch(workDir);
			if (!branchResult.ok) {
				logError(`Failed to get current branch: ${branchResult.error.message}`);
				return {
					success: false,
					tasksExecuted: 0,
					tasksCompleted: 0,
					tasksFailed: 0,
					inputTokens: 0,
					outputTokens: 0,
					error: `Failed to get current branch: ${branchResult.error.message}`,
				};
			}
			currentBranch = branchResult.value;
		}
		logInfo(`Base branch: ${currentBranch}`);
		logInfo(`Issues to process: ${validIssues.length}`);
		console.log("");

		// Run issue-based parallel execution
		const issueResult = await runParallelByIssue(pendingTasks, validIssues, {
			engine,
			workDir,
			baseBranch: currentBranch,
			maxConcurrent: maxParallel,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay, // Already in ms from args.ts
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			browserEnabled: options.browserEnabled,
			modelOverride: options.modelOverride,
			skipMerge: options.skipMerge,
			failFast: options.failFast,
			onIssueComplete: async (issueId, issueResult) => {
				// Update task statuses in state (using locked version for concurrent-safe updates)
				for (const taskId of issueResult.completedTasks) {
					await updateTaskWithLock(
						taskId,
						{
							status: "done",
							completed_at: new Date().toISOString(),
						},
						workDir,
					);

					createExecution(
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

				for (const taskId of issueResult.failedTasks) {
					await updateTaskWithLock(
						taskId,
						{
							status: "failed",
							error: issueResult.error,
						},
						workDir,
					);

					createExecution(
						{
							task_id: taskId,
							started_at: new Date().toISOString(),
							completed_at: new Date().toISOString(),
							agent_role: "EX",
							success: false,
							error: issueResult.error,
							input_tokens: 0,
							output_tokens: 0,
							follow_up_task_ids: [],
						},
						workDir,
					);
				}

				// Write detailed issue report to progress.txt
				const issue = validIssues.find((i) => i.id === issueId);
				writeIssueReport(issueId, issue, issueResult, workDir);

				logInfo(
					`Issue ${issueId}: ${issueResult.completedTasks.length} completed, ${issueResult.failedTasks.length} failed`,
				);
			},
			onMergeComplete: async (mergeResults: MergeBranchResult[]) => {
				// DEBUG: Log that callback was invoked
				logInfo(`onMergeComplete callback invoked with ${mergeResults.length} merge result(s)`);

				// Update task statuses for failed merges
				// Tasks that were marked as "done" but whose branch failed to merge
				// should be marked as "merge_error" so they can be re-executed
				const failedMerges = mergeResults.filter((r) => !r.success);

				if (failedMerges.length > 0) {
					logWarn(`Updating task status for ${failedMerges.length} failed merge(s)...`);

					// For each failed merge, find all tasks for that issue and mark them as merge_error
					for (const failedMerge of failedMerges) {
						const issueId = failedMerge.issueId;
						const tasksForIssue = loadTasks(workDir).filter(
							(t) => t.issue_id === issueId && t.status === "done",
						);

						for (const task of tasksForIssue) {
							await updateTaskWithLock(
								task.id,
								{
									status: "merge_error",
									error: `Merge failed: ${failedMerge.error || "Unknown error"}`,
									completed_at: undefined, // Clear completion timestamp
								},
								workDir,
							);

							logDebug(`Task ${task.id} status changed from "done" to "merge_error"`);
						}

						logWarn(
							`Issue ${issueId}: ${tasksForIssue.length} task(s) marked as merge_error due to failed branch merge`,
						);
					}
				}
			},
		});

		// Update counters from issue result
		tasksCompleted = issueResult.tasksCompleted;
		tasksFailed = issueResult.tasksFailed;
		tasksExecuted = issueResult.tasksCompleted + issueResult.tasksFailed;
		totalInputTokens = issueResult.totalInputTokens;
		totalOutputTokens = issueResult.totalOutputTokens;

		// Collect errors from failed tasks
		const reloadedTasks = loadTasks(workDir);
		for (const task of reloadedTasks) {
			if (task.status === "failed" && task.error) {
				errors.push(`${task.id}: ${task.error}`);
			}
		}
	} else if (useParallel) {
		// Parallel execution with worktree isolation (task-based)
		// Each task runs in its own git worktree
		logInfo("Using worktree-based parallel execution (task-based)");

		// Get current branch for base
		let currentBranch = options.baseBranch;
		if (!currentBranch) {
			const branchResult = await getCurrentBranch(workDir);
			if (!branchResult.ok) {
				logError(`Failed to get current branch: ${branchResult.error.message}`);
				return {
					success: false,
					tasksExecuted: 0,
					tasksCompleted: 0,
					tasksFailed: 0,
					inputTokens: 0,
					outputTokens: 0,
					error: `Failed to get current branch: ${branchResult.error.message}`,
				};
			}
			currentBranch = branchResult.value;
		}
		logInfo(`Base branch: ${currentBranch}`);

		// Run with parallel groups - groups execute sequentially, tasks within groups in parallel
		const parallelResult = await runParallelWithGroupOrdering(pendingTasks, {
			engine,
			workDir,
			baseBranch: currentBranch,
			maxConcurrent: maxParallel,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay, // Already in ms from args.ts
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			browserEnabled: options.browserEnabled,
			prdSource: "state", // Using milhouse state system
			prdFile: ".milhouse/tasks.json",
			modelOverride: options.modelOverride,
			skipMerge: options.skipMerge,
			failFast: options.failFast,
			onTaskComplete: async (taskId, success) => {
				// Update task status in state (using locked version for concurrent-safe updates)
				await updateTaskWithLock(
					taskId,
					{
						status: success ? "done" : "failed",
						completed_at: success ? new Date().toISOString() : undefined,
					},
					workDir,
				);

				// Add execution record
				createExecution(
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

		// Update counters from parallel result
		tasksCompleted = parallelResult.tasksCompleted;
		tasksFailed = parallelResult.tasksFailed;
		tasksExecuted = parallelResult.tasksCompleted + parallelResult.tasksFailed;
		totalInputTokens = parallelResult.totalInputTokens;
		totalOutputTokens = parallelResult.totalOutputTokens;

		// Collect errors from failed tasks
		const reloadedTasks = loadTasks(workDir);
		for (const task of reloadedTasks) {
			if (task.status === "failed" && task.error) {
				errors.push(`${task.id}: ${task.error}`);
			}
		}
	} else {
		// Sequential execution
		const maxIterations = options.maxIterations > 0 ? options.maxIterations : pendingTasks.length;
		let iteration = 0;

		while (iteration < maxIterations) {
			// Get next ready task
			const readyTasks = getReadyTasks(workDir);
			if (readyTasks.length === 0) {
				// Check if there are still pending tasks (blocked)
				const remaining = loadTasks(workDir).filter((t) => t.status === "pending");
				if (remaining.length > 0) {
					logWarn(`${remaining.length} tasks blocked due to failed dependencies`);
				}
				break;
			}

			const task = readyTasks[0];
			spinner.updateStep(`${task.id}: Starting`);

			const result = await executeTaskWithTracking(
				task,
				engine,
				workDir,
				options,
				spinner,
				useBranches,
			);

			totalInputTokens += result.inputTokens;
			totalOutputTokens += result.outputTokens;
			tasksExecuted++;
			iteration++;

			if (result.success) {
				tasksCompleted++;
			} else {
				tasksFailed++;
				if (result.error) {
					errors.push(`${task.id}: ${result.error}`);
				}
			}
		}
	}

	// Update run state using new runs system
	const finalTasks = loadTasks(workDir);
	const allDone = finalTasks.every((t) => t.status === "done" || t.status === "skipped");
	const anyFailed = finalTasks.some((t) => t.status === "failed");

	const nextPhase = allDone ? "verify" : anyFailed ? "failed" : "exec";
	currentRun = updateCurrentRunPhase(nextPhase, workDir);
	currentRun = updateCurrentRunStats({
		tasks_completed: finalTasks.filter((t) => t.status === "done").length,
		tasks_failed: finalTasks.filter((t) => t.status === "failed").length,
	}, workDir);

	const duration = Date.now() - startTime;

	if (errors.length > 0) {
		spinner.warn(`Execution completed with ${errors.length} error(s)`);
	} else if (tasksCompleted > 0) {
		spinner.success(`Execution complete ${formatTokens(totalInputTokens, totalOutputTokens)}`);
	} else {
		spinner.success("No tasks executed");
	}

	// Summary
	console.log("");
	console.log("=".repeat(50));
	logInfo("Execution Summary:");
	console.log(`  Tasks executed:  ${pc.cyan(String(tasksExecuted))}`);
	console.log(`  Tasks completed: ${pc.green(String(tasksCompleted))}`);
	console.log(`  Tasks failed:    ${pc.red(String(tasksFailed))}`);
	console.log(`  Duration:        ${formatDuration(duration)}`);
	console.log("=".repeat(50));

	if (errors.length > 0) {
		console.log("");
		logWarn("Errors encountered:");
		for (const err of errors) {
			console.log(`  - ${pc.red(err)}`);
		}
	}

	const finalTasksForSummary = loadTasks(workDir);
	const remainingPending = finalTasksForSummary.filter((t) => t.status === "pending");
	const remainingMergeError = finalTasksForSummary.filter((t) => t.status === "merge_error");
	const totalRemaining = remainingPending.length + remainingMergeError.length;

	if (totalRemaining > 0) {
		console.log("");
		if (remainingPending.length > 0) {
			logInfo(`Remaining pending tasks: ${pc.yellow(String(remainingPending.length))}`);
		}
		if (remainingMergeError.length > 0) {
			logWarn(`Tasks with merge errors: ${pc.yellow(String(remainingMergeError.length))}`);
		}
		logInfo(`Run ${pc.cyan("milhouse exec")} again to continue`);
	} else if (tasksCompleted > 0) {
		console.log("");
		logSuccess(`Run ${pc.cyan("milhouse verify")} to verify execution results`);
	}

	updateProgress(
		`Execution: ${tasksCompleted} completed, ${tasksFailed} failed, ${remainingPending.length} pending, ${remainingMergeError.length} merge_error`,
		workDir,
	);

	return {
		success: errors.length === 0,
		tasksExecuted,
		tasksCompleted,
		tasksFailed,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		error: errors.length > 0 ? errors.join("; ") : undefined,
	};
}

/**
 * Execute a task with full tracking (execution record, branch, PR)
 */
async function executeTaskWithTracking(
	task: Task,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
	spinner: ProgressSpinner,
	useBranches: boolean,
): Promise<{
	success: boolean;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}> {
	// Mark task as running
	updateTask(task.id, { status: "running" }, workDir);

	// Create execution record
	const executionRecord = createExecution(
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

	// Create branch if needed
	let branch: string | undefined;
	if (useBranches && options.baseBranch) {
		const branchResult = await createTaskBranch(task.title, options.baseBranch, workDir);
		if (branchResult.ok) {
			branch = branchResult.value.branchName;
			logDebug(`Created branch: ${branch}`);
			updateTask(task.id, { branch }, workDir);
		} else {
			logDebug(`Failed to create branch: ${branchResult.error.message}`);
		}
	}

	// Execute the task
	const result = await executeSingleTask(task, engine, workDir, options, spinner);

	// Update execution record
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

	// Update task status
	if (result.success) {
		updateTask(
			task.id,
			{
				status: "done",
				completed_at: new Date().toISOString(),
			},
			workDir,
		);

		// Create PR if requested
		if (options.createPr && branch && options.baseBranch) {
			const prResult = await createPullRequest(
				branch,
				options.baseBranch,
				`[${task.id}] ${task.title}`,
				`## Task\n\n${task.description || task.title}\n\n## Changes\n\nAutomated by Milhouse Executor (EX) agent.\n\n## Acceptance Criteria\n\n${task.acceptance.map((a) => `- [ ] ${a.description}`).join("\n") || "None specified"}`,
				{ draft: options.draftPr, workDir },
			);

			if (prResult.ok) {
				logSuccess(`PR created: ${prResult.value.url}`);
				updateExecution(executionRecord.id, { pr_url: prResult.value.url }, workDir);
			} else {
				logDebug(`Failed to create PR: ${prResult.error.message}`);
			}
		}
	} else {
		updateTask(
			task.id,
			{
				status: "failed",
				error: result.error,
			},
			workDir,
		);
	}

	// Return to base branch if we created one
	if (useBranches && options.baseBranch) {
		await returnToBaseBranch(options.baseBranch, workDir);
	}

	return result;
}
