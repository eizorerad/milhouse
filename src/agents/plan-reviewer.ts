import { getConfigService } from "../services/config/index.ts";
import type { Issue, Task } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type PRInput,
	type PROutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Review concern severity
 */
export type ReviewSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/**
 * Parsed review issue from AI response
 */
interface ParsedReviewIssue {
	taskTitle: string;
	concern: string;
	severity: ReviewSeverity;
	suggestion: string;
}

/**
 * Parsed review result from AI response
 */
interface ParsedReview {
	approved: boolean;
	issues: ParsedReviewIssue[];
	feedback?: string;
}

/**
 * Plan Reviewer Agent
 *
 * Responsible for reviewing Work Breakdown Structure (WBS) plans before execution.
 * Validates task quality, acceptance criteria, dependencies, and overall feasibility.
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - Approval status (approved/rejected)
 * - List of concerns with severity and suggestions
 * - Overall feedback
 */
export class PlanReviewerAgent extends BaseAgent<PRInput, PROutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("PR", configOverrides);
	}

	/**
	 * Build prompt sections for the Plan Reviewer
	 */
	protected buildPromptSections(input: PRInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const { issue, tasks, wbsContent } = input;

		// Role section
		sections.push(
			createRoleSection(
				"PR",
				"You are reviewing a Work Breakdown Structure (WBS) plan to ensure quality, completeness, and correctness before execution.",
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
			`**Severity**: ${issue.severity}`,
		];

		if (issue.corrected_description) {
			issueDetails.push(`**Corrected Description**: ${issue.corrected_description}`);
		}

		sections.push({
			type: "input",
			header: "Issue Being Addressed",
			content: issueDetails.join("\n"),
			priority: SECTION_PRIORITIES.input,
		});

		// Tasks section
		const tasksList = tasks
			.map((task, index) => {
				const taskLines = [
					`### Task ${index + 1}: ${task.title}`,
					task.description ? `**Description**: ${task.description}` : "",
					`**Files**: ${task.files.length > 0 ? task.files.join(", ") : "None specified"}`,
					`**Dependencies**: ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "None"}`,
					`**Checks**: ${task.checks.length > 0 ? task.checks.join(", ") : "None"}`,
				].filter(Boolean);

				if (task.acceptance && task.acceptance.length > 0) {
					taskLines.push("**Acceptance Criteria**:");
					for (const ac of task.acceptance) {
						const checkCmd = ac.check_command ? ` (check: \`${ac.check_command}\`)` : "";
						taskLines.push(`  - ${ac.description}${checkCmd}`);
					}
				}

				if (task.risk) {
					taskLines.push(`**Risk**: ${task.risk}`);
				}
				if (task.rollback) {
					taskLines.push(`**Rollback**: ${task.rollback}`);
				}

				return taskLines.join("\n");
			})
			.join("\n\n");

		sections.push({
			type: "input",
			header: "Tasks to Review",
			content: tasksList,
			priority: SECTION_PRIORITIES.input + 1,
		});

		// WBS Content section (if provided and different from task list)
		if (wbsContent && wbsContent.trim().length > 0) {
			sections.push({
				type: "input",
				header: "WBS Document",
				content: wbsContent,
				priority: SECTION_PRIORITIES.input + 2,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Review Task",
			content: `Review the WBS plan and evaluate:

1. **Completeness**: Does the plan fully address the issue?
2. **Task Quality**: Are tasks well-defined, small, and testable?
3. **Acceptance Criteria**: Are criteria specific, measurable, and verifiable?
4. **Dependencies**: Are dependencies correctly identified and ordered?
5. **Risk Assessment**: Are risks identified with mitigation strategies?
6. **Feasibility**: Is the plan practical and implementable?
7. **Coverage**: Does each task have appropriate checks and verification?

Flag any concerns that could lead to:
- Incomplete fixes
- Regressions
- Unclear completion criteria
- Blocked execution due to missing dependencies`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "approved": true | false,
  "issues": [
    {
      "taskTitle": "Title of the task with the issue",
      "concern": "Clear description of the concern",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "suggestion": "How to fix this issue"
    }
  ],
  "feedback": "Overall assessment and recommendations"
}
\`\`\`

**Field Descriptions:**
- **approved**: Set to false if any CRITICAL or HIGH issues exist
- **issues**: Array of specific concerns found during review
  - **taskTitle**: Which task has the issue (or "General" for overall issues)
  - **concern**: Clear description of what's wrong
  - **severity**: Impact level of the issue
  - **suggestion**: Actionable fix for the concern
- **feedback**: Overall assessment, positive observations, and recommendations

**Severity Guidelines:**
- **CRITICAL**: Will prevent task completion or cause serious regressions
- **HIGH**: Likely to cause problems during execution
- **MEDIUM**: Could cause minor issues, should be addressed
- **LOW**: Suggestions for improvement, not blocking`,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Review Guidelines",
			content: `- **Be Constructive**: Provide actionable suggestions, not just criticism
- **Be Specific**: Reference specific tasks by title when raising concerns
- **Focus on Impact**: Prioritize issues that affect correctness and completeness
- **Consider Context**: Account for project-specific practices and constraints
- **Approve When Ready**: If the plan is good enough to proceed, approve it
- **Flag Blockers**: CRITICAL and HIGH issues should prevent approval

**Common Issues to Check:**
- Tasks without acceptance criteria
- Vague or unmeasurable success criteria
- Missing dependency declarations
- Tasks that are too broad or too small
- Missing test coverage considerations
- Unclear file scope (which files will be modified)
- Missing rollback strategies for risky changes
- Circular or incorrect dependencies`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Plan Reviewer
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: PRInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		const { issue, tasks } = input;
		return `You are the Plan Reviewer (PR) agent.
Review the WBS plan for issue ${issue.id}: ${issue.symptom}
Tasks: ${tasks.map((t) => t.title).join(", ")}
Respond with JSON containing approved, issues array, and feedback.`;
	}

	/**
	 * Parse the AI response into PROutput
	 */
	parseOutput(response: string): PROutput {
		const review = parseReviewFromResponse(response);
		return {
			approved: review.approved,
			issues: review.issues.map((i) => ({
				taskTitle: i.taskTitle,
				concern: i.concern,
				severity: i.severity,
				suggestion: i.suggestion,
			})),
			feedback: review.feedback,
		};
	}
}

/**
 * Parse review result from AI response
 */
export function parseReviewFromResponse(response: string): ParsedReview {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createDefaultReview(false, "Failed to extract JSON from review response");
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedReview(parsed)) {
			return normalizeReview(parsed);
		}

		// Return default rejected review if invalid structure
		return createDefaultReview(false, "Failed to parse review response");
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(/\{\s*"approved"[\s\S]*?"issues"\s*:\s*\[[\s\S]*?\]\s*\}/);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedReview(parsed)) {
					return normalizeReview(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return default if parsing fails
		return createDefaultReview(false, "Failed to parse review response");
	}
}

/**
 * Validate parsed review has required fields
 */
function isValidParsedReview(review: unknown): review is ParsedReview {
	if (typeof review !== "object" || review === null) {
		return false;
	}

	const obj = review as Record<string, unknown>;

	if (typeof obj.approved !== "boolean") {
		return false;
	}

	if (!Array.isArray(obj.issues)) {
		return false;
	}

	// Validate each issue has required fields
	for (const issue of obj.issues) {
		if (!isValidParsedIssue(issue)) {
			return false;
		}
	}

	return true;
}

/**
 * Validate a parsed review issue
 */
function isValidParsedIssue(issue: unknown): issue is ParsedReviewIssue {
	if (typeof issue !== "object" || issue === null) {
		return false;
	}

	const obj = issue as Record<string, unknown>;

	// All fields are required
	if (typeof obj.taskTitle !== "string" || obj.taskTitle.trim() === "") {
		return false;
	}

	if (typeof obj.concern !== "string" || obj.concern.trim() === "") {
		return false;
	}

	if (typeof obj.severity !== "string") {
		return false;
	}

	if (typeof obj.suggestion !== "string") {
		return false;
	}

	return true;
}

/**
 * Normalize parsed review
 */
function normalizeReview(parsed: ParsedReview): ParsedReview {
	return {
		approved: parsed.approved,
		issues: parsed.issues.map(normalizeReviewIssue),
		feedback: typeof parsed.feedback === "string" ? parsed.feedback : undefined,
	};
}

/**
 * Normalize a parsed review issue
 */
function normalizeReviewIssue(issue: ParsedReviewIssue): ParsedReviewIssue {
	return {
		taskTitle: issue.taskTitle.trim(),
		concern: issue.concern.trim(),
		severity: isValidSeverity(issue.severity) ? issue.severity : "MEDIUM",
		suggestion: issue.suggestion.trim(),
	};
}

/**
 * Type guard for valid severity
 */
export function isValidSeverity(severity: string): severity is ReviewSeverity {
	return ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(severity);
}

/**
 * Create default review result
 */
function createDefaultReview(approved: boolean, feedback: string): ParsedReview {
	return {
		approved,
		issues: [],
		feedback,
	};
}

/**
 * Create a Plan Reviewer agent with default configuration
 */
export function createPlanReviewerAgent(configOverrides?: Partial<AgentConfig>): PlanReviewerAgent {
	return new PlanReviewerAgent(configOverrides);
}

/**
 * Build Plan Reviewer prompt (standalone utility for backward compatibility)
 */
export function buildPlanReviewerPrompt(
	issue: Issue,
	tasks: Task[],
	wbsContent: string,
	workDir: string,
): string {
	const agent = new PlanReviewerAgent();
	return agent.buildPrompt({ issue, tasks, wbsContent }, workDir);
}

/**
 * Check if review has blocking issues
 */
export function hasBlockingIssues(output: PROutput): boolean {
	return output.issues.some((i) => i.severity === "CRITICAL" || i.severity === "HIGH");
}

/**
 * Get issues by severity
 */
export function getIssuesBySeverity(
	output: PROutput,
	severity: ReviewSeverity,
): PROutput["issues"] {
	return output.issues.filter((i) => i.severity === severity);
}

/**
 * Get critical issues
 */
export function getCriticalIssues(output: PROutput): PROutput["issues"] {
	return getIssuesBySeverity(output, "CRITICAL");
}

/**
 * Get high severity issues
 */
export function getHighIssues(output: PROutput): PROutput["issues"] {
	return getIssuesBySeverity(output, "HIGH");
}

/**
 * Count issues by severity
 */
export function countIssuesBySeverity(output: PROutput): Record<ReviewSeverity, number> {
	return {
		CRITICAL: getIssuesBySeverity(output, "CRITICAL").length,
		HIGH: getIssuesBySeverity(output, "HIGH").length,
		MEDIUM: getIssuesBySeverity(output, "MEDIUM").length,
		LOW: getIssuesBySeverity(output, "LOW").length,
	};
}

/**
 * Get total issue count
 */
export function getTotalIssueCount(output: PROutput): number {
	return output.issues.length;
}

/**
 * Check if plan was approved
 */
export function isPlanApproved(output: PROutput): boolean {
	return output.approved;
}

/**
 * Get issues for a specific task
 */
export function getIssuesForTask(output: PROutput, taskTitle: string): PROutput["issues"] {
	return output.issues.filter((i) => i.taskTitle.toLowerCase() === taskTitle.toLowerCase());
}

/**
 * Get general issues (not specific to any task)
 */
export function getGeneralIssues(output: PROutput): PROutput["issues"] {
	return output.issues.filter((i) => i.taskTitle.toLowerCase() === "general");
}

/**
 * Format review as markdown for display
 */
export function formatReviewAsMarkdown(output: PROutput): string {
	const lines: string[] = [];

	// Status header
	const statusEmoji = output.approved ? "✅" : "❌";
	lines.push(`## Plan Review: ${statusEmoji} ${output.approved ? "Approved" : "Rejected"}`);
	lines.push("");

	// Feedback
	if (output.feedback) {
		lines.push("### Feedback");
		lines.push("");
		lines.push(output.feedback);
		lines.push("");
	}

	// Issues
	if (output.issues.length > 0) {
		lines.push("### Issues Found");
		lines.push("");

		const severityOrder: ReviewSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
		for (const severity of severityOrder) {
			const issuesForSeverity = getIssuesBySeverity(output, severity);
			if (issuesForSeverity.length > 0) {
				lines.push(`#### ${severity}`);
				lines.push("");
				for (const issue of issuesForSeverity) {
					lines.push(`- **${issue.taskTitle}**: ${issue.concern}`);
					lines.push(`  - *Suggestion*: ${issue.suggestion}`);
				}
				lines.push("");
			}
		}
	} else {
		lines.push("### No Issues Found");
		lines.push("");
		lines.push("The plan meets all review criteria.");
	}

	return lines.join("\n");
}
