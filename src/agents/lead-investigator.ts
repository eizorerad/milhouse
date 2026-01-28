import { getConfigService } from "../services/config/index.ts";
import type { Evidence, Severity } from "../state/types.ts";
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
 * Parsed issue from AI response
 */
interface ParsedIssue {
	symptom: string;
	hypothesis: string;
	severity: Severity;
	frequency?: string;
	blast_radius?: string;
	strategy?: string;
}

/**
 * Lead Investigator Agent
 *
 * Responsible for initial repository scanning to identify potential problems,
 * issues, and technical debt. Produces Problem Brief v0 (UNVALIDATED).
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - List of candidate issues with symptom, hypothesis, severity
 * - Each issue starts as UNVALIDATED
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
				"You are scanning this repository to identify potential problems, issues, or technical debt.",
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
			content: `Scan the repository and identify candidate problems. For each issue found, provide:

1. **Symptom**: What observable behavior indicates a problem?
2. **Hypothesis**: What is the likely root cause?
3. **Severity**: CRITICAL | HIGH | MEDIUM | LOW
4. **Frequency**: How often does this occur? (optional)
5. **Blast Radius**: What is affected if this fails? (optional)
6. **Strategy**: Suggested fix approach (optional)`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with a JSON array of issues in this exact format:

\`\`\`json
[
  {
    "symptom": "Description of the observable problem",
    "hypothesis": "Root cause analysis",
    "severity": "HIGH",
    "frequency": "On every page load",
    "blast_radius": "All user sessions",
    "strategy": "Implement connection pooling"
  }
]
\`\`\`

If no significant issues are found, return an empty array: \`[]\``,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- Focus on real, actionable issues (bugs, technical debt, security concerns, performance problems)
- Do NOT report style preferences or minor nitpicks
- Each issue should be independently fixable
- Be specific about file locations when possible
- Prioritize issues that block functionality or affect users
- Look for: missing error handling, race conditions, security vulnerabilities, performance bottlenecks, deprecated dependencies, missing tests for critical paths
- Status of all issues will be UNVALIDATED (they need probe validation later)
- Do NOT make claims without evidence in the codebase
- Investigate thoroughly before reporting`,
			priority: SECTION_PRIORITIES.guidelines,
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
Scan the repository at ${workDir} for issues and report them as JSON.`;
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
 * Validate parsed issue has required fields
 */
function isValidParsedIssue(issue: unknown): issue is ParsedIssue {
	if (typeof issue !== "object" || issue === null) {
		return false;
	}

	const obj = issue as Record<string, unknown>;

	if (typeof obj.symptom !== "string" || obj.symptom.trim() === "") {
		return false;
	}

	if (typeof obj.hypothesis !== "string" || obj.hypothesis.trim() === "") {
		return false;
	}

	return true;
}

/**
 * Normalize parsed issue to LIOutput issue format
 */
function normalizeIssue(issue: ParsedIssue): LIOutput["issues"][number] {
	const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
	const severity = validSeverities.includes(issue.severity as (typeof validSeverities)[number])
		? (issue.severity as (typeof validSeverities)[number])
		: "MEDIUM";

	return {
		symptom: issue.symptom,
		hypothesis: issue.hypothesis,
		severity,
		frequency: issue.frequency,
		blast_radius: issue.blast_radius,
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
 * Convert LIOutput issues to Issue-compatible format for state storage
 */
export function convertToIssueData(issue: LIOutput["issues"][number]): {
	symptom: string;
	hypothesis: string;
	severity: Severity;
	frequency?: string;
	blast_radius?: string;
	strategy?: string;
	status: "UNVALIDATED";
	evidence: Evidence[];
	related_task_ids: string[];
} {
	return {
		symptom: issue.symptom,
		hypothesis: issue.hypothesis,
		severity: issue.severity,
		frequency: issue.frequency,
		blast_radius: issue.blast_radius,
		strategy: issue.strategy,
		status: "UNVALIDATED",
		evidence: [],
		related_task_ids: [],
	};
}
