import { getConfigService } from "../services/config/index.ts";
import type { Issue, Task } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type CDMInput,
	type CDMOutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Parsed duplicate entry from AI response
 */
interface ParsedDuplicate {
	keepId: string;
	removeIds: string[];
	reason: string;
}

/**
 * Parsed cross dependency from AI response
 */
interface ParsedCrossDependency {
	taskId: string;
	dependsOn: string;
	reason: string;
}

/**
 * Parsed parallel group from AI response
 */
interface ParsedParallelGroup {
	group: number;
	taskIds: string[];
}

/**
 * Parsed consolidation result from AI response
 */
interface ParsedConsolidation {
	duplicates: ParsedDuplicate[];
	crossDependencies: ParsedCrossDependency[];
	parallelGroups: ParsedParallelGroup[];
	executionOrder: string[];
}

/**
 * Consolidator Agent (CDM - Consistency & Dependency Manager)
 *
 * Responsible for consolidating multiple Work Breakdown Structures into a unified
 * Execution Plan with proper dependencies and parallel execution groups.
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - Duplicate tasks to merge
 * - Cross-issue dependencies to add
 * - Parallel group assignments
 * - Recommended execution order
 */
export class ConsolidatorAgent extends BaseAgent<CDMInput, CDMOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("CDM", configOverrides);
	}

	/**
	 * Build prompt sections for the Consolidator
	 */
	protected buildPromptSections(input: CDMInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const { tasks, issues } = input;

		// Role section
		sections.push(
			createRoleSection(
				"CDM",
				"You are consolidating multiple Work Breakdown Structures into a unified Execution Plan. Your task is to identify duplicates, establish cross-issue dependencies, and optimize parallel execution.",
			),
		);

		// Context section
		const contextParts: string[] = [];
		const config = getConfigService(workDir).getConfig();
		if (config) {
			// Build project context
			const projectParts: string[] = [];
			if (config.project.name) projectParts.push(`Project: ${config.project.name}`);
			if (config.project.language) projectParts.push(`Language: ${config.project.language}`);
			if (config.project.framework) projectParts.push(`Framework: ${config.project.framework}`);
			if (config.project.description) projectParts.push(`Description: ${config.project.description}`);
			if (projectParts.length > 0) {
				contextParts.push(projectParts.join("\n"));
			}

			// Add commands
			if (config.commands.test) {
				contextParts.push(`Test command: ${config.commands.test}`);
			}
			if (config.commands.lint) {
				contextParts.push(`Lint command: ${config.commands.lint}`);
			}
			if (config.commands.build) {
				contextParts.push(`Build command: ${config.commands.build}`);
			}
		}

		if (contextParts.length > 0) {
			sections.push({
				type: "context",
				header: "Project Context",
				content: contextParts.join("\n\n"),
				priority: SECTION_PRIORITIES.context,
			});
		}

		// Issues section
		const issuesList = issues
			.map(
				(i) =>
					`- **${i.id}** [${i.status}]: ${i.symptom}
  - Severity: ${i.severity}
  - Tasks: ${i.related_task_ids.length > 0 ? i.related_task_ids.join(", ") : "None"}`,
			)
			.join("\n\n");

		sections.push({
			type: "input",
			header: `Issues (${issues.length})`,
			content: issuesList,
			priority: SECTION_PRIORITIES.input,
		});

		// Tasks section
		const tasksList = tasks
			.map(
				(t) =>
					`### ${t.id}: ${t.title}
- **Issue**: ${t.issue_id || "None"}
- **Status**: ${t.status}
- **Files**: ${t.files.length > 0 ? t.files.join(", ") : "None specified"}
- **Dependencies**: ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "None"}
- **Parallel Group**: ${t.parallel_group}
- **Description**: ${t.description || "No description"}`,
			)
			.join("\n\n");

		sections.push({
			type: "input",
			header: `Tasks to Consolidate (${tasks.length})`,
			content: tasksList,
			priority: SECTION_PRIORITIES.input + 1,
		});

		// Task section
		sections.push({
			type: "task",
			header: "Task",
			content: `Analyze the tasks and provide consolidation recommendations:

1. **Duplicates**: Find tasks that do the same thing or modify the same files
2. **Cross-Dependencies**: Identify dependencies between tasks from different issues
3. **Parallel Groups**: Optimize which tasks can run in parallel
4. **Execution Order**: Provide the optimal execution order respecting dependencies

Consider:
- Tasks touching the same files may conflict
- Some tasks may need to run before others even if from different issues
- Tasks with no conflicts can run in parallel for efficiency`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "duplicates": [
    {
      "keepId": "TASK_ID to keep",
      "removeIds": ["TASK_IDs to remove"],
      "reason": "Why these are duplicates"
    }
  ],
  "crossDependencies": [
    {
      "taskId": "TASK_ID",
      "dependsOn": "OTHER_TASK_ID from different issue",
      "reason": "Why this dependency exists"
    }
  ],
  "parallelGroups": [
    {
      "group": 0,
      "taskIds": ["IDs of tasks that can run in parallel"]
    }
  ],
  "executionOrder": ["Ordered list of task IDs for execution"]
}
\`\`\`

**Field Descriptions:**
- **duplicates**: Array of duplicate task groups
  - **keepId**: The task ID to keep (the most complete or well-defined one)
  - **removeIds**: Task IDs to remove (duplicates of keepId)
  - **reason**: Explanation of why these tasks are duplicates
- **crossDependencies**: Array of cross-issue dependencies to add
  - **taskId**: The task that has a dependency
  - **dependsOn**: The task it depends on (from a different issue)
  - **reason**: Why this dependency exists
- **parallelGroups**: Array of parallel execution groups
  - **group**: Group number (0 = first to execute, higher numbers execute later)
  - **taskIds**: Task IDs that can run in parallel within this group
- **executionOrder**: Complete ordered list of all task IDs`,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- **Duplicates**: Only merge tasks that are truly doing the same thing
  - Same files modified with same purpose
  - Nearly identical descriptions
  - Be conservative - when in doubt, don't merge
- **Cross-Dependencies**: Consider file conflicts and logical ordering
  - If task A modifies a file that task B reads, B depends on A
  - If task A creates something task B uses, B depends on A
  - Consider database migrations, config changes, API contracts
- **Parallel Groups**: Tasks with no conflicts can run together
  - Group 0 has no dependencies (starts first)
  - Each subsequent group depends on previous groups completing
  - Keep related tasks together when possible
- **Execution Order**: Must respect all dependencies
  - Topologically sorted based on depends_on relationships
  - Tasks in the same parallel group can appear in any order
  - Ensure no circular dependencies

**Important:**
- If no duplicates exist, return empty duplicates array
- If no cross-dependencies exist, return empty crossDependencies array
- Every task should appear in exactly one parallel group
- executionOrder should contain ALL task IDs, not just some`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Consolidator
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: CDMInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		const { tasks, issues } = input;
		return `You are the Consolidator (CDM) agent.
Consolidate ${tasks.length} tasks from ${issues.length} issues into a unified execution plan.
Task IDs: ${tasks.map((t) => t.id).join(", ")}
Respond with JSON containing duplicates, crossDependencies, parallelGroups, and executionOrder.`;
	}

	/**
	 * Parse the AI response into CDMOutput
	 */
	parseOutput(response: string): CDMOutput {
		const consolidation = parseConsolidationFromResponse(response);
		return {
			duplicates: consolidation.duplicates.map((d) => ({
				keepId: d.keepId,
				removeIds: d.removeIds,
				reason: d.reason,
			})),
			crossDependencies: consolidation.crossDependencies.map((cd) => ({
				taskId: cd.taskId,
				dependsOn: cd.dependsOn,
				reason: cd.reason,
			})),
			parallelGroups: consolidation.parallelGroups.map((pg) => ({
				group: pg.group,
				taskIds: pg.taskIds,
			})),
			executionOrder: consolidation.executionOrder,
		};
	}
}

/**
 * Parse consolidation result from AI response
 */
export function parseConsolidationFromResponse(response: string): ParsedConsolidation {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createDefaultConsolidation();
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedConsolidation(parsed)) {
			return normalizeConsolidation(parsed);
		}

		// Return default empty consolidation if invalid structure
		return createDefaultConsolidation();
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(
			/\{\s*"duplicates"[\s\S]*?"executionOrder"\s*:\s*\[[\s\S]*?\]\s*\}/,
		);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedConsolidation(parsed)) {
					return normalizeConsolidation(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return default if parsing fails
		return createDefaultConsolidation();
	}
}

/**
 * Raw parsed consolidation from JSON (before normalization)
 */
interface RawParsedConsolidation {
	duplicates?: unknown[];
	crossDependencies?: unknown[];
	cross_dependencies?: unknown[];
	parallelGroups?: unknown[];
	parallel_groups?: unknown[];
	executionOrder?: unknown[];
	execution_order?: unknown[];
}

/**
 * Validate parsed consolidation has required fields
 */
function isValidParsedConsolidation(data: unknown): data is RawParsedConsolidation {
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const obj = data as Record<string, unknown>;

	// Check for arrays (support both camelCase and snake_case)
	const hasDuplicates = Array.isArray(obj.duplicates);
	const hasCrossDeps =
		Array.isArray(obj.crossDependencies) || Array.isArray(obj.cross_dependencies);
	const hasParallelGroups = Array.isArray(obj.parallelGroups) || Array.isArray(obj.parallel_groups);
	const hasExecutionOrder = Array.isArray(obj.executionOrder) || Array.isArray(obj.execution_order);

	return hasDuplicates && hasCrossDeps && hasParallelGroups && hasExecutionOrder;
}

/**
 * Normalize parsed consolidation (handle both camelCase and snake_case)
 */
function normalizeConsolidation(parsed: RawParsedConsolidation): ParsedConsolidation {
	const duplicatesRaw = parsed.duplicates || [];
	const crossDepsRaw = parsed.crossDependencies || parsed.cross_dependencies || [];
	const parallelGroupsRaw = parsed.parallelGroups || parsed.parallel_groups || [];
	const executionOrderRaw = parsed.executionOrder || parsed.execution_order || [];

	return {
		duplicates: duplicatesRaw.map(normalizeDuplicate).filter(isValidDuplicate),
		crossDependencies: crossDepsRaw.map(normalizeCrossDependency).filter(isValidCrossDependency),
		parallelGroups: parallelGroupsRaw.map(normalizeParallelGroup).filter(isValidParallelGroup),
		executionOrder: executionOrderRaw.filter((id): id is string => typeof id === "string"),
	};
}

/**
 * Normalize a duplicate entry
 */
function normalizeDuplicate(dup: unknown): ParsedDuplicate {
	if (typeof dup !== "object" || dup === null) {
		return { keepId: "", removeIds: [], reason: "" };
	}

	const obj = dup as Record<string, unknown>;

	// Support both keepId/keep and removeIds/remove
	const keepId = (obj.keepId || obj.keep || "") as string;
	const removeIds = Array.isArray(obj.removeIds)
		? obj.removeIds.filter((id): id is string => typeof id === "string")
		: Array.isArray(obj.remove)
			? obj.remove.filter((id): id is string => typeof id === "string")
			: [];
	const reason = typeof obj.reason === "string" ? obj.reason : "";

	return { keepId, removeIds, reason };
}

/**
 * Validate a duplicate entry
 */
function isValidDuplicate(dup: ParsedDuplicate): boolean {
	return dup.keepId.length > 0 && dup.removeIds.length > 0;
}

/**
 * Normalize a cross dependency entry
 */
function normalizeCrossDependency(crossDep: unknown): ParsedCrossDependency {
	if (typeof crossDep !== "object" || crossDep === null) {
		return { taskId: "", dependsOn: "", reason: "" };
	}

	const obj = crossDep as Record<string, unknown>;

	// Support both taskId/task_id and dependsOn/depends_on
	const taskId = (obj.taskId || obj.task_id || "") as string;

	// dependsOn can be string or array - normalize to single string for CDMOutput compatibility
	let dependsOn = "";
	if (typeof obj.dependsOn === "string") {
		dependsOn = obj.dependsOn;
	} else if (typeof obj.depends_on === "string") {
		dependsOn = obj.depends_on;
	} else if (Array.isArray(obj.dependsOn) && obj.dependsOn.length > 0) {
		dependsOn = String(obj.dependsOn[0]);
	} else if (Array.isArray(obj.depends_on) && obj.depends_on.length > 0) {
		dependsOn = String(obj.depends_on[0]);
	}

	const reason = typeof obj.reason === "string" ? obj.reason : "";

	return { taskId, dependsOn, reason };
}

/**
 * Validate a cross dependency entry
 */
function isValidCrossDependency(crossDep: ParsedCrossDependency): boolean {
	return crossDep.taskId.length > 0 && crossDep.dependsOn.length > 0;
}

/**
 * Normalize a parallel group entry
 */
function normalizeParallelGroup(pg: unknown): ParsedParallelGroup {
	if (typeof pg !== "object" || pg === null) {
		return { group: 0, taskIds: [] };
	}

	const obj = pg as Record<string, unknown>;

	const group = typeof obj.group === "number" ? obj.group : 0;

	// Support both taskIds and task_ids
	const taskIdsRaw = obj.taskIds || obj.task_ids;
	const taskIds = Array.isArray(taskIdsRaw)
		? taskIdsRaw.filter((id): id is string => typeof id === "string")
		: [];

	return { group, taskIds };
}

/**
 * Validate a parallel group entry
 */
function isValidParallelGroup(pg: ParsedParallelGroup): boolean {
	return pg.taskIds.length > 0;
}

/**
 * Create default empty consolidation result
 */
function createDefaultConsolidation(): ParsedConsolidation {
	return {
		duplicates: [],
		crossDependencies: [],
		parallelGroups: [],
		executionOrder: [],
	};
}

/**
 * Create a Consolidator agent with default configuration
 */
export function createConsolidatorAgent(configOverrides?: Partial<AgentConfig>): ConsolidatorAgent {
	return new ConsolidatorAgent(configOverrides);
}

/**
 * Build Consolidator prompt (standalone utility for backward compatibility)
 */
export function buildConsolidatorPrompt(tasks: Task[], issues: Issue[], workDir: string): string {
	const agent = new ConsolidatorAgent();
	return agent.buildPrompt({ tasks, issues }, workDir);
}

/**
 * Check if consolidation has any duplicates to remove
 */
export function hasDuplicates(output: CDMOutput): boolean {
	return output.duplicates.length > 0;
}

/**
 * Get total number of tasks to remove
 */
export function getDuplicateRemoveCount(output: CDMOutput): number {
	return output.duplicates.reduce((sum, d) => sum + d.removeIds.length, 0);
}

/**
 * Check if consolidation has any cross-issue dependencies
 */
export function hasCrossDependencies(output: CDMOutput): boolean {
	return output.crossDependencies.length > 0;
}

/**
 * Get number of cross-issue dependencies
 */
export function getCrossDependencyCount(output: CDMOutput): number {
	return output.crossDependencies.length;
}

/**
 * Get number of parallel groups
 */
export function getParallelGroupCount(output: CDMOutput): number {
	return output.parallelGroups.length;
}

/**
 * Get tasks in a specific parallel group
 */
export function getTasksInGroup(output: CDMOutput, group: number): string[] {
	const pg = output.parallelGroups.find((p) => p.group === group);
	return pg ? pg.taskIds : [];
}

/**
 * Get all parallel group numbers (sorted)
 */
export function getParallelGroupNumbers(output: CDMOutput): number[] {
	return [...new Set(output.parallelGroups.map((pg) => pg.group))].sort((a, b) => a - b);
}

/**
 * Check if execution order is valid (all task IDs present exactly once)
 */
export function isExecutionOrderValid(output: CDMOutput, allTaskIds: string[]): boolean {
	const orderSet = new Set(output.executionOrder);
	const taskSet = new Set(allTaskIds);

	// Check same count
	if (orderSet.size !== taskSet.size) {
		return false;
	}

	// Check all tasks are in order
	for (const taskId of allTaskIds) {
		if (!orderSet.has(taskId)) {
			return false;
		}
	}

	return true;
}

/**
 * Get tasks that are marked as duplicates to keep
 */
export function getKeptTaskIds(output: CDMOutput): string[] {
	return output.duplicates.map((d) => d.keepId);
}

/**
 * Get tasks that are marked as duplicates to remove
 */
export function getRemovedTaskIds(output: CDMOutput): string[] {
	return output.duplicates.flatMap((d) => d.removeIds);
}

/**
 * Check if a specific task is marked for removal
 */
export function isTaskMarkedForRemoval(output: CDMOutput, taskId: string): boolean {
	return getRemovedTaskIds(output).includes(taskId);
}

/**
 * Get the task ID that a removed task should be merged into
 */
export function getKeepIdForRemovedTask(output: CDMOutput, taskId: string): string | undefined {
	for (const dup of output.duplicates) {
		if (dup.removeIds.includes(taskId)) {
			return dup.keepId;
		}
	}
	return undefined;
}

/**
 * Get cross dependencies for a specific task
 */
export function getCrossDependenciesForTask(
	output: CDMOutput,
	taskId: string,
): CDMOutput["crossDependencies"] {
	return output.crossDependencies.filter((cd) => cd.taskId === taskId);
}

/**
 * Get tasks that depend on a specific task (cross-dependencies)
 */
export function getTasksDependingOn(output: CDMOutput, taskId: string): string[] {
	return output.crossDependencies.filter((cd) => cd.dependsOn === taskId).map((cd) => cd.taskId);
}

/**
 * Apply consolidation to a task list
 * Returns the updated task list with duplicates removed and dependencies added
 */
export function applyConsolidationToTasks(tasks: Task[], output: CDMOutput): Task[] {
	// Get IDs to remove
	const removeIds = new Set(getRemovedTaskIds(output));

	// Filter out removed tasks
	let result = tasks.filter((t) => !removeIds.has(t.id));

	// Update dependencies: replace removed task IDs with kept IDs
	const removalMap = new Map<string, string>();
	for (const dup of output.duplicates) {
		for (const removeId of dup.removeIds) {
			removalMap.set(removeId, dup.keepId);
		}
	}

	result = result.map((t) => {
		const newDependsOn = t.depends_on.map((dep) => removalMap.get(dep) || dep);
		// Remove self-references and duplicates
		const uniqueDeps = [...new Set(newDependsOn)].filter((dep) => dep !== t.id);
		return {
			...t,
			depends_on: uniqueDeps,
		};
	});

	// Add cross-dependencies
	for (const crossDep of output.crossDependencies) {
		const taskIndex = result.findIndex((t) => t.id === crossDep.taskId);
		if (taskIndex !== -1) {
			const task = result[taskIndex];
			if (!task.depends_on.includes(crossDep.dependsOn)) {
				result = [
					...result.slice(0, taskIndex),
					{
						...task,
						depends_on: [...task.depends_on, crossDep.dependsOn],
					},
					...result.slice(taskIndex + 1),
				];
			}
		}
	}

	// Update parallel groups
	for (const pg of output.parallelGroups) {
		for (const taskId of pg.taskIds) {
			const taskIndex = result.findIndex((t) => t.id === taskId);
			if (taskIndex !== -1) {
				const task = result[taskIndex];
				result = [
					...result.slice(0, taskIndex),
					{
						...task,
						parallel_group: pg.group,
					},
					...result.slice(taskIndex + 1),
				];
			}
		}
	}

	return result;
}

/**
 * Format consolidation result as markdown for display
 */
export function formatConsolidationAsMarkdown(output: CDMOutput): string {
	const lines: string[] = [];

	lines.push("## Consolidation Result");
	lines.push("");

	// Summary
	lines.push("### Summary");
	lines.push("");
	lines.push(`- Duplicates to merge: ${output.duplicates.length}`);
	lines.push(`- Tasks to remove: ${getDuplicateRemoveCount(output)}`);
	lines.push(`- Cross-dependencies: ${output.crossDependencies.length}`);
	lines.push(`- Parallel groups: ${output.parallelGroups.length}`);
	lines.push("");

	// Duplicates
	if (output.duplicates.length > 0) {
		lines.push("### Duplicates to Merge");
		lines.push("");
		for (const dup of output.duplicates) {
			lines.push(`- **Keep**: ${dup.keepId}`);
			lines.push(`  - **Remove**: ${dup.removeIds.join(", ")}`);
			lines.push(`  - *Reason*: ${dup.reason}`);
		}
		lines.push("");
	}

	// Cross-dependencies
	if (output.crossDependencies.length > 0) {
		lines.push("### Cross-Issue Dependencies");
		lines.push("");
		for (const cd of output.crossDependencies) {
			lines.push(`- **${cd.taskId}** depends on **${cd.dependsOn}**`);
			lines.push(`  - *Reason*: ${cd.reason}`);
		}
		lines.push("");
	}

	// Parallel groups
	if (output.parallelGroups.length > 0) {
		lines.push("### Parallel Groups");
		lines.push("");
		const sortedGroups = [...output.parallelGroups].sort((a, b) => a.group - b.group);
		for (const pg of sortedGroups) {
			lines.push(`#### Group ${pg.group}`);
			lines.push(`Tasks: ${pg.taskIds.join(", ")}`);
			lines.push("");
		}
	}

	// Execution order
	if (output.executionOrder.length > 0) {
		lines.push("### Execution Order");
		lines.push("");
		output.executionOrder.forEach((taskId, index) => {
			lines.push(`${index + 1}. ${taskId}`);
		});
	}

	return lines.join("\n");
}
