import { loadIssues } from "../state/issues.ts";
import { initializeDir } from "../state/manager.ts";
import { getCurrentRun } from "../state/runs.ts";
import { loadTasks } from "../state/tasks.ts";
import {
	createPlanMetadataHeader,
	syncLegacyPlansView,
	writeExecutionPlan as writePlanStoreExecutionPlan,
} from "../state/plan-store.ts";
import { type Issue, type RunMeta, type RunState, type Task, type TaskStatus } from "../state/types.ts";

/**
 * Options for generating Execution Plan
 */
export interface ExecutionPlanOptions {
	/** Filter tasks by status (default: all) */
	statusFilter?: TaskStatus[];
	/** Filter tasks by issue ID (default: all) */
	issueFilter?: string[];
	/** Include task dependencies details (default: true) */
	includeDependencies?: boolean;
	/** Include acceptance criteria (default: true) */
	includeAcceptance?: boolean;
	/** Include risk and rollback info (default: true) */
	includeRiskInfo?: boolean;
	/** Custom title (default: "Execution Plan") */
	title?: string;
	/** Custom version suffix */
	version?: string;
}

/**
 * Result of Execution Plan generation
 */
export interface ExecutionPlanResult {
	/** Whether generation was successful */
	success: boolean;
	/** Path to the generated file */
	filePath?: string;
	/** Generated markdown content */
	content?: string;
	/** Number of tasks included */
	taskCount: number;
	/** Number of parallel groups */
	groupCount: number;
	/** Error message if generation failed */
	error?: string;
}

/**
 * Task counts by status
 */
interface TaskCountsByStatus {
	total: number;
	pending: number;
	blocked: number;
	running: number;
	done: number;
	failed: number;
	skipped: number;
}

/**
 * Count tasks by status
 */
function countTasksByStatus(tasks: Task[]): TaskCountsByStatus {
	return {
		total: tasks.length,
		pending: tasks.filter((t) => t.status === "pending").length,
		blocked: tasks.filter((t) => t.status === "blocked").length,
		running: tasks.filter((t) => t.status === "running").length,
		done: tasks.filter((t) => t.status === "done").length,
		failed: tasks.filter((t) => t.status === "failed").length,
		skipped: tasks.filter((t) => t.status === "skipped").length,
	};
}

/**
 * Get unique parallel groups sorted in order
 */
function getParallelGroups(tasks: Task[]): number[] {
	const groups = new Set<number>();
	for (const task of tasks) {
		groups.add(task.parallel_group);
	}
	return [...groups].sort((a, b) => a - b);
}

/**
 * Determine overall execution status
 */
function determineOverallStatus(tasks: Task[]): string {
	if (tasks.length === 0) {
		return "NO TASKS";
	}

	const counts = countTasksByStatus(tasks);

	if (counts.failed > 0) {
		return "FAILED";
	}

	if (counts.running > 0) {
		return "IN PROGRESS";
	}

	if (counts.done === counts.total) {
		return "COMPLETED";
	}

	if (counts.pending === counts.total) {
		return "READY";
	}

	if (counts.blocked > 0 && counts.pending === 0 && counts.running === 0) {
		return "BLOCKED";
	}

	return "PARTIALLY COMPLETE";
}

/**
 * Format status emoji for display
 */
function formatStatusEmoji(status: TaskStatus): string {
	const emojis: Record<TaskStatus, string> = {
		pending: "⏳",
		blocked: "🚫",
		running: "🔄",
		done: "✅",
		failed: "❌",
		skipped: "⏭️",
		merge_error: "🔀",
	};
	return emojis[status];
}

/**
 * Generate the markdown content for a single task
 */
function generateTaskMarkdown(task: Task, issues: Issue[], options: ExecutionPlanOptions): string {
	const parts: string[] = [];

	const statusEmoji = formatStatusEmoji(task.status);

	parts.push(`### ${statusEmoji} ${task.id}: ${task.title}

| Field | Value |
|-------|-------|
| **Status** | ${task.status.toUpperCase()} |
| **Parallel Group** | ${task.parallel_group} |`);

	if (task.issue_id) {
		const issue = issues.find((i) => i.id === task.issue_id);
		const truncatedSymptom = issue
			? issue.symptom.slice(0, 50) + (issue.symptom.length > 50 ? "..." : "")
			: "";
		const issueInfo = issue ? `${task.issue_id} (${truncatedSymptom})` : task.issue_id;
		parts.push(`| **Related Issue** | ${issueInfo} |`);
	}

	if (task.description) {
		parts.push(`| **Description** | ${task.description} |`);
	}

	if (task.files.length > 0) {
		parts.push(`| **Files** | ${task.files.map((f) => `\`${f}\``).join(", ")} |`);
	}

	if (task.branch) {
		parts.push(`| **Branch** | \`${task.branch}\` |`);
	}

	if (task.worktree) {
		parts.push(`| **Worktree** | \`${task.worktree}\` |`);
	}

	if (task.created_at) {
		parts.push(`| **Created** | ${task.created_at} |`);
	}

	if (task.completed_at) {
		parts.push(`| **Completed** | ${task.completed_at} |`);
	}

	if (task.error) {
		parts.push(`| **Error** | ${task.error} |`);
	}

	// Add dependencies if enabled
	if (options.includeDependencies !== false && task.depends_on.length > 0) {
		parts.push(`

**Dependencies:** ${task.depends_on.join(", ")}`);
	}

	// Add checks if present
	if (task.checks.length > 0) {
		parts.push(`

**Verification Commands:**

\`\`\`bash
${task.checks.join("\n")}
\`\`\``);
	}

	// Add acceptance criteria if enabled
	if (options.includeAcceptance !== false && task.acceptance.length > 0) {
		parts.push(`

**Acceptance Criteria:**

${task.acceptance
	.map((a) => {
		const checkMark = a.verified ? "✅" : "⬜";
		const cmd = a.check_command ? ` (\`${a.check_command}\`)` : "";
		return `- ${checkMark} ${a.description}${cmd}`;
	})
	.join("\n")}`);
	}

	// Add risk info if enabled
	if (options.includeRiskInfo !== false && (task.risk || task.rollback)) {
		if (task.risk) {
			parts.push(`

**Risk:** ${task.risk}`);
		}
		if (task.rollback) {
			parts.push(`

**Rollback:** ${task.rollback}`);
		}
	}

	parts.push("\n\n---\n");

	return parts.join("\n");
}

/**
 * Generate the full Execution Plan markdown document
 */
export function generateExecutionPlanMarkdown(
	tasks: Task[],
	issues: Issue[],
	runState: RunMeta | RunState | null,
	options: ExecutionPlanOptions = {},
	workDir = process.cwd(),
): string {
	const timestamp = new Date().toISOString();
	const title = options.title || "Execution Plan";
	const overallStatus = determineOverallStatus(tasks);
	const counts = countTasksByStatus(tasks);
	const parallelGroups = getParallelGroups(tasks);
	const version = options.version || "v1";

	const parts: string[] = [];

	// Add metadata header at the very top
	parts.push(createPlanMetadataHeader(workDir).trimEnd());

	// Get run ID from either RunMeta (id) or RunState (run_id)
	const runId = runState ? ("id" in runState ? runState.id : runState.run_id) : undefined;

	// Header
	parts.push(`# ${title} ${version}

> **Status**: ${overallStatus}
${runId ? `> **Run ID**: ${runId}` : ""}
> **Generated**: ${timestamp}
> **Total Tasks**: ${tasks.length}
> **Parallel Groups**: ${parallelGroups.length}

---

## Overview

This Execution Plan was generated by the Consolidator (CDM) agent after merging individual issue WBS plans.
${overallStatus === "READY" ? "All tasks are ready to execute. Run `milhouse exec` to begin execution." : ""}`);

	// Summary statistics
	parts.push(`

## Summary

### Task Status

| Status | Count |
|--------|-------|
| Pending | ${counts.pending} |
| Blocked | ${counts.blocked} |
| Running | ${counts.running} |
| Done | ${counts.done} |
| Failed | ${counts.failed} |
| Skipped | ${counts.skipped} |
| **Total** | **${counts.total}** |

### Parallel Groups

${
	parallelGroups.length > 0
		? `| Group | Tasks | Status |
|-------|-------|--------|
${parallelGroups
	.map((group) => {
		const groupTasks = tasks.filter((t) => t.parallel_group === group);
		const groupDone = groupTasks.every((t) => t.status === "done");
		const groupFailed = groupTasks.some((t) => t.status === "failed");
		const groupStatus = groupFailed ? "❌ Failed" : groupDone ? "✅ Complete" : "⏳ Pending";
		return `| ${group} | ${groupTasks.length} | ${groupStatus} |`;
	})
	.join("\n")}`
		: "*No parallel groups defined*"
}`);

	// Related issues summary
	const issueIds = [...new Set(tasks.filter((t) => t.issue_id).map((t) => t.issue_id))];
	if (issueIds.length > 0) {
		parts.push(`

### Related Issues

| Issue | Symptom | Tasks |
|-------|---------|-------|
${issueIds
	.map((id) => {
		const issue = issues.find((i) => i.id === id);
		const taskCount = tasks.filter((t) => t.issue_id === id).length;
		const symptom = issue
			? issue.symptom.slice(0, 50) + (issue.symptom.length > 50 ? "..." : "")
			: "Unknown";
		return `| ${id} | ${symptom} | ${taskCount} |`;
	})
	.join("\n")}`);
	}

	parts.push(`

---

## Tasks
`);

	// Task details grouped by parallel group
	if (tasks.length === 0) {
		parts.push("No tasks have been planned yet.\n");
	} else {
		for (const group of parallelGroups) {
			const groupTasks = tasks.filter((t) => t.parallel_group === group);
			const groupDone = groupTasks.every((t) => t.status === "done");
			const groupFailed = groupTasks.some((t) => t.status === "failed");
			const groupStatus = groupFailed ? "❌" : groupDone ? "✅" : "⏳";

			parts.push(`
## ${groupStatus} Parallel Group ${group} (${groupTasks.length} tasks)

> Tasks in this group can be executed in parallel once their dependencies are satisfied.
`);

			for (const task of groupTasks) {
				parts.push(generateTaskMarkdown(task, issues, options));
			}
		}
	}

	// Dependency graph (simplified)
	const tasksWithDeps = tasks.filter((t) => t.depends_on.length > 0);
	if (tasksWithDeps.length > 0) {
		parts.push(`## Dependency Graph

\`\`\`
${tasksWithDeps.map((t) => `${t.id} <- ${t.depends_on.join(", ")}`).join("\n")}
\`\`\`
`);
	}

	// Next steps
	parts.push(`## Next Steps
`);

	if (overallStatus === "NO TASKS") {
		parts.push(`No tasks to execute. Run \`milhouse plan\` to generate task plans from validated issues.
`);
	} else if (overallStatus === "READY") {
		parts.push(`1. Run \`milhouse exec\` to execute tasks
2. Run \`milhouse verify\` after execution to check for regressions
3. Run \`milhouse export --format md,json\` to export results
`);
	} else if (overallStatus === "IN PROGRESS") {
		parts.push(`Execution is in progress. Monitor with \`milhouse tasks list\`.

- Completed: ${counts.done}/${counts.total}
- Running: ${counts.running}
- Remaining: ${counts.pending + counts.blocked}
`);
	} else if (overallStatus === "FAILED") {
		parts.push(`Some tasks have failed. Review the errors above and:

1. Fix the underlying issues
2. Run \`milhouse exec --retry\` to retry failed tasks
3. Or run \`milhouse tasks run --id <task-id>\` to retry specific tasks
`);
	} else if (overallStatus === "BLOCKED") {
		parts.push(`All remaining tasks are blocked. This usually happens when:

1. A required task has failed
2. There are circular dependencies
3. Dependencies reference non-existent tasks

Run \`milhouse verify\` to diagnose blocking issues.
`);
	} else if (overallStatus === "COMPLETED") {
		parts.push(`All tasks have been completed successfully!

1. Run \`milhouse verify\` to ensure all gates pass
2. Run \`milhouse export --format md,json\` to export final results
3. Create a PR with \`milhouse export --format pr\`
`);
	} else {
		parts.push(`Continue execution with \`milhouse exec\`.

- Completed: ${counts.done}/${counts.total}
- Pending: ${counts.pending}
- Blocked: ${counts.blocked}
`);
	}

	parts.push(`
---

*Generated by Milhouse CLI*
`);

	return parts.join("\n");
}

/**
 * Generate Execution Plan from tasks and save to file (legacy function)
 */
export function generateExecutionPlan(
	tasks: Task[],
	issues: Issue[],
	runId: string,
	options: ExecutionPlanOptions = {},
): string {
	// Create a mock run state for backward compatibility
	const mockRunState: RunState = {
		run_id: runId,
		started_at: new Date().toISOString(),
		phase: "consolidating",
		issues_found: issues.length,
		issues_validated: issues.filter((i) => i.status !== "UNVALIDATED").length,
		tasks_total: tasks.length,
		tasks_completed: tasks.filter((t) => t.status === "done").length,
		tasks_failed: tasks.filter((t) => t.status === "failed").length,
	};

	return generateExecutionPlanMarkdown(tasks, issues, mockRunState, options);
}

/**
 * Generate and save Execution Plan to the plans directory
 */
export function saveExecutionPlan(
	workDir: string,
	options: ExecutionPlanOptions = {},
): ExecutionPlanResult {
	// Ensure directory structure exists
	initializeDir(workDir);

	// Load tasks
	let tasks = loadTasks(workDir);

	// Apply status filter if provided
	if (options.statusFilter && options.statusFilter.length > 0) {
		tasks = tasks.filter((t) => options.statusFilter?.includes(t.status));
	}

	// Apply issue filter if provided
	if (options.issueFilter && options.issueFilter.length > 0) {
		tasks = tasks.filter((t) => t.issue_id && options.issueFilter?.includes(t.issue_id));
	}

	// Load issues for context
	const issues = loadIssues(workDir);

	// Load run state
	const runState = getCurrentRun(workDir);

	// Generate markdown
	const content = generateExecutionPlanMarkdown(tasks, issues, runState, options, workDir);

	// Calculate parallel groups
	const parallelGroups = getParallelGroups(tasks);

	// Write file using PlanStore
	try {
		const filePath = writePlanStoreExecutionPlan(workDir, content);

		// Sync legacy plans view
		syncLegacyPlansView(workDir);

		return {
			success: true,
			filePath,
			content,
			taskCount: tasks.length,
			groupCount: parallelGroups.length,
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);

		return {
			success: false,
			taskCount: tasks.length,
			groupCount: parallelGroups.length,
			error: `Failed to write Execution Plan: ${errorMsg}`,
		};
	}
}

/**
 * Regenerate Execution Plan from current state
 *
 * This is useful after task execution to update the document
 * with current statuses.
 */
export function regenerateExecutionPlan(
	workDir: string,
	options: ExecutionPlanOptions = {},
): ExecutionPlanResult {
	// Load current tasks to determine status
	const tasks = loadTasks(workDir);
	const counts = countTasksByStatus(tasks);

	// Set appropriate version based on completion state
	let version = options.version;
	if (!version) {
		if (counts.done === counts.total && counts.total > 0) {
			version = "v-final";
		} else if (counts.done > 0) {
			version = `v-progress-${counts.done}-of-${counts.total}`;
		} else {
			version = "v1";
		}
	}

	const updatedOptions: ExecutionPlanOptions = {
		...options,
		version,
		title: options.title || "Execution Plan",
	};

	return saveExecutionPlan(workDir, updatedOptions);
}
