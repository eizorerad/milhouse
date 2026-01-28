import { getConfigService } from "../services/config/index.ts";
import type { Evidence, Issue, IssueStatus } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type IVInput,
	type IVOutput,
	type PromptSection,
	SECTION_PRIORITIES,
	createRoleSection,
} from "./types.ts";

/**
 * Valid validation status (excludes UNVALIDATED)
 */
type ValidationStatus = "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED";

/**
 * Parsed validation result from AI response
 */
interface ParsedValidation {
	issue_id: string;
	status: ValidationStatus;
	corrected_description?: string;
	evidence: Evidence[];
	notes?: string;
}

/**
 * Issue Validator Agent
 *
 * Responsible for validating issues identified by the Lead Investigator.
 * Confirms or refutes each issue with concrete evidence.
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute shell commands for inspection (probes)
 * - Cannot write files or create branches/commits/PRs
 *
 * Output:
 * - Validation status: CONFIRMED, FALSE, PARTIAL, MISDIAGNOSED
 * - Evidence supporting the validation
 * - Corrected description if misdiagnosed
 */
export class IssueValidatorAgent extends BaseAgent<IVInput, IVOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("IV", configOverrides);
	}

	/**
	 * Build prompt sections for the Issue Validator
	 */
	protected buildPromptSections(input: IVInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];

		// Role section
		sections.push(
			createRoleSection(
				"IV",
				"You are validating a specific issue identified by the Lead Investigator. Your task is to confirm or refute this issue with concrete evidence.",
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
		const issue = input.issue;
		const issueDetails = [
			`**ID**: ${issue.id}`,
			`**Symptom**: ${issue.symptom}`,
			`**Hypothesis**: ${issue.hypothesis}`,
			`**Severity**: ${issue.severity}`,
		];

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
			header: "Issue to Validate",
			content: issueDetails.join("\n"),
			priority: SECTION_PRIORITIES.input,
		});

		// Add existing evidence if provided
		if (input.evidence && input.evidence.length > 0) {
			const evidenceList = input.evidence
				.map((ev) => {
					if (ev.type === "file" && ev.file) {
						return `- File: ${ev.file}${ev.line_start ? `:${ev.line_start}` : ""}`;
					}
					if (ev.type === "command" && ev.command) {
						return `- Command: ${ev.command}`;
					}
					if (ev.type === "probe" && ev.probe_id) {
						return `- Probe: ${ev.probe_id}`;
					}
					return `- ${ev.type}`;
				})
				.join("\n");

			sections.push({
				type: "context",
				header: "Existing Evidence",
				content: evidenceList,
				priority: SECTION_PRIORITIES.context + 1,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Task",
			content: `Investigate this issue thoroughly and determine its validity.

1. Search for evidence in the codebase (file:line references)
2. Run any necessary probes or checks to verify claims
3. Determine the issue status:
   - **CONFIRMED**: Issue exists as described with evidence
   - **FALSE**: Issue does not exist or is a false positive
   - **PARTIAL**: Issue exists but scope/severity differs
   - **MISDIAGNOSED**: Real problem exists but with different root cause`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		const timestamp = new Date().toISOString();
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "status": "CONFIRMED|FALSE|PARTIAL|MISDIAGNOSED",
  "corrected_description": "Only if PARTIAL or MISDIAGNOSED - describe the actual issue",
  "evidence": [
    {
      "type": "file|probe|log|command",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 50,
      "output": "Relevant output or code snippet",
      "timestamp": "${timestamp}"
    }
  ],
  "notes": "Optional additional notes about the validation"
}
\`\`\``,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- Provide at least ONE piece of evidence for any non-FALSE status
- For FALSE status, explain why the issue doesn't exist
- Be specific about file paths and line numbers
- Run actual commands if needed to verify (e.g., run tests, check configs)
- Do NOT claim evidence without actual file references
- If the hypothesis is wrong but there's a related real issue, mark as MISDIAGNOSED
- Include the corrected_description for PARTIAL or MISDIAGNOSED issues
- All evidence must have timestamps`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Issue Validator
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: IVInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		return `You are the Issue Validator (IV) agent.
Validate issue ${input.issue.id}: ${input.issue.symptom}
Hypothesis: ${input.issue.hypothesis}
Respond with JSON containing status and evidence.`;
	}

	/**
	 * Parse the AI response into IVOutput
	 */
	parseOutput(response: string): IVOutput {
		const validation = parseValidationFromResponse(response);
		return {
			status: validation.status,
			evidence: validation.evidence,
			correctedDescription: validation.corrected_description,
			notes: validation.notes,
		};
	}
}

/**
 * Parse validation result from AI response
 */
export function parseValidationFromResponse(response: string): ParsedValidation {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createDefaultValidation("FALSE", "Failed to extract JSON from validation response");
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedValidation(parsed)) {
			return normalizeValidation(parsed);
		}

		// Return default FALSE if invalid structure
		return createDefaultValidation("FALSE", "Failed to parse validation response");
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(/\{[\s\S]*"status"\s*:\s*"[^"]+[\s\S]*\}/);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedValidation(parsed)) {
					return normalizeValidation(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return default if parsing fails
		return createDefaultValidation("FALSE", "Failed to parse validation response");
	}
}

/**
 * Validate parsed validation has required fields
 */
function isValidParsedValidation(validation: unknown): validation is ParsedValidation {
	if (typeof validation !== "object" || validation === null) {
		return false;
	}

	const obj = validation as Record<string, unknown>;

	// Status is required and must be valid
	if (!isValidIssueStatus(obj.status)) {
		return false;
	}

	// Evidence should be an array if present
	if (obj.evidence !== undefined && !Array.isArray(obj.evidence)) {
		return false;
	}

	return true;
}

/**
 * Normalize parsed validation
 */
function normalizeValidation(parsed: ParsedValidation): ParsedValidation {
	const timestamp = new Date().toISOString();

	// Ensure evidence array with timestamps
	const evidence: Evidence[] = Array.isArray(parsed.evidence)
		? parsed.evidence.map((ev) => ({
				...ev,
				type: isValidEvidenceType(ev.type) ? ev.type : "file",
				timestamp: ev.timestamp || timestamp,
			}))
		: [];

	return {
		issue_id: typeof parsed.issue_id === "string" ? parsed.issue_id : "",
		status: parsed.status,
		corrected_description: parsed.corrected_description,
		evidence,
		notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
	};
}

/**
 * Create default validation result
 */
function createDefaultValidation(status: ValidationStatus, notes?: string): ParsedValidation {
	return {
		issue_id: "",
		status,
		evidence: [],
		notes,
	};
}

/**
 * Validate evidence type
 */
function isValidEvidenceType(type: unknown): type is Evidence["type"] {
	return typeof type === "string" && ["file", "probe", "log", "command"].includes(type);
}

/**
 * Validate issue status
 */
export function isValidIssueStatus(status: unknown): status is IssueStatus {
	return (
		typeof status === "string" &&
		["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED", "UNVALIDATED"].includes(status)
	);
}

/**
 * Validate issue status (excluding UNVALIDATED for validation results)
 */
export function isValidValidationStatus(
	status: unknown,
): status is "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED" {
	return (
		typeof status === "string" && ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"].includes(status)
	);
}

/**
 * Create an Issue Validator agent with default configuration
 */
export function createIssueValidatorAgent(
	configOverrides?: Partial<AgentConfig>,
): IssueValidatorAgent {
	return new IssueValidatorAgent(configOverrides);
}

/**
 * Build Issue Validator prompt (standalone utility for backward compatibility)
 */
export function buildIssueValidatorPrompt(
	issue: Issue,
	workDir: string,
	evidence?: Evidence[],
): string {
	const agent = new IssueValidatorAgent();
	return agent.buildPrompt({ issue, evidence }, workDir);
}

/**
 * Convert IVOutput to issue update data for state storage
 */
export function convertToIssueUpdate(output: IVOutput): {
	status: IssueStatus;
	corrected_description?: string;
	evidence: Evidence[];
	validated_by: string;
} {
	return {
		status: output.status,
		corrected_description: output.correctedDescription,
		evidence: output.evidence,
		validated_by: "IV",
	};
}

/**
 * Check if validation confirms the issue (CONFIRMED or PARTIAL)
 */
export function isIssueConfirmed(output: IVOutput): boolean {
	return output.status === "CONFIRMED" || output.status === "PARTIAL";
}

/**
 * Check if validation refutes the issue (FALSE)
 */
export function isIssueRefuted(output: IVOutput): boolean {
	return output.status === "FALSE";
}

/**
 * Check if issue needs correction (MISDIAGNOSED)
 */
export function isIssueMisdiagnosed(output: IVOutput): boolean {
	return output.status === "MISDIAGNOSED";
}

/**
 * Get validation severity for logging/reporting
 */
export function getValidationSeverity(output: IVOutput): "success" | "warning" | "error" | "info" {
	switch (output.status) {
		case "CONFIRMED":
			return "success";
		case "PARTIAL":
		case "MISDIAGNOSED":
			return "warning";
		case "FALSE":
			return "info";
		default:
			return "error";
	}
}
