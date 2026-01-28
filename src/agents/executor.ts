import { getConfigService } from "../services/config/index.ts";
import type { DoDCriteria, Issue, Task } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type EXInput,
	type EXOutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Parsed execution result from AI response
 */
interface ParsedExecutionResult {
	success: boolean;
	filesModified: string[];
	summary: string;
	error?: string;
	testsRun?: string[];
	testsPassed?: boolean;
	commitMessage?: string;
}

/**
 * Executor Agent (EX)
 *
 * Responsible for executing tasks with minimal changes.
 * Creates actual code changes, commits, branches, and PRs.
 *
 * Capabilities:
 * - Read files from the repository
 * - Write/modify files
 * - Execute shell commands
 * - Create git branches
 * - Create commits
 * - Create PRs
 *
 * Output:
 * - Success status
 * - Files modified
 * - Summary of changes
 * - Error if failed
 */
export class ExecutorAgent extends BaseAgent<EXInput, EXOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("EX", configOverrides);
	}

	/**
	 * Build prompt sections for the Executor
	 */
	protected buildPromptSections(input: EXInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const { task, issue } = input;

		// Role section
		sections.push(
			createRoleSection(
				"EX",
				"You are executing a task from the Execution Plan. Your goal is to make minimal, focused changes to complete the task while ensuring all acceptance criteria are met.",
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

		// Issue context section (if provided)
		if (issue) {
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

			sections.push({
				type: "context",
				header: "Related Issue",
				content: issueDetails.join("\n"),
				priority: SECTION_PRIORITIES.context + 1,
			});
		}

		// Task details section
		const taskDetails = [`**ID**: ${task.id}`, `**Title**: ${task.title}`];

		if (task.description) {
			taskDetails.push(`**Description**: ${task.description}`);
		}

		if (task.issue_id) {
			taskDetails.push(`**Issue**: ${task.issue_id}`);
		}

		if (task.files.length > 0) {
			taskDetails.push(`**Files to Modify**: ${task.files.join(", ")}`);
		}

		if (task.depends_on.length > 0) {
			taskDetails.push(`**Dependencies**: ${task.depends_on.join(", ")}`);
		}

		if (task.risk) {
			taskDetails.push(`**Risk**: ${task.risk}`);
		}

		if (task.rollback) {
			taskDetails.push(`**Rollback**: ${task.rollback}`);
		}

		sections.push({
			type: "input",
			header: "Task to Execute",
			content: taskDetails.join("\n"),
			priority: SECTION_PRIORITIES.input,
		});

		// Checks section (if any)
		if (task.checks.length > 0) {
			sections.push({
				type: "input",
				header: "Verification Checks",
				content: `Commands to run after changes:\n\n${task.checks.map((c) => `- \`${c}\``).join("\n")}`,
				priority: SECTION_PRIORITIES.input + 1,
			});
		}

		// Acceptance criteria section
		if (task.acceptance.length > 0) {
			const acceptanceList = task.acceptance
				.map((a) => {
					let line = `- ${a.description}`;
					if (a.check_command) {
						line += `\n  - Check: \`${a.check_command}\``;
					}
					return line;
				})
				.join("\n");

			sections.push({
				type: "input",
				header: "Acceptance Criteria",
				content: acceptanceList,
				priority: SECTION_PRIORITIES.input + 2,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Task",
			content: `Execute this task by:

1. **Reading** the relevant files to understand the current state
2. **Making** the minimal changes needed to complete the task
3. **Running** the verification checks to ensure correctness
4. **Reporting** what was changed and whether the task succeeded

Focus on:
- Minimal changes - only modify what is necessary
- Test coverage - ensure changes are tested
- Acceptance criteria - all criteria must be satisfied
- Code quality - follow project conventions`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "success": true,
  "filesModified": ["path/to/file1.ts", "path/to/file2.ts"],
  "summary": "Description of what was changed and why",
  "testsRun": ["npm test -- --grep 'specific test'"],
  "testsPassed": true,
  "commitMessage": "fix: resolve issue with X"
}
\`\`\`

If the task failed:
\`\`\`json
{
  "success": false,
  "filesModified": [],
  "summary": "Description of what was attempted",
  "error": "Detailed error message explaining what went wrong"
}
\`\`\`

**Field Descriptions:**
- **success**: Whether the task was completed successfully
- **filesModified**: Array of all files that were modified
- **summary**: Description of changes made or attempted
- **testsRun**: Commands executed to verify changes (optional)
- **testsPassed**: Whether all verification checks passed (optional)
- **commitMessage**: Suggested commit message (optional, success only)
- **error**: Detailed error message (required if success=false)`,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- **Minimal Changes**: Only modify what is necessary to complete the task
  - Do not refactor unrelated code
  - Do not change formatting outside of modified sections
  - Do not add features beyond the task scope
- **Code Quality**: Follow existing project conventions
  - Match the coding style of surrounding code
  - Add appropriate comments for complex logic
  - Use meaningful variable and function names
- **Testing**: Ensure changes are properly tested
  - Run existing tests to check for regressions
  - Add new tests if acceptance criteria require them
  - Verify all checks pass before reporting success
- **Error Handling**: Handle errors gracefully
  - Provide clear error messages if the task fails
  - List what was attempted and what went wrong
  - Suggest possible fixes if known
- **Acceptance Criteria**: All criteria must be satisfied
  - Each criterion should be verifiable
  - Run check_command for each criterion if provided
  - Report success only if ALL criteria are met

**Important:**
- Do NOT report success if any verification check fails
- Do NOT modify files that are not listed in the task
- Do NOT introduce new dependencies without explicit approval
- Do NOT leave TODO comments or placeholders in the code`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Executor
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: EXInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		const { task } = input;
		return `You are the Executor (EX) agent.
Execute task ${task.id}: ${task.title}
Files to modify: ${task.files.join(", ") || "None specified"}
Respond with JSON containing success, filesModified, summary, and error (if failed).`;
	}

	/**
	 * Parse the AI response into EXOutput
	 */
	parseOutput(response: string): EXOutput {
		const result = parseExecutionFromResponse(response);
		return {
			success: result.success,
			filesModified: result.filesModified,
			summary: result.summary,
			error: result.error,
		};
	}
}

/**
 * Parse execution result from AI response
 */
export function parseExecutionFromResponse(response: string): ParsedExecutionResult {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createFailedExecution("Failed to extract JSON from execution response");
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedExecution(parsed)) {
			return normalizeExecution(parsed);
		}

		// Return failed result if invalid structure
		return createFailedExecution("Invalid response structure from executor");
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(/\{\s*"success"[\s\S]*?"summary"\s*:\s*"[\s\S]*?"\s*\}/);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedExecution(parsed)) {
					return normalizeExecution(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return failed if parsing fails
		return createFailedExecution("Failed to parse executor response");
	}
}

/**
 * Raw parsed execution from JSON (before normalization)
 */
interface RawParsedExecution {
	success?: boolean;
	filesModified?: unknown[];
	files_modified?: unknown[];
	summary?: string;
	error?: string;
	testsRun?: unknown[];
	tests_run?: unknown[];
	testsPassed?: boolean;
	tests_passed?: boolean;
	commitMessage?: string;
	commit_message?: string;
}

/**
 * Validate parsed execution has required fields
 */
function isValidParsedExecution(data: unknown): data is RawParsedExecution {
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const obj = data as Record<string, unknown>;

	// success is required and must be boolean
	if (typeof obj.success !== "boolean") {
		return false;
	}

	// summary is required and must be string
	if (typeof obj.summary !== "string") {
		return false;
	}

	// filesModified should be an array if present
	const filesModified = obj.filesModified || obj.files_modified;
	if (filesModified !== undefined && !Array.isArray(filesModified)) {
		return false;
	}

	return true;
}

/**
 * Normalize parsed execution (handle both camelCase and snake_case)
 */
function normalizeExecution(parsed: RawParsedExecution): ParsedExecutionResult {
	const filesModifiedRaw = parsed.filesModified || parsed.files_modified || [];
	const testsRunRaw = parsed.testsRun || parsed.tests_run || [];

	return {
		success: parsed.success ?? false,
		filesModified: filesModifiedRaw.filter((f): f is string => typeof f === "string"),
		summary: parsed.summary ?? "",
		error: typeof parsed.error === "string" ? parsed.error : undefined,
		testsRun: testsRunRaw.filter((t): t is string => typeof t === "string"),
		testsPassed: parsed.testsPassed ?? parsed.tests_passed,
		commitMessage: parsed.commitMessage ?? parsed.commit_message,
	};
}

/**
 * Create a failed execution result
 */
function createFailedExecution(error: string): ParsedExecutionResult {
	return {
		success: false,
		filesModified: [],
		summary: "Execution failed",
		error,
	};
}

/**
 * Create an Executor agent with default configuration
 */
export function createExecutorAgent(configOverrides?: Partial<AgentConfig>): ExecutorAgent {
	return new ExecutorAgent(configOverrides);
}

/**
 * Build Executor prompt (standalone utility for backward compatibility)
 */
export function buildExecutorPrompt(task: Task, workDir: string, issue?: Issue): string {
	const agent = new ExecutorAgent();
	return agent.buildPrompt({ task, issue }, workDir);
}

/**
 * Check if execution was successful
 */
export function isExecutionSuccessful(output: EXOutput): boolean {
	return output.success;
}

/**
 * Check if execution had any file modifications
 */
export function hasModifiedFiles(output: EXOutput): boolean {
	return output.filesModified.length > 0;
}

/**
 * Get number of files modified
 */
export function getModifiedFileCount(output: EXOutput): number {
	return output.filesModified.length;
}

/**
 * Check if a specific file was modified
 */
export function wasFileModified(output: EXOutput, filePath: string): boolean {
	return output.filesModified.includes(filePath);
}

/**
 * Get files matching a pattern
 */
export function getModifiedFilesMatching(output: EXOutput, pattern: RegExp): string[] {
	return output.filesModified.filter((f) => pattern.test(f));
}

/**
 * Get files by extension
 */
export function getModifiedFilesByExtension(output: EXOutput, extension: string): string[] {
	const ext = extension.startsWith(".") ? extension : `.${extension}`;
	return output.filesModified.filter((f) => f.endsWith(ext));
}

/**
 * Check if execution has error
 */
export function hasExecutionError(output: EXOutput): boolean {
	return !output.success && !!output.error;
}

/**
 * Get error message (or undefined if no error)
 */
export function getExecutionError(output: EXOutput): string | undefined {
	return output.error;
}

/**
 * Convert execution result to task update for state
 */
export function convertToTaskUpdate(output: EXOutput): {
	status: "done" | "failed";
	error?: string;
	completed_at?: string;
} {
	if (output.success) {
		return {
			status: "done",
			completed_at: new Date().toISOString(),
		};
	}

	return {
		status: "failed",
		error: output.error ?? "Execution failed without specific error",
	};
}

/**
 * Create execution record data from output
 */
export function createExecutionRecordData(
	taskId: string,
	output: EXOutput,
	tokenMetrics?: { inputTokens: number; outputTokens: number },
): {
	task_id: string;
	success: boolean;
	error?: string;
	input_tokens: number;
	output_tokens: number;
	agent_role: string;
} {
	return {
		task_id: taskId,
		success: output.success,
		error: output.error,
		input_tokens: tokenMetrics?.inputTokens ?? 0,
		output_tokens: tokenMetrics?.outputTokens ?? 0,
		agent_role: "EX",
	};
}

/**
 * Validate task is ready for execution
 */
export function validateTaskForExecution(
	task: Task,
	completedTaskIds: string[],
): {
	ready: boolean;
	blockedBy: string[];
} {
	const completedSet = new Set(completedTaskIds);
	const blockedBy = task.depends_on.filter((dep) => !completedSet.has(dep));

	return {
		ready: blockedBy.length === 0,
		blockedBy,
	};
}

/**
 * Check if all acceptance criteria are satisfiable
 * (i.e., all have check_command or are manually verifiable)
 */
export function areAcceptanceCriteriaSatisfiable(criteria: DoDCriteria[]): boolean {
	// All criteria are satisfiable (manually or via check)
	return criteria.every((c) => c.description.length > 0);
}

/**
 * Get criteria with check commands
 */
export function getCriteriaWithCheckCommands(criteria: DoDCriteria[]): DoDCriteria[] {
	return criteria.filter((c) => !!c.check_command);
}

/**
 * Get criteria without check commands (manual verification)
 */
export function getCriteriaWithoutCheckCommands(criteria: DoDCriteria[]): DoDCriteria[] {
	return criteria.filter((c) => !c.check_command);
}

/**
 * Format execution result as markdown for display
 */
export function formatExecutionAsMarkdown(output: EXOutput, task: Task): string {
	const lines: string[] = [];

	lines.push(`## Execution Result: ${task.id}`);
	lines.push("");

	// Status
	const statusEmoji = output.success ? "✅" : "❌";
	lines.push(`**Status**: ${statusEmoji} ${output.success ? "Success" : "Failed"}`);
	lines.push("");

	// Summary
	lines.push("### Summary");
	lines.push(output.summary);
	lines.push("");

	// Files modified
	if (output.filesModified.length > 0) {
		lines.push("### Files Modified");
		for (const file of output.filesModified) {
			lines.push(`- \`${file}\``);
		}
		lines.push("");
	}

	// Error (if any)
	if (output.error) {
		lines.push("### Error");
		lines.push(`\`\`\`\n${output.error}\n\`\`\``);
		lines.push("");
	}

	return lines.join("\n");
}
