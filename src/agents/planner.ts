import { getConfigService } from "../services/config/index.ts";
import type { DoDCriteria, Issue } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type PLInput,
	type PLOutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Parsed WBS task from AI response
 */
interface ParsedWBSTask {
	title: string;
	description?: string;
	files: string[];
	depends_on: string[];
	checks: string[];
	acceptance: DoDCriteria[];
	risk?: string;
	rollback?: string;
	parallel_group?: number;
}

/**
 * Parsed WBS from AI response
 */
interface ParsedWBS {
	issue_id: string;
	summary: string;
	tasks: ParsedWBSTask[];
}

/**
 * Planner Agent
 *
 * Responsible for generating Work Breakdown Structure (WBS) for validated issues.
 * Creates small, testable tasks with clear acceptance criteria and dependencies.
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - Issue ID being planned
 * - Summary of the plan
 * - List of tasks with title, description, files, dependencies, checks, acceptance criteria
 */
export class PlannerAgent extends BaseAgent<PLInput, PLOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("PL", configOverrides);
	}

	/**
	 * Build prompt sections for the Planner
	 */
	protected buildPromptSections(input: PLInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const issue = input.issue;

		// Role section
		sections.push(
			createRoleSection(
				"PL",
				"You are creating a Work Breakdown Structure (WBS) for a validated issue. Your task is to break down the fix into small, testable tasks with clear acceptance criteria.",
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

		// Issue section
		const issueDetails = [
			`**ID**: ${issue.id}`,
			`**Status**: ${issue.status}`,
			`**Symptom**: ${issue.symptom}`,
			`**Hypothesis**: ${issue.hypothesis}`,
		];

		if (issue.corrected_description) {
			issueDetails.push(`**Corrected Description**: ${issue.corrected_description}`);
		}

		issueDetails.push(`**Severity**: ${issue.severity}`);

		if (issue.frequency) {
			issueDetails.push(`**Frequency**: ${issue.frequency}`);
		}
		if (issue.blast_radius) {
			issueDetails.push(`**Blast Radius**: ${issue.blast_radius}`);
		}
		if (issue.strategy) {
			issueDetails.push(`**Strategy**: ${issue.strategy}`);
		}

		sections.push({
			type: "input",
			header: "Issue to Plan",
			content: issueDetails.join("\n"),
			priority: SECTION_PRIORITIES.input,
		});

		// Add evidence if available
		if (issue.evidence && issue.evidence.length > 0) {
			const evidenceList = issue.evidence
				.map((ev) => {
					if (ev.type === "file" && ev.file) {
						let line = `- **File**: \`${ev.file}\``;
						if (ev.line_start) {
							line += `:${ev.line_start}`;
							if (ev.line_end && ev.line_end !== ev.line_start) {
								line += `-${ev.line_end}`;
							}
						}
						return line;
					}
					if (ev.type === "command" && ev.command) {
						return `- **Command**: \`${ev.command}\``;
					}
					if (ev.type === "probe" && ev.probe_id) {
						return `- **Probe**: ${ev.probe_id}`;
					}
					return `- ${ev.type}`;
				})
				.join("\n");

			sections.push({
				type: "context",
				header: "Evidence",
				content: evidenceList,
				priority: SECTION_PRIORITIES.context + 1,
			});
		}

		// Add related issues context if provided
		if (input.relatedIssues && input.relatedIssues.length > 0) {
			const relatedList = input.relatedIssues
				.map((ri) => `- **${ri.id}**: ${ri.symptom} (${ri.status})`)
				.join("\n");

			sections.push({
				type: "context",
				header: "Related Issues",
				content: `Consider these related issues when planning:\n\n${relatedList}`,
				priority: SECTION_PRIORITIES.context + 2,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Task",
			content: `Create a Work Breakdown Structure (WBS) to fix this issue. Each task should be:

1. **Small and focused**: Ideally completable in one commit
2. **Testable**: With clear acceptance criteria that can be verified
3. **Independent**: Minimal dependencies where possible
4. **Ordered**: Use depends_on to specify execution order

Consider:
- Test-first approach where appropriate
- Edge cases and error handling
- Rollback strategies for risky changes`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "summary": "Brief summary of the fix approach",
  "tasks": [
    {
      "title": "Short task title",
      "description": "Detailed description of what needs to be done",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "depends_on": [],
      "checks": ["npm test", "npm run lint"],
      "acceptance": [
        {
          "description": "Test passes for X scenario",
          "check_command": "npm test -- --grep 'X scenario'"
        }
      ],
      "risk": "Low - isolated change",
      "rollback": "Revert commit",
      "parallel_group": 0
    }
  ]
}
\`\`\`

**Field Descriptions:**
- **issue_id**: The ID of the issue being planned
- **summary**: Brief overview of the fix strategy
- **tasks**: Array of tasks in execution order
  - **title**: Short descriptive title (required)
  - **description**: Detailed explanation of what to do
  - **files**: All files that will be modified
  - **depends_on**: Array of task indices (0-based) that must complete first
  - **checks**: Commands to run after task completion
  - **acceptance**: Verifiable criteria for task completion
  - **risk**: Risk assessment (optional)
  - **rollback**: How to undo the change (optional)
  - **parallel_group**: Tasks with same group can run concurrently (default: 0)`,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- **Task Granularity**: Each task should be a single logical unit of work
- **Dependencies**: Use depends_on to reference other task indices (0-based within this WBS)
- **Parallel Groups**: Tasks with the same parallel_group can run concurrently
- **Acceptance Criteria**: Must be verifiable by running commands
- **Files**: List ALL files that will be modified
- **Checks**: Commands to run after task completion
- **Risk Assessment**: Describe potential risks and blast radius
- **Rollback**: How to undo if something goes wrong

**Important:**
- Do NOT create tasks that are too broad (e.g., "fix everything")
- Do NOT create tasks without acceptance criteria
- Each task should result in a working, testable state
- Consider test-first approach where appropriate
- Account for edge cases and error handling
- Keep the number of tasks reasonable (typically 2-8 per issue)`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Planner
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: PLInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		const issue = input.issue;
		return `You are the Planner (PL) agent.
Create a Work Breakdown Structure for issue ${issue.id}: ${issue.symptom}
Hypothesis: ${issue.hypothesis}
Respond with JSON containing issue_id, summary, and tasks array.`;
	}

	/**
	 * Parse the AI response into PLOutput
	 */
	parseOutput(response: string): PLOutput {
		const wbs = parseWBSFromResponse(response);
		return {
			issueId: wbs.issue_id,
			summary: wbs.summary,
			tasks: wbs.tasks.map((t) => ({
				title: t.title,
				description: t.description,
				files: t.files,
				depends_on: t.depends_on,
				checks: t.checks,
				acceptance: t.acceptance.map((a) => ({
					description: a.description,
					check_command: a.check_command,
				})),
				risk: t.risk,
				rollback: t.rollback,
			})),
		};
	}
}

/**
 * Parse WBS from AI response
 */
export function parseWBSFromResponse(response: string): ParsedWBS {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createDefaultWBS("", "Failed to extract JSON from WBS response");
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedWBS(parsed)) {
			return normalizeWBS(parsed);
		}

		// Return default empty WBS if invalid structure
		return createDefaultWBS("", "Failed to parse WBS response");
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(/\{\s*"issue_id"[\s\S]*?"tasks"\s*:\s*\[[\s\S]*?\]\s*\}/);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedWBS(parsed)) {
					return normalizeWBS(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return default if parsing fails
		return createDefaultWBS("", "Failed to parse WBS response");
	}
}

/**
 * Validate parsed WBS has required fields
 */
function isValidParsedWBS(wbs: unknown): wbs is ParsedWBS {
	if (typeof wbs !== "object" || wbs === null) {
		return false;
	}

	const obj = wbs as Record<string, unknown>;

	if (typeof obj.issue_id !== "string") {
		return false;
	}

	if (typeof obj.summary !== "string") {
		return false;
	}

	if (!Array.isArray(obj.tasks)) {
		return false;
	}

	// Validate each task has required fields
	for (const task of obj.tasks) {
		if (!isValidParsedTask(task)) {
			return false;
		}
	}

	return true;
}

/**
 * Validate a parsed task
 */
function isValidParsedTask(task: unknown): task is ParsedWBSTask {
	if (typeof task !== "object" || task === null) {
		return false;
	}

	const obj = task as Record<string, unknown>;

	// Title is required
	if (typeof obj.title !== "string" || obj.title.trim() === "") {
		return false;
	}

	// Files should be an array if present
	if (obj.files !== undefined && !Array.isArray(obj.files)) {
		return false;
	}

	// Depends_on should be an array if present
	if (obj.depends_on !== undefined && !Array.isArray(obj.depends_on)) {
		return false;
	}

	// Checks should be an array if present
	if (obj.checks !== undefined && !Array.isArray(obj.checks)) {
		return false;
	}

	// Acceptance should be an array if present
	if (obj.acceptance !== undefined && !Array.isArray(obj.acceptance)) {
		return false;
	}

	return true;
}

/**
 * Normalize parsed WBS
 */
function normalizeWBS(parsed: ParsedWBS): ParsedWBS {
	return {
		issue_id: parsed.issue_id,
		summary: parsed.summary,
		tasks: parsed.tasks.map(normalizeTask),
	};
}

/**
 * Normalize a parsed task
 */
function normalizeTask(task: ParsedWBSTask): ParsedWBSTask {
	return {
		title: task.title,
		description: task.description,
		files: Array.isArray(task.files) ? task.files.filter((f) => typeof f === "string") : [],
		depends_on: Array.isArray(task.depends_on) ? task.depends_on.map((d) => String(d)) : [],
		checks: Array.isArray(task.checks) ? task.checks.filter((c) => typeof c === "string") : [],
		acceptance: Array.isArray(task.acceptance)
			? task.acceptance.map(normalizeAcceptanceCriteria)
			: [],
		risk: typeof task.risk === "string" ? task.risk : undefined,
		rollback: typeof task.rollback === "string" ? task.rollback : undefined,
		parallel_group: typeof task.parallel_group === "number" ? task.parallel_group : 0,
	};
}

/**
 * Normalize acceptance criteria
 */
function normalizeAcceptanceCriteria(criteria: unknown): DoDCriteria {
	if (typeof criteria !== "object" || criteria === null) {
		return {
			description: "Unknown criteria",
			verified: false,
		};
	}

	const obj = criteria as Record<string, unknown>;
	return {
		description: typeof obj.description === "string" ? obj.description : "Unknown criteria",
		check_command: typeof obj.check_command === "string" ? obj.check_command : undefined,
		verified: typeof obj.verified === "boolean" ? obj.verified : false,
	};
}

/**
 * Create default WBS result
 */
function createDefaultWBS(issueId: string, summary: string): ParsedWBS {
	return {
		issue_id: issueId,
		summary,
		tasks: [],
	};
}

/**
 * Create a Planner agent with default configuration
 */
export function createPlannerAgent(configOverrides?: Partial<AgentConfig>): PlannerAgent {
	return new PlannerAgent(configOverrides);
}

/**
 * Build Planner prompt (standalone utility for backward compatibility)
 */
export function buildPlannerPrompt(issue: Issue, workDir: string, relatedIssues?: Issue[]): string {
	const agent = new PlannerAgent();
	return agent.buildPrompt({ issue, relatedIssues }, workDir);
}

/**
 * Convert PLOutput to task creation data for state storage
 */
export function convertToTaskData(
	output: PLOutput,
	taskIndex: number,
): {
	title: string;
	description?: string;
	files: string[];
	depends_on: string[];
	checks: string[];
	acceptance: DoDCriteria[];
	risk?: string;
	rollback?: string;
	parallel_group: number;
	status: "pending";
} {
	const task = output.tasks[taskIndex];
	return {
		title: task.title,
		description: task.description,
		files: task.files,
		depends_on: task.depends_on,
		checks: task.checks,
		acceptance: task.acceptance.map((a) => ({
			description: a.description,
			check_command: a.check_command,
			verified: false,
		})),
		risk: task.risk,
		rollback: task.rollback,
		parallel_group: 0, // Will be set during consolidation
		status: "pending",
	};
}

/**
 * Check if WBS has any tasks
 */
export function hasTasksPlanned(output: PLOutput): boolean {
	return output.tasks.length > 0;
}

/**
 * Get total number of tasks in a plan
 */
export function getTaskCount(output: PLOutput): number {
	return output.tasks.length;
}

/**
 * Get tasks with dependencies
 */
export function getTasksWithDependencies(output: PLOutput): PLOutput["tasks"] {
	return output.tasks.filter((t) => t.depends_on.length > 0);
}

/**
 * Get root tasks (no dependencies)
 */
export function getRootTasks(output: PLOutput): PLOutput["tasks"] {
	return output.tasks.filter((t) => t.depends_on.length === 0);
}

/**
 * Validate task dependencies are within bounds
 */
export function validateTaskDependencies(output: PLOutput): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	const taskCount = output.tasks.length;

	for (let i = 0; i < output.tasks.length; i++) {
		const task = output.tasks[i];
		for (const dep of task.depends_on) {
			const depIndex = Number.parseInt(dep, 10);
			if (Number.isNaN(depIndex) || depIndex < 0 || depIndex >= taskCount) {
				errors.push(`Task ${i} ("${task.title}"): Invalid dependency "${dep}"`);
			}
			if (depIndex === i) {
				errors.push(`Task ${i} ("${task.title}"): Self-referential dependency`);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Check for circular dependencies
 */
export function hasCircularDependencies(output: PLOutput): boolean {
	const taskCount = output.tasks.length;
	const visited = new Set<number>();
	const recursionStack = new Set<number>();

	const hasCycle = (taskIndex: number): boolean => {
		visited.add(taskIndex);
		recursionStack.add(taskIndex);

		const task = output.tasks[taskIndex];
		for (const dep of task.depends_on) {
			const depIndex = Number.parseInt(dep, 10);
			if (Number.isNaN(depIndex) || depIndex < 0 || depIndex >= taskCount) {
				continue;
			}

			if (!visited.has(depIndex)) {
				if (hasCycle(depIndex)) {
					return true;
				}
			} else if (recursionStack.has(depIndex)) {
				return true;
			}
		}

		recursionStack.delete(taskIndex);
		return false;
	};

	for (let i = 0; i < taskCount; i++) {
		if (!visited.has(i)) {
			if (hasCycle(i)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Get planning severity based on task count and dependencies
 */
export function getPlanComplexity(output: PLOutput): "simple" | "moderate" | "complex" {
	const taskCount = output.tasks.length;
	const depsCount = output.tasks.reduce((sum, t) => sum + t.depends_on.length, 0);

	if (taskCount <= 2 && depsCount === 0) {
		return "simple";
	}
	if (taskCount <= 5 && depsCount <= taskCount) {
		return "moderate";
	}
	return "complex";
}
