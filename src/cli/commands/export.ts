import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";
import type { RuntimeOptions } from "../runtime-options.ts";
import { loadExecutions } from "../../state/executions.ts";
import { loadGraph } from "../../state/graph.ts";
import { loadIssues } from "../../state/issues.ts";
import {
	getMilhouseDir,
	initializeDir,
	updateProgress,
} from "../../state/manager.ts";
import { getCurrentRun } from "../../state/runs.ts";
import { loadTasks } from "../../state/tasks.ts";
import { getCurrentPlansDir, planFileExists } from "../../state/plan-store.ts";
import {
	type ExecutionRecord,
	type GraphNode,
	type Issue,
	type RunMeta,
	type RunState,
	type Task,
} from "../../state/types.ts";
import {
	formatDuration,
	logDebug,
	logError,
	logInfo,
	logSuccess,
	logWarn,
	setVerbose,
} from "../../ui/logger.ts";

/**
 * Supported export formats
 */
export type ExportFormat = "md" | "json";

/**
 * Export options
 */
export interface ExportOptions {
	formats: ExportFormat[];
	outputDir?: string;
}

/**
 * Result of export operation
 */
export interface ExportResult {
	success: boolean;
	filesCreated: string[];
	error?: string;
}

/**
 * Full export data structure
 */
export interface ExportData {
	runState: RunMeta | RunState | null;
	issues: Issue[];
	tasks: Task[];
	graph: GraphNode[];
	executions: ExecutionRecord[];
	exportedAt: string;
}

/**
 * Parse format string into array of formats
 */
export function parseFormats(formatStr: string): ExportFormat[] {
	const formats: ExportFormat[] = [];
	const parts = formatStr.split(",").map((s) => s.trim().toLowerCase());

	for (const part of parts) {
		if (part === "md" || part === "markdown") {
			formats.push("md");
		} else if (part === "json") {
			formats.push("json");
		}
	}

	// Default to both if empty
	if (formats.length === 0) {
		return ["md", "json"];
	}

	return [...new Set(formats)];
}

/**
 * Load all exportable data
 */
export function loadExportData(workDir: string): ExportData {
	return {
		runState: getCurrentRun(workDir),
		issues: loadIssues(workDir),
		tasks: loadTasks(workDir),
		graph: loadGraph(workDir),
		executions: loadExecutions(workDir),
		exportedAt: new Date().toISOString(),
	};
}

/**
 * Helper to get run ID from either RunMeta or RunState
 */
function getRunId(runState: RunMeta | RunState | null): string | undefined {
	if (!runState) return undefined;
	return "id" in runState ? runState.id : runState.run_id;
}

/**
 * Generate JSON export
 */
export function generateJsonExport(data: ExportData): string {
	return JSON.stringify(data, null, 2);
}

/**
 * Generate markdown summary export
 */
export function generateMarkdownExport(data: ExportData, workDir: string): string {
	const parts: string[] = [];

	const timestamp = new Date().toISOString();
	const runId = getRunId(data.runState);

	parts.push(`# Milhouse Export Report

> **Exported**: ${timestamp}
${runId ? `> **Run ID**: ${runId}` : ""}
${data.runState ? `> **Phase**: ${data.runState.phase}` : ""}

---

## Summary

| Metric | Value |
|--------|-------|
| Issues Found | ${data.issues.length} |
| Issues Validated | ${data.issues.filter((i) => i.status !== "UNVALIDATED").length} |
| Tasks Total | ${data.tasks.length} |
| Tasks Completed | ${data.tasks.filter((t) => t.status === "done").length} |
| Tasks Failed | ${data.tasks.filter((t) => t.status === "failed").length} |
| Tasks Pending | ${data.tasks.filter((t) => t.status === "pending").length} |
| Executions | ${data.executions.length} |
`);

	// Issues section
	if (data.issues.length > 0) {
		parts.push(`---

## Issues

`);
		const issuesByStatus = {
			CONFIRMED: data.issues.filter((i) => i.status === "CONFIRMED"),
			UNVALIDATED: data.issues.filter((i) => i.status === "UNVALIDATED"),
			PARTIAL: data.issues.filter((i) => i.status === "PARTIAL"),
			FALSE: data.issues.filter((i) => i.status === "FALSE"),
			MISDIAGNOSED: data.issues.filter((i) => i.status === "MISDIAGNOSED"),
		};

		for (const [status, issues] of Object.entries(issuesByStatus)) {
			if (issues.length > 0) {
				parts.push(`### ${status} (${issues.length})

`);
				for (const issue of issues) {
					parts.push(`#### ${issue.id}: ${issue.symptom}

| Field | Value |
|-------|-------|
| **Severity** | ${issue.severity} |
| **Hypothesis** | ${issue.hypothesis} |
${issue.frequency ? `| **Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}
| **Related Tasks** | ${issue.related_task_ids.length > 0 ? issue.related_task_ids.join(", ") : "None"} |

`);
				}
			}
		}
	}

	// Tasks section
	if (data.tasks.length > 0) {
		parts.push(`---

## Tasks

`);
		const tasksByStatus = {
			done: data.tasks.filter((t) => t.status === "done"),
			running: data.tasks.filter((t) => t.status === "running"),
			pending: data.tasks.filter((t) => t.status === "pending"),
			blocked: data.tasks.filter((t) => t.status === "blocked"),
			failed: data.tasks.filter((t) => t.status === "failed"),
			skipped: data.tasks.filter((t) => t.status === "skipped"),
		};

		for (const [status, tasks] of Object.entries(tasksByStatus)) {
			if (tasks.length > 0) {
				const statusEmoji =
					status === "done"
						? "✅"
						: status === "running"
							? "🔄"
							: status === "pending"
								? "⏳"
								: status === "blocked"
									? "🚫"
									: status === "failed"
										? "❌"
										: "⏭️";

				parts.push(`### ${statusEmoji} ${status.toUpperCase()} (${tasks.length})

`);
				for (const task of tasks) {
					parts.push(`#### ${task.id}: ${task.title}

${task.description ? `${task.description}\n\n` : ""}| Field | Value |
|-------|-------|
| **Issue** | ${task.issue_id || "N/A"} |
| **Files** | ${task.files.length > 0 ? task.files.join(", ") : "None"} |
| **Dependencies** | ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "None"} |
| **Parallel Group** | ${task.parallel_group} |
${task.branch ? `| **Branch** | ${task.branch} |` : ""}
${task.error ? `| **Error** | ${task.error} |` : ""}

`);
					if (task.acceptance.length > 0) {
						parts.push(`**Acceptance Criteria:**

`);
						for (const criterion of task.acceptance) {
							const checked = criterion.verified ? "x" : " ";
							parts.push(`- [${checked}] ${criterion.description}
`);
						}
						parts.push("\n");
					}
				}
			}
		}
	}

	// Dependency graph section
	if (data.graph.length > 0) {
		parts.push(`---

## Dependency Graph

`);
		const groups = new Map<number, GraphNode[]>();
		for (const node of data.graph) {
			const group = groups.get(node.parallel_group) || [];
			group.push(node);
			groups.set(node.parallel_group, group);
		}

		const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);
		for (const [groupNum, nodes] of sortedGroups) {
			parts.push(`### Group ${groupNum}

`);
			for (const node of nodes) {
				const deps =
					node.depends_on.length > 0 ? ` → depends on: ${node.depends_on.join(", ")}` : "";
				parts.push(`- ${node.id}${deps}
`);
			}
			parts.push("\n");
		}
	}

	// Executions section
	if (data.executions.length > 0) {
		parts.push(`---

## Execution History

| Task | Started | Completed | Success | Tokens |
|------|---------|-----------|---------|--------|
`);
		for (const exec of data.executions) {
			const success = exec.success === true ? "✅" : exec.success === false ? "❌" : "⏳";
			const tokens = `${exec.input_tokens}/${exec.output_tokens}`;
			parts.push(
				`| ${exec.task_id} | ${exec.started_at.slice(0, 19)} | ${exec.completed_at?.slice(0, 19) || "-"} | ${success} | ${tokens} |
`,
			);
		}
	}

	// Include existing plans if available (using PlanStore for run-aware paths)
	const hasProblemBrief = planFileExists(workDir, "problem_brief.md");
	const hasExecutionPlan = planFileExists(workDir, "execution_plan.md");

	if (hasProblemBrief || hasExecutionPlan) {
		parts.push(`---

## Generated Plans

`);
		if (hasProblemBrief) {
			parts.push(`### Problem Brief

See: \`problem_brief.md\` in \`${getCurrentPlansDir(workDir)}\`

`);
		}
		if (hasExecutionPlan) {
			parts.push(`### Execution Plan

See: \`execution_plan.md\` in \`${getCurrentPlansDir(workDir)}\`

`);
		}
	}

	parts.push(`---

*Generated by Milhouse CLI*
`);

	return parts.join("");
}

/**
 * Get default output directory
 */
export function getDefaultOutputDir(workDir: string): string {
	return join(getMilhouseDir(workDir), "exports");
}

/**
 * Run the export command
 *
 * Exports state to md/json formats
 */
export async function runExport(
	options: RuntimeOptions,
	exportOptions?: ExportOptions,
): Promise<ExportResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	setVerbose(options.verbose);

	const milDir = getMilhouseDir(workDir);
	if (!existsSync(milDir)) {
		logError("No .milhouse/ directory found. Run 'milhouse init' first.");
		return {
			success: false,
			filesCreated: [],
			error: "Not initialized",
		};
	}

	initializeDir(workDir);

	// Parse formats from options
	const formats = exportOptions?.formats || parseFormats("md,json");
	const outputDir = exportOptions?.outputDir || getDefaultOutputDir(workDir);

	logInfo("Starting export");
	logInfo(`Formats: ${formats.join(", ")}`);
	logInfo(`Output directory: ${outputDir}`);
	console.log("");

	// Create output directory
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	// Load all data
	const data = loadExportData(workDir);
	logDebug(
		`Loaded: ${data.issues.length} issues, ${data.tasks.length} tasks, ${data.executions.length} executions`,
	);

	const filesCreated: string[] = [];
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

	// Export JSON
	if (formats.includes("json")) {
		const jsonPath = join(outputDir, `milhouse-export-${timestamp}.json`);
		try {
			const jsonContent = generateJsonExport(data);
			writeFileSync(jsonPath, jsonContent);
			filesCreated.push(jsonPath);
			logSuccess(`Created: ${basename(jsonPath)}`);
		} catch (error) {
			logError(`Failed to create JSON export: ${error}`);
		}
	}

	// Export Markdown
	if (formats.includes("md")) {
		const mdPath = join(outputDir, `milhouse-export-${timestamp}.md`);
		try {
			const mdContent = generateMarkdownExport(data, workDir);
			writeFileSync(mdPath, mdContent);
			filesCreated.push(mdPath);
			logSuccess(`Created: ${basename(mdPath)}`);
		} catch (error) {
			logError(`Failed to create Markdown export: ${error}`);
		}
	}

	const duration = Date.now() - startTime;

	// Summary
	console.log("");
	console.log("=".repeat(50));
	logInfo("Export Summary:");
	console.log(`  Files created:  ${pc.cyan(String(filesCreated.length))}`);
	console.log(`  Output dir:     ${pc.cyan(outputDir)}`);
	console.log(`  Duration:       ${formatDuration(duration)}`);
	console.log("=".repeat(50));

	if (filesCreated.length > 0) {
		console.log("");
		logInfo("Files:");
		for (const file of filesCreated) {
			console.log(`  ${pc.cyan(file)}`);
		}
	}

	if (filesCreated.length === 0) {
		logWarn("No files were created during export");
		return {
			success: false,
			filesCreated: [],
			error: "No files created",
		};
	}

	updateProgress(`Export: Created ${filesCreated.length} file(s) in ${outputDir}`, workDir);

	return {
		success: true,
		filesCreated,
	};
}
