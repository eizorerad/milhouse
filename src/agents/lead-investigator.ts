import { getConfigService } from "../services/config/index.ts";
import type { Evidence, Severity, WorkItemType } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type LIInput,
	type LIOutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Parsed work item from AI response
 */
interface ParsedIssue {
	type?: WorkItemType;
	title?: string;
	rationale?: string;
	symptom?: string;
	hypothesis?: string;
	severity: Severity;
	frequency?: string;
	blast_radius?: string;
	scope_impact?: string;
	strategy?: string;
}

/**
 * Lead Investigator Agent
 *
 * Responsible for initial repository analysis to identify work items.
 * Supports all work types: bugs, features, refactoring, improvements, tasks.
 * Produces Work Brief v0 (UNVALIDATED).
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - List of candidate work items with title, rationale, type, severity
 * - Each work item starts as UNVALIDATED
 */
export class LeadInvestigatorAgent extends BaseAgent<LIInput, LIOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("LI", configOverrides);
	}

	/**
	 * Build prompt sections for the Lead Investigator
	 */
	protected buildPromptSections(input: LIInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];

		// Role section
		sections.push(
			createRoleSection(
				"LI",
				"You are analyzing this repository to identify work items. Work items can be bugs, features, refactoring opportunities, improvements, or general tasks. Determine the intent from the scope and produce appropriate work items.",
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

		// Add scope if specified
		if (input.scope && input.scope.length > 0) {
			contextParts.push(`Focus areas: ${input.scope.join(", ")}`);
		}

		// Add additional context if provided
		if (input.context) {
			contextParts.push(input.context);
		}

		if (contextParts.length > 0) {
			sections.push({
				type: "context",
				header: "Project Context",
				content: contextParts.join("\n\n"),
				priority: SECTION_PRIORITIES.context,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Task",
			content: `Analyze the repository and identify work items based on the scope. For each work item, provide:

1. **Type**: bug | feature | refactor | improvement | task
2. **Title**: Clear, concise title describing the work item
3. **Rationale**: Why this work is needed (root cause for bugs, justification for features, etc.)
4. **Severity**: CRITICAL | HIGH | MEDIUM | LOW (priority level)
5. **Scope Impact**: What areas of the codebase are affected (optional)
6. **Strategy**: Suggested implementation approach (optional)

If the scope describes a specific task (e.g. "add dark mode", "refactor auth module"), create work items that break down that task.
If the scope describes an area to investigate (e.g. "authentication bugs", "performance issues"), scan for problems in that area.
If no scope is given, scan for bugs, technical debt, and improvement opportunities.`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with a JSON array of work items in this exact format:

\`\`\`json
[
  {
    "type": "bug",
    "title": "Clear title describing the work item",
    "rationale": "Why this work is needed - root cause, justification, or analysis",
    "severity": "HIGH",
    "scope_impact": "Components or areas affected",
    "strategy": "Suggested implementation approach"
  }
]
\`\`\`

Valid types: bug, feature, refactor, improvement, task.

If no significant work items are found, return an empty array: \`[]\``,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- Focus on real, actionable work items (bugs, features, refactoring, improvements, tasks)
- Do NOT report style preferences or minor nitpicks
- Each work item should be independently actionable
- Be specific about file locations when possible
- Prioritize work items by impact and feasibility
- For bugs: look for missing error handling, race conditions, security vulnerabilities, performance bottlenecks
- For features/tasks: analyze existing code structure, identify integration points, assess prerequisites
- For refactoring: identify code duplication, tight coupling, architectural issues
- All work items start as UNVALIDATED (they need validation later)
- Do NOT make claims without evidence in the codebase
- Investigate thoroughly before reporting`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		// Critical: force JSON output as the very last instruction
		// Claude in agent mode tends to write prose summaries instead of JSON.
		// This section has the highest priority (appears last) to reinforce the format.
		sections.push({
			type: "output",
			header: "CRITICAL: Response Format Requirement",
			content: `Your FINAL response MUST be a JSON array wrapped in a \`\`\`json code block.
Do NOT respond with a text summary. Do NOT respond with markdown prose.
After you finish investigating, output ONLY a \`\`\`json code block containing the array of work items.

Example of CORRECT final response:

\`\`\`json
[
  {"type": "bug", "title": "...", "rationale": "...", "severity": "HIGH", "scope_impact": "...", "strategy": "..."}
]
\`\`\`

If you found no issues, respond with:

\`\`\`json
[]
\`\`\`

Do NOT include any text before or after the JSON code block in your final response.`,
			priority: 100, // Higher than any other section
		});

		return sections;
	}

	/**
	 * Build the prompt for the Lead Investigator
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: LIInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		return `You are the Lead Investigator (LI) agent.
Analyze the repository at ${workDir} for work items (bugs, features, refactoring, improvements) and report them as JSON.`;
	}

	/**
	 * Parse the AI response into LIOutput
	 */
	parseOutput(response: string): LIOutput {
		const issues = parseIssuesFromResponse(response);
		return { issues };
	}
}

/**
 * Parse issues from AI response
 */
export function parseIssuesFromResponse(response: string): LIOutput["issues"] {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return [];
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (!Array.isArray(parsed)) {
			// Wrap single object in array
			return [parsed].filter(isValidParsedIssue).map(normalizeIssue);
		}

		return parsed.filter(isValidParsedIssue).map(normalizeIssue);
	} catch {
		// Try to find JSON array in the response
		const arrayMatch = response.match(/\[\s*\{[\s\S]*?\}\s*\]/);
		if (arrayMatch) {
			try {
				const parsed = JSON.parse(arrayMatch[0]);
				return parsed.filter(isValidParsedIssue).map(normalizeIssue);
			} catch {
				// Fall through
			}
		}

		return [];
	}
}

/**
 * Validate parsed work item has required fields.
 * Accepts both new format (title/rationale) and legacy format (symptom/hypothesis).
 */
function isValidParsedIssue(issue: unknown): issue is ParsedIssue {
	if (typeof issue !== "object" || issue === null) {
		return false;
	}

	const obj = issue as Record<string, unknown>;

	// Accept new format (title/rationale) or legacy format (symptom/hypothesis)
	const hasTitle = typeof obj.title === "string" && obj.title.trim() !== "";
	const hasSymptom = typeof obj.symptom === "string" && obj.symptom.trim() !== "";
	if (!hasTitle && !hasSymptom) {
		return false;
	}

	const hasRationale = typeof obj.rationale === "string" && obj.rationale.trim() !== "";
	const hasHypothesis = typeof obj.hypothesis === "string" && obj.hypothesis.trim() !== "";
	if (!hasRationale && !hasHypothesis) {
		return false;
	}

	return true;
}

/**
 * Normalize parsed work item to LIOutput format.
 * Supports both new (title/rationale) and legacy (symptom/hypothesis) formats.
 */
function normalizeIssue(issue: ParsedIssue): LIOutput["issues"][number] {
	const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
	const severity = validSeverities.includes(issue.severity as (typeof validSeverities)[number])
		? (issue.severity as (typeof validSeverities)[number])
		: "MEDIUM";

	const validTypes = ["bug", "feature", "refactor", "improvement", "task"] as const;
	const type = issue.type && validTypes.includes(issue.type as (typeof validTypes)[number])
		? (issue.type as (typeof validTypes)[number])
		: undefined;

	// Use title/rationale if available, fall back to symptom/hypothesis
	const title = issue.title ?? issue.symptom;
	const rationale = issue.rationale ?? issue.hypothesis;

	return {
		type,
		title,
		rationale,
		// Keep symptom/hypothesis populated for backward compat
		symptom: title ?? "",
		hypothesis: rationale ?? "",
		severity,
		frequency: issue.frequency,
		blast_radius: issue.blast_radius,
		scope_impact: issue.scope_impact,
		strategy: issue.strategy,
	};
}

/**
 * Validate severity is a valid value
 */
export function isValidSeverity(severity: unknown): severity is Severity {
	return typeof severity === "string" && ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(severity);
}

/**
 * Create a Lead Investigator agent with default configuration
 */
export function createLeadInvestigatorAgent(
	configOverrides?: Partial<AgentConfig>,
): LeadInvestigatorAgent {
	return new LeadInvestigatorAgent(configOverrides);
}

/**
 * Build Lead Investigator prompt (standalone utility for backward compatibility)
 */
export function buildLeadInvestigatorPrompt(workDir: string, input?: LIInput): string {
	const agent = new LeadInvestigatorAgent();
	return agent.buildPrompt(input ?? {}, workDir);
}

/**
 * Convert LIOutput work items to Issue-compatible format for state storage
 */
export function convertToIssueData(issue: LIOutput["issues"][number]): {
	type: string;
	title?: string;
	rationale?: string;
	symptom: string;
	hypothesis: string;
	severity: Severity;
	frequency?: string;
	blast_radius?: string;
	scope_impact?: string;
	strategy?: string;
	status: "UNVALIDATED";
	evidence: Evidence[];
	related_task_ids: string[];
} {
	return {
		type: issue.type ?? "bug",
		title: issue.title,
		rationale: issue.rationale,
		symptom: issue.symptom,
		hypothesis: issue.hypothesis,
		severity: issue.severity,
		frequency: issue.frequency,
		blast_radius: issue.blast_radius,
		scope_impact: issue.scope_impact,
		strategy: issue.strategy,
		status: "UNVALIDATED",
		evidence: [],
		related_task_ids: [],
	};
}
