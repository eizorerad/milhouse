import pc from "picocolors";
import type { RuntimeOptions } from "../runtime-options.ts";
import { getConfigService } from "../../services/config/index.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName, AIResult } from "../../engines/types.ts";
import { saveGraph } from "../../state/graph.ts";
import { loadIssues } from "../../state/issues.ts";
import { initializeDir } from "../../state/manager.ts";
import {
	requireActiveRun,
	updateCurrentRunPhase,
	updateCurrentRunStats,
} from "../../state/runs.ts";
import { loadTasks, saveTasks } from "../../state/tasks.ts";
import {
	getCurrentPlansDir,
	syncLegacyPlansView,
	writeExecutionPlan,
} from "../../state/plan-store.ts";
import { AGENT_ROLES, type GraphNode, type Issue, type Task } from "../../state/types.ts";
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
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";

/**
 * Result of consolidation
 */
interface ConsolidateResult {
	success: boolean;
	tasksConsolidated: number;
	parallelGroups: number;
	duplicatesRemoved: number;
	inputTokens: number;
	outputTokens: number;
	executionPlanPath: string;
	error?: string;
}

/**
 * Parsed consolidation response from AI
 */
interface ParsedConsolidation {
	duplicates: Array<{
		keep: string;
		remove: string[];
		reason: string;
	}>;
	cross_dependencies: Array<{
		task_id: string;
		depends_on: string[];
		reason: string;
	}>;
	parallel_groups: Array<{
		group: number;
		task_ids: string[];
	}>;
	execution_order: string[];
}

/**
 * Build the Consolidator prompt
 */
function buildConsolidatorPrompt(tasks: Task[], issues: Issue[], workDir: string): string {
	const parts: string[] = [];

	// Role definition
	parts.push(`## Role: Consistency & Dependency Manager (CDM)
${AGENT_ROLES.CDM}

You are consolidating multiple Work Breakdown Structures into a unified Execution Plan.
Your task is to:
1. Identify and merge duplicate or overlapping tasks
2. Establish cross-issue dependencies
3. Optimize parallel execution groups
4. Provide a coherent execution order`);

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

	// Issues summary
	parts.push(`## Issues (${issues.length})

${issues
	.map(
		(i) => `- **${i.id}** [${i.status}]: ${i.symptom}
  - Severity: ${i.severity}
  - Tasks: ${i.related_task_ids.length > 0 ? i.related_task_ids.join(", ") : "None"}`,
	)
	.join("\n\n")}`);

	// Tasks to consolidate
	parts.push(`## Tasks to Consolidate (${tasks.length})

${tasks
	.map(
		(t) => `### ${t.id}: ${t.title}
- **Issue**: ${t.issue_id || "None"}
- **Status**: ${t.status}
- **Files**: ${t.files.length > 0 ? t.files.join(", ") : "None specified"}
- **Dependencies**: ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "None"}
- **Parallel Group**: ${t.parallel_group}
- **Description**: ${t.description || "No description"}`,
	)
	.join("\n\n")}`);

	// Consolidation instructions
	parts.push(`## Task

Analyze the tasks and provide consolidation recommendations:

1. **Duplicates**: Find tasks that do the same thing or modify the same files
2. **Cross-Dependencies**: Identify dependencies between tasks from different issues
3. **Parallel Groups**: Optimize which tasks can run in parallel
4. **Execution Order**: Provide the optimal execution order respecting dependencies

## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "duplicates": [
    {
      "keep": "TASK_ID to keep",
      "remove": ["TASK_IDs to remove"],
      "reason": "Why these are duplicates"
    }
  ],
  "cross_dependencies": [
    {
      "task_id": "TASK_ID",
      "depends_on": ["OTHER_TASK_IDs from different issues"],
      "reason": "Why this dependency exists"
    }
  ],
  "parallel_groups": [
    {
      "group": 0,
      "task_ids": ["IDs of tasks that can run in parallel"]
    }
  ],
  "execution_order": ["Ordered list of task IDs for execution"]
}
\`\`\`

## Guidelines

- **Duplicates**: Tasks touching the same files with similar goals should be merged
- **Cross-Dependencies**: Consider file conflicts and logical ordering
- **Parallel Groups**: Tasks with no conflicts can run in parallel
- **Execution Order**: Must respect all dependencies
- Be conservative - only merge tasks that are truly duplicates
- Consider the full blast radius when recommending changes`);

	return parts.join("\n\n");
}

/**
 * Parse consolidation response from AI
 */
function parseConsolidationResponse(response: string): ParsedConsolidation | null {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		logDebug("Failed to extract JSON from consolidation response");
		return null;
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (!isValidConsolidation(parsed)) {
			logWarn("Invalid consolidation response structure");
			return null;
		}

		return parsed;
	} catch (error) {
		logDebug("Failed to parse JSON consolidation response:", error);

		// Try to find JSON object in the response
		const objectMatch = response.match(
			/\{\s*"duplicates"[\s\S]*?"execution_order"\s*:\s*\[[\s\S]*?\]\s*\}/,
		);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidConsolidation(parsed)) {
					return parsed;
				}
			} catch {
				// Fall through
			}
		}

		return null;
	}
}

/**
 * Validate parsed consolidation response
 */
function isValidConsolidation(data: unknown): data is ParsedConsolidation {
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const obj = data as Record<string, unknown>;

	if (!Array.isArray(obj.duplicates)) {
		return false;
	}

	if (!Array.isArray(obj.cross_dependencies)) {
		return false;
	}

	if (!Array.isArray(obj.parallel_groups)) {
		return false;
	}

	if (!Array.isArray(obj.execution_order)) {
		return false;
	}

	return true;
}

/**
 * Perform topological sort on tasks based on dependencies
 */
export function topologicalSort(tasks: Task[]): Task[] {
	const taskMap = new Map<string, Task>();
	for (const task of tasks) {
		taskMap.set(task.id, task);
	}

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const sorted: Task[] = [];

	function visit(taskId: string): boolean {
		if (visited.has(taskId)) {
			return true;
		}

		if (visiting.has(taskId)) {
			// Circular dependency detected
			logWarn(`Circular dependency detected involving task: ${taskId}`);
			return false;
		}

		visiting.add(taskId);

		const task = taskMap.get(taskId);
		if (!task) {
			return true;
		}

		for (const depId of task.depends_on) {
			if (!visit(depId)) {
				return false;
			}
		}

		visiting.delete(taskId);
		visited.add(taskId);
		sorted.push(task);

		return true;
	}

	for (const task of tasks) {
		if (!visited.has(task.id)) {
			visit(task.id);
		}
	}

	return sorted;
}

/**
 * Build dependency graph from tasks
 */
export function buildDependencyGraph(tasks: Task[]): GraphNode[] {
	return tasks.map((t) => ({
		id: t.id,
		depends_on: [...t.depends_on],
		parallel_group: t.parallel_group,
	}));
}

/**
 * Assign parallel groups based on dependencies
 */
export function assignParallelGroups(tasks: Task[]): Task[] {
	const taskMap = new Map<string, Task>();
	const groupMap = new Map<string, number>();

	for (const task of tasks) {
		taskMap.set(task.id, task);
		groupMap.set(task.id, 0);
	}

	// Calculate group for each task based on max dependency group + 1
	let changed = true;
	let iterations = 0;
	const maxIterations = tasks.length;

	while (changed && iterations < maxIterations) {
		changed = false;
		iterations++;

		for (const task of tasks) {
			if (task.depends_on.length === 0) {
				continue;
			}

			const maxDepGroup = Math.max(...task.depends_on.map((depId) => groupMap.get(depId) ?? 0));

			const newGroup = maxDepGroup + 1;
			const currentGroup = groupMap.get(task.id) ?? 0;

			if (newGroup > currentGroup) {
				groupMap.set(task.id, newGroup);
				changed = true;
			}
		}
	}

	return tasks.map((t) => ({
		...t,
		parallel_group: groupMap.get(t.id) ?? t.parallel_group,
	}));
}

/**
 * Generate Execution Plan markdown
 */
function generateExecutionPlanMarkdown(
	tasks: Task[],
	issues: Issue[],
	duplicatesRemoved: number,
	parallelGroups: number,
): string {
	const timestamp = new Date().toISOString();
	const parts: string[] = [];

	// Group tasks by parallel_group
	const groupedTasks = new Map<number, Task[]>();
	for (const task of tasks) {
		const group = task.parallel_group;
		if (!groupedTasks.has(group)) {
			groupedTasks.set(group, []);
		}
		groupedTasks.get(group)?.push(task);
	}

	const sortedGroups = [...groupedTasks.keys()].sort((a, b) => a - b);

	parts.push(`# Execution Plan

> **Generated**: ${timestamp}
> **Total Tasks**: ${tasks.length}
> **Parallel Groups**: ${parallelGroups}
> **Duplicates Removed**: ${duplicatesRemoved}
> **Issues**: ${issues.filter((i) => i.status === "CONFIRMED" || i.status === "PARTIAL").length}

---

## Summary

This execution plan consolidates Work Breakdown Structures from ${issues.length} issues
into ${parallelGroups} parallel execution groups.

---

## Issues Overview

| ID | Status | Severity | Tasks |
|----|--------|----------|-------|
${issues
	.filter((i) => i.status === "CONFIRMED" || i.status === "PARTIAL")
	.map((i) => `| ${i.id} | ${i.status} | ${i.severity} | ${i.related_task_ids.length} |`)
	.join("\n")}

---

## Execution Groups
`);

	for (const group of sortedGroups) {
		const groupTasks = groupedTasks.get(group) || [];
		parts.push(`### Group ${group} (${groupTasks.length} tasks)

${group === 0 ? "**Can start immediately**" : `**Depends on**: Groups 0-${group - 1} completing`}

| Task | Issue | Status | Dependencies |
|------|-------|--------|--------------|
${groupTasks
	.map(
		(t) =>
			`| ${t.id} | ${t.issue_id || "-"} | ${t.status} | ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "-"} |`,
	)
	.join("\n")}
`);
	}

	// Detailed task list
	parts.push(`---

## Task Details
`);

	for (const group of sortedGroups) {
		const groupTasks = groupedTasks.get(group) || [];

		for (const task of groupTasks) {
			parts.push(`### ${task.id}: ${task.title}

| Field | Value |
|-------|-------|
| **Issue** | ${task.issue_id || "N/A"} |
| **Parallel Group** | ${task.parallel_group} |
| **Status** | ${task.status} |
| **Dependencies** | ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "None"} |
| **Files** | ${task.files.length > 0 ? task.files.map((f) => `\`${f}\``).join(", ") : "None"} |
| **Risk** | ${task.risk || "Not assessed"} |
| **Rollback** | ${task.rollback || "Revert commit"} |

${task.description || "No description provided."}

#### Checks
${task.checks.length > 0 ? task.checks.map((c) => `- \`${c}\``).join("\n") : "- No checks specified"}

#### Acceptance Criteria
${task.acceptance.length > 0 ? task.acceptance.map((a) => `- [ ] ${a.description}${a.check_command ? ` (\`${a.check_command}\`)` : ""}`).join("\n") : "- No acceptance criteria specified"}

---
`);
		}
	}

	parts.push(`## Next Steps

1. Review this execution plan for completeness
2. Run \`milhouse exec\` to start executing tasks
3. Use \`milhouse verify\` after execution to verify results

## Execution Commands

\`\`\`bash
# Execute all tasks sequentially
milhouse exec

# Execute with parallel mode
milhouse exec --parallel

# Execute specific task
milhouse tasks run --id <TASK_ID>
\`\`\`
`);

	return parts.join("\n");
}

/**
 * Apply consolidation changes to tasks
 */
function applyConsolidation(
	tasks: Task[],
	consolidation: ParsedConsolidation,
	workDir: string,
): { tasks: Task[]; duplicatesRemoved: number } {
	let updatedTasks = [...tasks];
	let duplicatesRemoved = 0;

	// Remove duplicate tasks
	for (const dup of consolidation.duplicates) {
		logDebug(`Removing duplicates: ${dup.remove.join(", ")} -> ${dup.keep}`);
		updatedTasks = updatedTasks.filter((t) => !dup.remove.includes(t.id));
		duplicatesRemoved += dup.remove.length;

		// Update any dependencies pointing to removed tasks
		updatedTasks = updatedTasks.map((t) => ({
			...t,
			depends_on: t.depends_on.map((dep) => (dup.remove.includes(dep) ? dup.keep : dep)),
		}));
	}

	// Add cross-issue dependencies
	for (const crossDep of consolidation.cross_dependencies) {
		const taskIndex = updatedTasks.findIndex((t) => t.id === crossDep.task_id);
		if (taskIndex !== -1) {
			const task = updatedTasks[taskIndex];
			const newDeps = [...new Set([...task.depends_on, ...crossDep.depends_on])];
			logDebug(
				`Adding cross-dependencies to ${crossDep.task_id}: ${crossDep.depends_on.join(", ")}`,
			);
			updatedTasks = [
				...updatedTasks.slice(0, taskIndex),
				{ ...task, depends_on: newDeps },
				...updatedTasks.slice(taskIndex + 1),
			];
		}
	}

	// Update parallel groups
	for (const pg of consolidation.parallel_groups) {
		for (const taskId of pg.task_ids) {
			const taskIndex = updatedTasks.findIndex((t) => t.id === taskId);
			if (taskIndex !== -1) {
				const task = updatedTasks[taskIndex];
				updatedTasks = [
					...updatedTasks.slice(0, taskIndex),
					{ ...task, parallel_group: pg.group },
					...updatedTasks.slice(taskIndex + 1),
				];
			}
		}
	}

	return { tasks: updatedTasks, duplicatesRemoved };
}

/**
 * Run the consolidate command - CDM agent
 *
 * Merges WBS plans into a unified Execution Plan with dependencies.
 */
export async function runConsolidate(options: RuntimeOptions): Promise<ConsolidateResult> {
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
		logError(
			"No active run found. Run 'milhouse scan', 'milhouse validate', and 'milhouse plan' first.",
		);
		return {
			success: false,
			tasksConsolidated: 0,
			parallelGroups: 0,
			duplicatesRemoved: 0,
			inputTokens: 0,
			outputTokens: 0,
			executionPlanPath: "",
			error: "No active run",
		};
	}

	// Load tasks
	let tasks = loadTasks(workDir);
	const pendingTasks = tasks.filter((t) => t.status === "pending");

	if (pendingTasks.length === 0) {
		logWarn("No pending tasks found. Run 'milhouse plan' first to generate tasks.");
		return {
			success: true,
			tasksConsolidated: 0,
			parallelGroups: 0,
			duplicatesRemoved: 0,
			inputTokens: 0,
			outputTokens: 0,
			executionPlanPath: "",
		};
	}

	// Load issues
	const issues = loadIssues(workDir);

	// Update phase to consolidate using new runs system
	currentRun = updateCurrentRunPhase("consolidate", workDir);

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
			tasksConsolidated: 0,
			parallelGroups: 0,
			duplicatesRemoved: 0,
			inputTokens: 0,
			outputTokens: 0,
			executionPlanPath: "",
			error: `${engine.name} not available`,
		};
	}

	logInfo(`Starting consolidation with ${engine.name}`);
	logInfo(`Role: ${AGENT_ROLES.CDM}`);
	logInfo(`Tasks to consolidate: ${pendingTasks.length}`);
	console.log("");

	// Create progress spinner
	const spinner = new ProgressSpinner("Consolidating tasks", ["CDM"]);

	// Track results
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let duplicatesRemoved = 0;

	// Build consolidation prompt
	const prompt = buildConsolidatorPrompt(pendingTasks, issues, workDir);
	logDebug(`Consolidating ${pendingTasks.length} tasks from ${issues.length} issues`);

	// Execute AI engine
	let result: AIResult;
	try {
		if (engine.executeStreaming) {
			result = await engine.executeStreaming(
				prompt,
				workDir,
				(step) => {
					spinner.updateStep(`CDM: ${step || "Analyzing"}`);
				},
				{ modelOverride: options.modelOverride },
			);
		} else {
			spinner.updateStep("CDM: Executing");
			result = await engine.execute(prompt, workDir, {
				modelOverride: options.modelOverride,
			});
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		spinner.fail(`Consolidation failed: ${errorMsg}`);
		return {
			success: false,
			tasksConsolidated: 0,
			parallelGroups: 0,
			duplicatesRemoved: 0,
			inputTokens: 0,
			outputTokens: 0,
			executionPlanPath: "",
			error: errorMsg,
		};
	}

	totalInputTokens = result.inputTokens;
	totalOutputTokens = result.outputTokens;

	if (!result.success) {
		spinner.fail(`Consolidation failed: ${result.error || "Unknown error"}`);
		return {
			success: false,
			tasksConsolidated: 0,
			parallelGroups: 0,
			duplicatesRemoved: 0,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			executionPlanPath: "",
			error: result.error || "Unknown error",
		};
	}

	// Parse consolidation response
	const consolidation = parseConsolidationResponse(result.response);

	if (consolidation) {
		// Apply consolidation changes
		const consolidated = applyConsolidation(tasks, consolidation, workDir);
		tasks = consolidated.tasks;
		duplicatesRemoved = consolidated.duplicatesRemoved;
	} else {
		logWarn("Could not parse AI consolidation response, using default grouping");
	}

	// Assign parallel groups based on dependencies
	tasks = assignParallelGroups(tasks);

	// Perform topological sort
	const sortedTasks = topologicalSort(tasks.filter((t) => t.status === "pending"));

	// Calculate parallel groups
	const parallelGroups = new Set(sortedTasks.map((t) => t.parallel_group)).size;

	// Save updated tasks
	const allTasks = [...tasks.filter((t) => t.status !== "pending"), ...sortedTasks];
	saveTasks(allTasks, workDir);

	// Build and save dependency graph
	const graph = buildDependencyGraph(sortedTasks);
	saveGraph(graph, workDir);

	// Generate execution plan markdown using PlanStore
	const markdown = generateExecutionPlanMarkdown(
		sortedTasks,
		issues,
		duplicatesRemoved,
		parallelGroups,
	);
	const executionPlanPath = writeExecutionPlan(workDir, markdown);
	logDebug(`Wrote execution plan to ${executionPlanPath}`);

	// Sync legacy plans view after writing
	syncLegacyPlansView(workDir);
	logDebug("Synced legacy plans view");

	// Update run state using new runs system
	currentRun = updateCurrentRunPhase("exec", workDir);
	currentRun = updateCurrentRunStats({ tasks_total: sortedTasks.length }, workDir);

	const duration = Date.now() - startTime;

	spinner.success(`Consolidation complete ${formatTokens(totalInputTokens, totalOutputTokens)}`);

	// Summary
	console.log("");
	console.log("=".repeat(50));
	logInfo("Consolidation Summary:");
	console.log(`  Tasks consolidated: ${pc.cyan(String(sortedTasks.length))}`);
	console.log(`  Parallel groups:    ${pc.green(String(parallelGroups))}`);
	console.log(`  Duplicates removed: ${pc.yellow(String(duplicatesRemoved))}`);
	console.log(`  Duration:           ${formatDuration(duration)}`);
	console.log("=".repeat(50));

	console.log("");
	logInfo("Execution Plan:");
	console.log(`  ${pc.cyan(executionPlanPath)}`);

	console.log("");
	logSuccess(`Run ${pc.cyan("milhouse exec")} to start executing tasks`);

	return {
		success: true,
		tasksConsolidated: sortedTasks.length,
		parallelGroups,
		duplicatesRemoved,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		executionPlanPath,
	};
}
