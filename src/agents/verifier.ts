import { getConfigService } from "../services/config/index.ts";
import type { Evidence, Task } from "../state/types.ts";
import { extractJsonFromResponse } from "../utils/json-extractor.ts";
import { BaseAgent } from "./base.ts";
import {
	type AgentConfig,
	type PromptSection,
	SECTION_PRIORITIES,
	type TVInput,
	type TVOutput,
	createRoleSection,
} from "./types.ts";

/**
 * Gate names for verification
 */
export type GateName = "evidence" | "diffHygiene" | "placeholder" | "envConsistency" | "dod";

/**
 * Gate descriptions
 */
export const GATE_DESCRIPTIONS: Record<GateName, string> = {
	evidence: "Evidence Gate - No claims without proof",
	diffHygiene: "Diff Hygiene Gate - No silent refactors",
	placeholder: "Placeholder Gate - No TODO/mock/stubs",
	envConsistency: "Environment Consistency Gate - Probes required for infra issues",
	dod: "Definition of Done Gate - All acceptance criteria verifiable",
};

/**
 * Parsed verification result from AI response
 */
interface ParsedVerificationResult {
	overallPass: boolean;
	gates: Array<{
		name: string;
		passed: boolean;
		message?: string;
		evidence?: Evidence[];
	}>;
	recommendations: string[];
	regressionsFound?: boolean;
	summary?: string;
}

/**
 * Truth Verifier Agent (TV)
 *
 * Responsible for verifying execution results and ensuring quality gates pass.
 * Blocks claims without evidence and ensures no placeholders remain.
 *
 * Capabilities:
 * - Read files from the repository
 * - Execute verification commands
 * - Cannot write files or create commits
 *
 * Output:
 * - Overall pass/fail status
 * - Individual gate results
 * - Recommendations for improvement
 */
export class VerifierAgent extends BaseAgent<TVInput, TVOutput> {
	constructor(configOverrides?: Partial<AgentConfig>) {
		super("TV", configOverrides);
	}

	/**
	 * Build prompt sections for the Truth Verifier
	 */
	protected buildPromptSections(input: TVInput, workDir: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const { completedTasks, failedTasks, preCheckIssues } = input;

		// Role section
		sections.push(
			createRoleSection(
				"TV",
				"You are verifying the execution results of completed tasks. Your job is to ensure all changes are legitimate, complete, and meet quality standards. You are a gate that blocks incomplete or unverified work.",
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

		// Execution summary section
		const summaryLines = [
			`**Completed Tasks**: ${completedTasks.length}`,
			`**Failed Tasks**: ${failedTasks.length}`,
			`**Total Tasks**: ${completedTasks.length + failedTasks.length}`,
		];

		sections.push({
			type: "input",
			header: "Execution Summary",
			content: summaryLines.join("\n"),
			priority: SECTION_PRIORITIES.input,
		});

		// Completed tasks section
		if (completedTasks.length > 0) {
			const taskList = completedTasks
				.map((t) => {
					const lines = [`- **${t.id}**: ${t.title}`];
					if (t.files.length > 0) {
						lines.push(`  - Files: ${t.files.join(", ")}`);
					}
					if (t.acceptance.length > 0) {
						const verified = t.acceptance.filter((a) => a.verified).length;
						lines.push(`  - Acceptance: ${verified}/${t.acceptance.length} verified`);
					}
					return lines.join("\n");
				})
				.join("\n");

			sections.push({
				type: "input",
				header: "Completed Tasks",
				content: taskList,
				priority: SECTION_PRIORITIES.input + 1,
			});
		}

		// Failed tasks section
		if (failedTasks.length > 0) {
			const taskList = failedTasks
				.map((t) => {
					const lines = [`- **${t.id}**: ${t.title}`];
					if (t.error) {
						lines.push(`  - Error: ${t.error}`);
					}
					return lines.join("\n");
				})
				.join("\n");

			sections.push({
				type: "input",
				header: "Failed Tasks",
				content: taskList,
				priority: SECTION_PRIORITIES.input + 2,
			});
		}

		// Pre-check issues section
		if (preCheckIssues.length > 0) {
			const issueList = preCheckIssues
				.map((i) => `- **[${i.severity.toUpperCase()}]** ${i.gate}: ${i.message}`)
				.join("\n");

			sections.push({
				type: "input",
				header: "Pre-check Issues Found",
				content: `The following issues were detected by automated gates:\n\n${issueList}`,
				priority: SECTION_PRIORITIES.input + 3,
			});
		}

		// Task section
		sections.push({
			type: "task",
			header: "Verification Task",
			content: `Verify the execution results by:

1. **Review** the completed tasks and verify their implementation
2. **Check** that all acceptance criteria are met
3. **Verify** no regressions were introduced
4. **Confirm** all tests pass
5. **Ensure** no placeholder code remains

Gates to evaluate:
- **Evidence Gate**: All claims must have proof (file:lines or probe_id)
- **Diff Hygiene Gate**: No silent refactors or extra files
- **Placeholder Gate**: No TODO/FIXME/mock/stub code
- **Env Consistency Gate**: Infrastructure issues require probes
- **DoD Gate**: All acceptance criteria must be verifiable`,
			priority: SECTION_PRIORITIES.task,
		});

		// Output format section
		sections.push({
			type: "output",
			header: "Output Format",
			content: `Respond with JSON in this exact format:

\`\`\`json
{
  "overall_pass": true|false,
  "gates": [
    {
      "name": "evidence|diffHygiene|placeholder|envConsistency|dod",
      "passed": true|false,
      "message": "Description of findings",
      "evidence": []
    }
  ],
  "recommendations": ["List of recommendations if any"],
  "regressions_found": false,
  "summary": "Brief summary of verification results"
}
\`\`\`

**Field Descriptions:**
- **overall_pass**: Whether all gates passed (true only if ALL gates pass)
- **gates**: Array of individual gate results
- **recommendations**: Suggestions for improvement
- **regressions_found**: Whether any regressions were detected
- **summary**: Brief summary of the verification`,
			priority: SECTION_PRIORITIES.output,
		});

		// Guidelines section
		sections.push({
			type: "guidelines",
			header: "Guidelines",
			content: `- **Evidence Required**: Every claim must have file:lines or probe_id proof
- **No Placeholders**: Block any TODO, FIXME, mock(), stub(), "Not implemented"
- **Diff Hygiene**: Flag any changes to files not declared in the task
- **Acceptance Criteria**: All criteria must be verifiable and verified
- **Conservative**: When in doubt, fail the gate and explain why
- **Actionable**: Provide clear recommendations for fixing issues

**Important:**
- Set overall_pass to false if ANY gate fails
- Set overall_pass to false if ANY task failed
- Set overall_pass to false if regressions were found
- Include specific file locations in evidence when possible`,
			priority: SECTION_PRIORITIES.guidelines,
		});

		return sections;
	}

	/**
	 * Build the prompt for the Truth Verifier
	 * Falls back to this if buildPromptSections returns empty
	 */
	buildPrompt(input: TVInput, workDir: string): string {
		const sections = this.buildPromptSections(input, workDir);
		if (sections.length > 0) {
			return sections
				.sort((a, b) => a.priority - b.priority)
				.map((s) => (s.header ? `## ${s.header}\n\n${s.content}` : s.content))
				.join("\n\n");
		}

		// Fallback simple prompt
		const { completedTasks, failedTasks } = input;
		return `You are the Truth Verifier (TV) agent.
Verify ${completedTasks.length} completed tasks and ${failedTasks.length} failed tasks.
Respond with JSON containing overall_pass, gates, and recommendations.`;
	}

	/**
	 * Parse the AI response into TVOutput
	 */
	parseOutput(response: string): TVOutput {
		const result = parseVerificationFromResponse(response);
		return {
			overallPass: result.overallPass,
			gates: result.gates,
			recommendations: result.recommendations,
		};
	}
}

/**
 * Parse verification result from AI response
 */
export function parseVerificationFromResponse(response: string): ParsedVerificationResult {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return createFailedVerification("Failed to extract JSON from verification response");
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (isValidParsedVerification(parsed)) {
			return normalizeVerification(parsed);
		}

		// Return failed result if invalid structure
		return createFailedVerification("Invalid response structure from verifier");
	} catch {
		// Try to find JSON object in the response
		const objectMatch = response.match(
			/\{\s*"overall_pass"[\s\S]*?"gates"\s*:\s*\[[\s\S]*?\]\s*\}/,
		);
		if (objectMatch) {
			try {
				const parsed = JSON.parse(objectMatch[0]);
				if (isValidParsedVerification(parsed)) {
					return normalizeVerification(parsed);
				}
			} catch {
				// Fall through
			}
		}

		// Return failed if parsing fails
		return createFailedVerification("Failed to parse verifier response");
	}
}

/**
 * Raw parsed verification from JSON (before normalization)
 */
interface RawParsedVerification {
	overall_pass?: boolean;
	overallPass?: boolean;
	gates?: unknown[];
	recommendations?: unknown[];
	regressions_found?: boolean;
	regressionsFound?: boolean;
	summary?: string;
}

/**
 * Validate parsed verification has required fields
 */
function isValidParsedVerification(data: unknown): data is RawParsedVerification {
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const obj = data as Record<string, unknown>;

	// overall_pass is required and must be boolean
	const overallPass = obj.overall_pass ?? obj.overallPass;
	if (typeof overallPass !== "boolean") {
		return false;
	}

	// gates should be an array if present
	if (obj.gates !== undefined && !Array.isArray(obj.gates)) {
		return false;
	}

	return true;
}

/**
 * Normalize parsed verification (handle both camelCase and snake_case)
 */
function normalizeVerification(parsed: RawParsedVerification): ParsedVerificationResult {
	const gatesRaw = parsed.gates || [];
	const recommendationsRaw = parsed.recommendations || [];

	return {
		overallPass: parsed.overall_pass ?? parsed.overallPass ?? false,
		gates: gatesRaw
			.map((g) => normalizeGate(g))
			.filter((g): g is ParsedVerificationResult["gates"][number] => g !== null),
		recommendations: recommendationsRaw.filter((r): r is string => typeof r === "string"),
		regressionsFound: parsed.regressions_found ?? parsed.regressionsFound,
		summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
	};
}

/**
 * Normalize a single gate result
 */
function normalizeGate(gate: unknown): ParsedVerificationResult["gates"][number] | null {
	if (typeof gate !== "object" || gate === null) {
		return null;
	}

	const obj = gate as Record<string, unknown>;

	// name/gate is required
	const name = obj.name ?? obj.gate;
	if (typeof name !== "string") {
		return null;
	}

	// passed is required
	if (typeof obj.passed !== "boolean") {
		return null;
	}

	// Normalize evidence
	const evidenceRaw = obj.evidence;
	const evidence: Evidence[] = [];
	if (Array.isArray(evidenceRaw)) {
		for (const e of evidenceRaw) {
			if (typeof e === "object" && e !== null) {
				const ev = e as Record<string, unknown>;
				evidence.push({
					type: (ev.type as Evidence["type"]) || "file",
					file: typeof ev.file === "string" ? ev.file : undefined,
					line_start: typeof ev.line_start === "number" ? ev.line_start : undefined,
					line_end: typeof ev.line_end === "number" ? ev.line_end : undefined,
					probe_id: typeof ev.probe_id === "string" ? ev.probe_id : undefined,
					command: typeof ev.command === "string" ? ev.command : undefined,
					output: typeof ev.output === "string" ? ev.output : undefined,
					timestamp: typeof ev.timestamp === "string" ? ev.timestamp : new Date().toISOString(),
				});
			}
		}
	}

	return {
		name,
		passed: obj.passed,
		message: typeof obj.message === "string" ? obj.message : undefined,
		evidence: evidence.length > 0 ? evidence : undefined,
	};
}

/**
 * Create a failed verification result
 */
function createFailedVerification(error: string): ParsedVerificationResult {
	return {
		overallPass: false,
		gates: [
			{
				name: "parsing",
				passed: false,
				message: error,
			},
		],
		recommendations: ["Fix the verifier response format"],
	};
}

/**
 * Create a Verifier agent with default configuration
 */
export function createVerifierAgent(configOverrides?: Partial<AgentConfig>): VerifierAgent {
	return new VerifierAgent(configOverrides);
}

/**
 * Build Verifier prompt (standalone utility for backward compatibility)
 */
export function buildVerifierPrompt(
	completedTasks: Task[],
	failedTasks: Task[],
	preCheckIssues: TVInput["preCheckIssues"],
	workDir: string,
): string {
	const agent = new VerifierAgent();
	return agent.buildPrompt({ completedTasks, failedTasks, preCheckIssues }, workDir);
}

/**
 * Check if verification passed
 */
export function isVerificationPassed(output: TVOutput): boolean {
	return output.overallPass;
}

/**
 * Check if any gates failed
 */
export function hasFailedGates(output: TVOutput): boolean {
	return output.gates.some((g) => !g.passed);
}

/**
 * Get failed gates
 */
export function getFailedGates(output: TVOutput): TVOutput["gates"] {
	return output.gates.filter((g) => !g.passed);
}

/**
 * Get passed gates
 */
export function getPassedGates(output: TVOutput): TVOutput["gates"] {
	return output.gates.filter((g) => g.passed);
}

/**
 * Get gate count
 */
export function getGateCount(output: TVOutput): number {
	return output.gates.length;
}

/**
 * Get passed gate count
 */
export function getPassedGateCount(output: TVOutput): number {
	return output.gates.filter((g) => g.passed).length;
}

/**
 * Get failed gate count
 */
export function getFailedGateCount(output: TVOutput): number {
	return output.gates.filter((g) => !g.passed).length;
}

/**
 * Get gate by name
 */
export function getGateByName(
	output: TVOutput,
	name: GateName,
): TVOutput["gates"][number] | undefined {
	return output.gates.find((g) => g.name === name);
}

/**
 * Check if a specific gate passed
 */
export function isGatePassed(output: TVOutput, name: GateName): boolean {
	const gate = getGateByName(output, name);
	return gate?.passed ?? false;
}

/**
 * Check if verification has recommendations
 */
export function hasRecommendations(output: TVOutput): boolean {
	return output.recommendations.length > 0;
}

/**
 * Get recommendation count
 */
export function getRecommendationCount(output: TVOutput): number {
	return output.recommendations.length;
}

/**
 * Format verification result as markdown for display
 */
export function formatVerificationAsMarkdown(output: TVOutput): string {
	const lines: string[] = [];

	lines.push("## Verification Result");
	lines.push("");

	// Overall status
	const statusEmoji = output.overallPass ? "✅" : "❌";
	lines.push(`**Status**: ${statusEmoji} ${output.overallPass ? "PASSED" : "FAILED"}`);
	lines.push("");

	// Gate results
	if (output.gates.length > 0) {
		lines.push("### Gate Results");
		lines.push("");

		for (const gate of output.gates) {
			const gateEmoji = gate.passed ? "✓" : "✗";
			const gateDescription = GATE_DESCRIPTIONS[gate.name as GateName] || gate.name;
			lines.push(`- ${gateEmoji} **${gateDescription}**`);
			if (gate.message) {
				lines.push(`  - ${gate.message}`);
			}
		}
		lines.push("");
	}

	// Recommendations
	if (output.recommendations.length > 0) {
		lines.push("### Recommendations");
		lines.push("");

		for (const rec of output.recommendations) {
			lines.push(`- ${rec}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Create verification summary for logging
 */
export function createVerificationSummary(output: TVOutput): string {
	const passed = getPassedGateCount(output);
	const total = getGateCount(output);
	const status = output.overallPass ? "PASSED" : "FAILED";

	return `Verification ${status}: ${passed}/${total} gates passed`;
}

/**
 * Check if evidence gate passed
 */
export function isEvidenceGatePassed(output: TVOutput): boolean {
	return isGatePassed(output, "evidence");
}

/**
 * Check if placeholder gate passed
 */
export function isPlaceholderGatePassed(output: TVOutput): boolean {
	return isGatePassed(output, "placeholder");
}

/**
 * Check if diff hygiene gate passed
 */
export function isDiffHygieneGatePassed(output: TVOutput): boolean {
	return isGatePassed(output, "diffHygiene");
}

/**
 * Check if DoD gate passed
 */
export function isDoDGatePassed(output: TVOutput): boolean {
	return isGatePassed(output, "dod");
}

/**
 * Check if environment consistency gate passed
 */
export function isEnvConsistencyGatePassed(output: TVOutput): boolean {
	return isGatePassed(output, "envConsistency");
}

/**
 * Get all gate evidence
 */
export function getAllGateEvidence(output: TVOutput): Evidence[] {
	const evidence: Evidence[] = [];
	for (const gate of output.gates) {
		if (gate.evidence) {
			evidence.push(...gate.evidence);
		}
	}
	return evidence;
}

/**
 * Get evidence for a specific gate
 */
export function getGateEvidence(output: TVOutput, name: GateName): Evidence[] {
	const gate = getGateByName(output, name);
	return gate?.evidence || [];
}
