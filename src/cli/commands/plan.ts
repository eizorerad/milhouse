import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import pc from "picocolors";
import type { RuntimeOptions } from "../runtime-options.ts";
import { getConfigService } from "../../services/config/index.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngine, AIEngineName, AIResult } from "../../engines/types.ts";
import {
	OpencodeServerExecutor,
	PortManager,
	displayTmuxModeHeader,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	getMessageOptionsForPhase,
	type ServerInfo,
} from "../../engines/opencode/index.ts";
import { TmuxSessionManager, ensureTmuxInstalled, getInstallationInstructions } from "../../engines/tmux/index.ts";
import type { InspectorProbeType } from "../../probes/index.ts";
import { buildFilterOptionsFromRuntime, filterIssues, loadIssuesForRun, updateIssueForRun } from "../../state/issues.ts";
import { getMilhouseDir, initializeDir } from "../../state/manager.ts";
import {
	updateRunPhaseInMeta,
	updateRunStats,
} from "../../state/runs.ts";
import { createTaskForRun, loadTasksForRun } from "../../state/tasks.ts";
import {
	getCurrentPlansDir,
	syncLegacyPlansView,
	writeIssueWbsJsonForRun,
	writeIssueWbsPlanForRun,
	createPlanMetadataHeader,
} from "../../state/plan-store.ts";
import { AGENT_ROLES, type DoDCriteria, type Issue } from "../../state/types.ts";
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
import {
	formatProbeResultsForPrompt,
	hasExistingProbeResults,
	loadExistingProbeResults,
	runApplicableProbes,
} from "./utils/probeIntegration.ts";
import { selectOrRequireRun } from "./utils/run-selector.ts";

/**
 * Default number of parallel planner agents
 */
const DEFAULT_PARALLEL_PLANNERS = 5;

/**
 * Result of planning for issues
 */
interface PlanResult {
	success: boolean;
	issuesPlanned: number;
	tasksCreated: number;
	inputTokens: number;
	outputTokens: number;
	planPaths: string[];
	error?: string;
}

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
	parallel_group: number;
}

/**
 * Parsed WBS from AI response
 */
interface ParsedWBS {
	issue_id: string;
	summary: string;
	research_findings: {
		code_patterns: string[];
		dependencies: string[];
		test_coverage: string[];
		related_issues: string[];
	};
	tasks: ParsedWBSTask[];
}

/**
 * Deep validation report structure (from validate.ts)
 */
interface DeepValidationReport {
	issue_id: string;
	status: string;
	confidence: "HIGH" | "MEDIUM" | "LOW";
	summary: string;
	investigation: {
		files_examined: string[];
		commands_run: string[];
		patterns_found: string[];
		related_code: Array<{
			file: string;
			line_start: number;
			line_end: number;
			relevance: string;
			code_snippet?: string;
		}>;
	};
	root_cause_analysis: {
		confirmed_cause?: string;
		alternative_causes?: string[];
		why_not_false_positive?: string;
	};
	impact_assessment: {
		severity_confirmed: boolean;
		actual_severity?: string;
		affected_components: string[];
		user_impact?: string;
		security_implications?: string;
	};
	reproduction: {
		reproducible: boolean;
		steps?: string[];
		conditions?: string;
	};
	recommendations: {
		fix_approach: string;
		estimated_complexity: "LOW" | "MEDIUM" | "HIGH";
		prerequisites?: string[];
		test_strategy?: string;
	};
	evidence: Array<{
		type: string;
		file?: string;
		line_start?: number;
		line_end?: number;
		output?: string;
	}>;
	corrected_description?: string;
}

/**
 * Get validation reports directory
 */
function getValidationReportsDir(workDir: string): string {
	return join(getMilhouseDir(workDir), "validation-reports");
}

/**
 * Load validation report for a specific issue
 */
function loadValidationReport(issueId: string, workDir: string): DeepValidationReport | null {
	const reportsDir = getValidationReportsDir(workDir);
	const reportPath = join(reportsDir, `${issueId}.json`);

	if (!existsSync(reportPath)) {
		logDebug(`No validation report found for ${issueId} at ${reportPath}`);
		return null;
	}

	try {
		const content = readFileSync(reportPath, "utf-8");
		return JSON.parse(content) as DeepValidationReport;
	} catch (error) {
		logWarn(`Failed to load validation report for ${issueId}: ${error}`);
		return null;
	}
}

/**
 * Build the Deep Planner prompt for a specific issue with validation report
 */
function buildDeepPlannerPrompt(
	issue: Issue,
	validationReport: DeepValidationReport | null,
	workDir: string,
	agentNum: number,
	probeEvidence?: string,
): string {
	const parts: string[] = [];

	// Role definition with agent identity
	parts.push(`## Role: Planner Agent #${agentNum} (PL-${agentNum})
${AGENT_ROLES.PL}

You are **dedicated planner agent #${agentNum}** creating a Work Breakdown Structure (WBS) for a SINGLE issue.
Your task is to perform DEEP research and create detailed, actionable tasks.

⚠️ **IMPORTANT**: This is a deep planning session, not a quick task list. You must:
- Read and analyze the validation report thoroughly
- Research the codebase to understand all affected areas
- Trace code dependencies and impact
- Create granular, testable tasks with clear acceptance criteria
- Consider edge cases, error handling, and testing`);

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
		const configParts: string[] = [];
		if (config.commands.test) configParts.push(`Test command: ${config.commands.test}`);
		if (config.commands.lint) configParts.push(`Lint command: ${config.commands.lint}`);
		if (config.commands.build) configParts.push(`Build command: ${config.commands.build}`);
		if (configParts.length > 0) {
			parts.push(`## Available Commands\n${configParts.join("\n")}`);
		}
	}

	// Issue to plan with full context
	parts.push(`## Issue to Plan

| Field | Value |
|-------|-------|
| **ID** | ${issue.id} |
| **Status** | ${issue.status} |
| **Symptom** | ${issue.symptom} |
| **Hypothesis** | ${issue.hypothesis} |
| **Severity** | ${issue.severity} |
${issue.corrected_description ? `| **Corrected Description** | ${issue.corrected_description} |` : ""}
${issue.frequency ? `| **Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}`);

	// Add validation report if available (THIS IS THE KEY ADDITION)
	if (validationReport) {
		parts.push(`## Validation Report (IMPORTANT - Use This as Your Primary Source)

### Summary
${validationReport.summary}

### Confidence Level: ${validationReport.confidence}

### Root Cause Analysis
${validationReport.root_cause_analysis.confirmed_cause ? `**Confirmed Cause**: ${validationReport.root_cause_analysis.confirmed_cause}` : "No confirmed cause"}
${validationReport.root_cause_analysis.why_not_false_positive ? `**Why Not False Positive**: ${validationReport.root_cause_analysis.why_not_false_positive}` : ""}

### Investigation Findings

#### Files Examined
${validationReport.investigation.files_examined.map((f) => `- \`${f}\``).join("\n") || "No files documented"}

#### Patterns Found
${validationReport.investigation.patterns_found.map((p) => `- ${p}`).join("\n") || "No patterns documented"}

#### Related Code Locations
${
	validationReport.investigation.related_code
		.map(
			(c) =>
				`- \`${c.file}:${c.line_start}-${c.line_end}\` - ${c.relevance}${c.code_snippet ? `\n  \`\`\`\n  ${c.code_snippet}\n  \`\`\`` : ""}`,
		)
		.join("\n") || "No specific locations documented"
}

### Impact Assessment

| Aspect | Value |
|--------|-------|
| **Actual Severity** | ${validationReport.impact_assessment.actual_severity || "N/A"} |
| **Affected Components** | ${validationReport.impact_assessment.affected_components.join(", ") || "N/A"} |
| **User Impact** | ${validationReport.impact_assessment.user_impact || "N/A"} |
| **Security Implications** | ${validationReport.impact_assessment.security_implications || "None"} |

### Recommended Fix Approach
${validationReport.recommendations.fix_approach}

### Estimated Complexity: ${validationReport.recommendations.estimated_complexity}

${validationReport.recommendations.prerequisites?.length ? `### Prerequisites\n${validationReport.recommendations.prerequisites.map((p) => `- ${p}`).join("\n")}` : ""}

${validationReport.recommendations.test_strategy ? `### Test Strategy\n${validationReport.recommendations.test_strategy}` : ""}

### Reproduction Steps
${
	validationReport.reproduction.reproducible
		? validationReport.reproduction.steps?.map((s, i) => `${i + 1}. ${s}`).join("\n") ||
			"No steps documented"
		: "Not reproducible"
}
${validationReport.reproduction.conditions ? `**Conditions**: ${validationReport.reproduction.conditions}` : ""}`);
	} else {
		// Fallback to issue evidence if no validation report
		parts.push(`## Evidence (No Validation Report Available)
${
	issue.evidence.length > 0
		? issue.evidence
				.map((e) => `- ${e.type}: ${e.file || e.command || e.probe_id || "N/A"}`)
				.join("\n")
		: "No evidence collected"
}`);
	}

	// Deep research instructions
	parts.push(`## Deep Research Protocol

Before creating tasks, you MUST research the codebase:

### Phase 1: Code Analysis
1. Read ALL files mentioned in the validation report
2. Search for related patterns using grep/ripgrep
3. Trace dependencies and imports
4. Identify all files that will need changes
5. Check for related test files

### Phase 2: Impact Analysis
1. List all components that will be affected
2. Identify potential breaking changes
3. Check for similar patterns elsewhere that need the same fix
4. Review database/API impacts if any

### Phase 3: Test Analysis
1. Find existing tests that cover this functionality
2. Identify tests that will need updates
3. Plan new tests needed for the fix
4. Consider edge cases

### Phase 4: Task Breakdown
1. Create small, atomic tasks (1 commit each ideally)
2. Order tasks by dependencies
3. Group parallelizable tasks
4. Add clear acceptance criteria to each`);

	// Output format
	parts.push(`## Output Format

You MUST respond with a JSON object in this EXACT format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "summary": "Brief summary of your planning approach",
  "research_findings": {
    "code_patterns": ["Pattern A found in X files", "Pattern B needs updating"],
    "dependencies": ["ComponentA depends on ComponentB", "API call at line 42"],
    "test_coverage": ["Existing test at test/foo.test.ts", "Missing edge case test"],
    "related_issues": ["Similar pattern in file.ts:100", "May affect other areas"]
  },
  "tasks": [
    {
      "title": "Short descriptive task title",
      "description": "Detailed description:\n- What needs to be done\n- Why this change is needed\n- Key considerations",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "depends_on": [],
      "checks": ["npm test -- --grep 'test name'", "npm run lint"],
      "acceptance": [
        {
          "description": "Test passes for X scenario",
          "check_command": "npm test -- --grep 'X scenario'",
          "verified": false
        },
        {
          "description": "Lint passes without errors",
          "check_command": "npm run lint",
          "verified": false
        }
      ],
      "risk": "LOW|MEDIUM|HIGH - description of risk",
      "rollback": "How to undo this change",
      "parallel_group": 0
    }
  ]
}
\`\`\`

## Task Guidelines

### Granularity
- Each task = 1 logical unit of work (ideally 1 commit)
- Don't combine unrelated changes
- Break large changes into smaller steps

### Dependencies (depends_on)
- Use indices: ["0", "1"] means depends on task 0 and 1
- Tasks without dependencies: []
- Create proper order to avoid conflicts

### Parallel Groups
- Tasks with same parallel_group can run concurrently
- Use different groups for dependent tasks
- Group 0 runs first, then 1, etc.

### Acceptance Criteria
- MUST be verifiable by running commands
- Include specific test commands
- Add lint/type check commands
- Be specific, not vague

### Files
- List ALL files that will be modified
- Include test files
- Include config files if needed

### Risk Assessment
- LOW: Isolated change, easy rollback
- MEDIUM: Multiple files, some dependencies
- HIGH: Core functionality, breaking changes possible

## Quality Requirements

1. Minimum 2 acceptance criteria per task
2. All tasks must have file references
3. Every task must be testable
4. Include test tasks for complex changes
5. Consider error handling in descriptions`);

	// Add probe evidence if available
	if (probeEvidence) {
		parts.push(probeEvidence);
	}

	return parts.join("\n\n");
}

/**
 * Build the Planner prompt for a specific issue (legacy - for backwards compatibility)
 */
function buildPlannerPrompt(issue: Issue, workDir: string): string {
	return buildDeepPlannerPrompt(issue, null, workDir, 0);
}

/**
 * Parse WBS from AI response
 */
function parseWBSFromResponse(response: string, issueId: string): ParsedWBS | null {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		// Log more details about why extraction failed
		const responsePreview = response.slice(0, 500);
		const hasCodeBlock = response.includes("```");
		const hasJsonBlock = response.toLowerCase().includes("```json");
		const hasBraces = response.includes("{") && response.includes("}");
		logWarn(`Failed to extract JSON from WBS response for ${issueId}`);
		logDebug(`  Response preview (first 500 chars): ${responsePreview}...`);
		logDebug(
			`  Has code block: ${hasCodeBlock}, Has json block: ${hasJsonBlock}, Has braces: ${hasBraces}`,
		);
		logDebug(`  Response length: ${response.length} chars`);
		return null;
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (!isValidParsedWBS(parsed)) {
			// Log which validation failed
			const validationDetails = getWBSValidationDetails(parsed);
			logWarn(`Invalid WBS response structure for ${issueId}: ${validationDetails}`);
			logDebug(`  Parsed JSON keys: ${Object.keys(parsed || {}).join(", ")}`);
			return null;
		}

		// Ensure issue_id matches
		if (parsed.issue_id !== issueId) {
			logDebug(`Issue ID mismatch: expected ${issueId}, got ${parsed.issue_id}`);
			parsed.issue_id = issueId;
		}

		// Ensure research_findings exists
		if (!parsed.research_findings) {
			parsed.research_findings = {
				code_patterns: [],
				dependencies: [],
				test_coverage: [],
				related_issues: [],
			};
		}

		return parsed;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logWarn(`Failed to parse JSON WBS response for ${issueId}: ${errorMsg}`);
		logDebug(`  JSON string preview: ${jsonStr.slice(0, 300)}...`);
		return null;
	}
}

/**
 * Get details about why WBS validation failed
 */
function getWBSValidationDetails(wbs: unknown): string {
	if (typeof wbs !== "object" || wbs === null) {
		return "Response is not an object";
	}

	const obj = wbs as Record<string, unknown>;
	const issues: string[] = [];

	if (typeof obj.issue_id !== "string" || obj.issue_id.trim() === "") {
		issues.push("missing or invalid issue_id");
	}

	if (typeof obj.summary !== "string") {
		issues.push("missing summary");
	}

	if (!Array.isArray(obj.tasks)) {
		issues.push("tasks is not an array");
	} else {
		// Check first few tasks for issues
		for (let i = 0; i < Math.min(obj.tasks.length, 3); i++) {
			const task = obj.tasks[i];
			if (!isValidParsedTask(task)) {
				const taskIssues = getTaskValidationDetails(task, i);
				issues.push(`task[${i}]: ${taskIssues}`);
			}
		}
	}

	return issues.length > 0 ? issues.join("; ") : "unknown validation error";
}

/**
 * Get details about why task validation failed
 */
function getTaskValidationDetails(task: unknown, index: number): string {
	if (typeof task !== "object" || task === null) {
		return "not an object";
	}

	const obj = task as Record<string, unknown>;
	const issues: string[] = [];

	if (typeof obj.title !== "string" || obj.title.trim() === "") {
		issues.push("missing title");
	}

	if (obj.files !== undefined && !Array.isArray(obj.files)) {
		issues.push("files not array");
	}

	if (obj.depends_on !== undefined && !Array.isArray(obj.depends_on)) {
		issues.push("depends_on not array");
	}

	return issues.join(", ") || "unknown";
}

/**
 * Validate parsed WBS has required fields
 */
function isValidParsedWBS(wbs: unknown): wbs is ParsedWBS {
	if (typeof wbs !== "object" || wbs === null) {
		return false;
	}

	const obj = wbs as Record<string, unknown>;

	if (typeof obj.issue_id !== "string" || obj.issue_id.trim() === "") {
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
 * Save raw response for debugging when parsing fails
 */
function saveDebugResponse(issueId: string, response: string, workDir: string): string {
	const debugDir = join(getMilhouseDir(workDir), "debug");
	if (!existsSync(debugDir)) {
		mkdirSync(debugDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const debugPath = join(debugDir, `wbs-parse-fail_${issueId}_${timestamp}.txt`);

	const debugContent = `# WBS Parse Failure Debug
Issue ID: ${issueId}
Timestamp: ${new Date().toISOString()}
Response Length: ${response.length} chars

## Raw Response
${response}
`;

	writeFileSync(debugPath, debugContent);
	return debugPath;
}

/**
 * Plan a single issue with deep research using validation report
 */
async function planSingleIssueDeep(
	issue: Issue,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
	agentNum: number,
	onProgress?: (step: string) => void,
): Promise<{
	wbs: ParsedWBS | null;
	inputTokens: number;
	outputTokens: number;
	error?: string;
	durationMs: number;
}> {
	const startTime = Date.now();

	// Load validation report for this issue
	const validationReport = loadValidationReport(issue.id, workDir);
	if (validationReport) {
		logDebug(`Agent #${agentNum}: Loaded validation report for ${issue.id}`);
	} else {
		logDebug(`Agent #${agentNum}: No validation report for ${issue.id}, using issue data only`);
	}

	// Run probes before planning (unless skipped)
	// First check if probes already ran during validation
	let probeEvidence: string | undefined;
	if (!options.skipProbes) {
		// Check if probe results already exist from validation
		if (hasExistingProbeResults(workDir)) {
			logDebug(`Agent #${agentNum}: Using existing probe results from validation`);
			const existingProbes: InspectorProbeType[] = [
				"compose",
				"postgres",
				"redis",
				"storage",
				"deps",
				"repro",
			];
			const existingResults = loadExistingProbeResults(workDir, existingProbes);
			if (existingResults.length > 0) {
				// Format existing results for prompt
				const summary = {
					total: existingResults.length,
					succeeded: existingResults.filter((r) => r.success).length,
					failed: existingResults.filter((r) => !r.success).length,
					skipped: 0,
					totalFindings: existingResults.reduce((sum, r) => sum + (r.findings?.length || 0), 0),
					findingsBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
				};
				for (const result of existingResults) {
					for (const finding of result.findings || []) {
						summary.findingsBySeverity[finding.severity] =
							(summary.findingsBySeverity[finding.severity] || 0) + 1;
					}
				}
				probeEvidence = formatProbeResultsForPrompt({
					results: existingResults,
					successful: existingResults.filter((r) => r.success),
					failed: existingResults.filter((r) => !r.success),
					totalDurationMs: 0,
					summary,
				});
				logInfo(`Agent #${agentNum}: Loaded ${existingResults.length} existing probe results`);
			}
		} else {
			// Run probes if no existing results
			onProgress?.(`Agent #${agentNum}: Running infrastructure probes`);
			logDebug(`Agent #${agentNum} running probes for issue ${issue.id}`);

			const probeResult = await runApplicableProbes(workDir, {
				forceReadOnly: true,
				continueOnFailure: true,
			});

			if (probeResult.success && probeResult.dispatchResult) {
				probeEvidence = formatProbeResultsForPrompt(probeResult.dispatchResult);
				logInfo(
					`Agent #${agentNum}: Probes completed - ${probeResult.dispatchResult.summary.succeeded}/${probeResult.dispatchResult.summary.total} passed`,
				);
			} else if (probeResult.error) {
				logDebug(`Agent #${agentNum}: Probe execution warning - ${probeResult.error}`);
			}
		}
	} else {
		logDebug(`Agent #${agentNum}: Skipping probes (--skip-probes flag set)`);
	}

	const prompt = buildDeepPlannerPrompt(issue, validationReport, workDir, agentNum, probeEvidence);
	logDebug(`Agent #${agentNum} planning issue ${issue.id}: ${issue.symptom.slice(0, 50)}...`);

	let result: AIResult;
	try {
		if (engine.executeStreaming) {
			result = await engine.executeStreaming(
				prompt,
				workDir,
				(step) => {
					// Handle both DetailedStep and string
					if (step && typeof step === "object") {
						const detail = step.shortDetail ? ` ${step.shortDetail}` : "";
						onProgress?.(`Agent #${agentNum}: ${step.category}${detail}`);
					} else if (step) {
						onProgress?.(`Agent #${agentNum}: ${step}`);
					} else {
						onProgress?.(`Agent #${agentNum}: Researching`);
					}
				},
				{ modelOverride: options.modelOverride },
			);
		} else {
			onProgress?.(`Agent #${agentNum}: Executing deep planning`);
			result = await engine.execute(prompt, workDir, {
				modelOverride: options.modelOverride,
			});
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			wbs: null,
			inputTokens: 0,
			outputTokens: 0,
			error: errorMsg,
			durationMs: Date.now() - startTime,
		};
	}

	if (!result.success) {
		return {
			wbs: null,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			error: result.error || "Unknown error",
			durationMs: Date.now() - startTime,
		};
	}

	const wbs = parseWBSFromResponse(result.response, issue.id);

	// Save debug info if parsing failed
	if (!wbs && result.response) {
		const debugPath = saveDebugResponse(issue.id, result.response, workDir);
		logDebug(`Saved debug response to: ${debugPath}`);
	}

	return {
		wbs,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		durationMs: Date.now() - startTime,
	};
}

/**
 * Plan a single issue (legacy wrapper for backwards compatibility)
 */
async function planSingleIssue(
	issue: Issue,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
	spinner: ProgressSpinner,
): Promise<{
	wbs: ParsedWBS | null;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}> {
	const result = await planSingleIssueDeep(issue, engine, workDir, options, 0, (step) => {
		spinner.updateStep(step);
	});

	return {
		wbs: result.wbs,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		error: result.error,
	};
}

/**
 * Generate WBS markdown for an issue
 */
function generateWBSMarkdown(
	issue: Issue,
	wbs: ParsedWBS,
	validationReport: DeepValidationReport | null,
	workDir: string,
): string {
	const timestamp = new Date().toISOString();
	const parts: string[] = [];

	// Add metadata header at the very top
	parts.push(createPlanMetadataHeader(workDir, { issueId: issue.id }).trimEnd());

	parts.push(`# WBS: ${issue.id}

> **Issue**: ${issue.symptom}
> **Status**: ${issue.status}
> **Severity**: ${issue.severity}
> **Generated**: ${timestamp}
> **Tasks**: ${wbs.tasks.length}

---

## Summary

${wbs.summary}

---

## Issue Details

| Field | Value |
|-------|-------|
| **ID** | ${issue.id} |
| **Symptom** | ${issue.symptom} |
| **Hypothesis** | ${issue.hypothesis} |
${issue.corrected_description ? `| **Corrected Description** | ${issue.corrected_description} |` : ""}
| **Severity** | ${issue.severity} |
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}

---
`);

	// Add validation context if available
	if (validationReport) {
		parts.push(`## Validation Context

### Root Cause
${validationReport.root_cause_analysis.confirmed_cause || "Not determined"}

### Fix Approach
${validationReport.recommendations.fix_approach}

### Complexity: ${validationReport.recommendations.estimated_complexity}

---
`);
	}

	// Add research findings
	if (wbs.research_findings) {
		parts.push(`## Research Findings

### Code Patterns
${wbs.research_findings.code_patterns?.map((p) => `- ${p}`).join("\n") || "None documented"}

### Dependencies
${wbs.research_findings.dependencies?.map((d) => `- ${d}`).join("\n") || "None documented"}

### Test Coverage
${wbs.research_findings.test_coverage?.map((t) => `- ${t}`).join("\n") || "None documented"}

### Related Issues
${wbs.research_findings.related_issues?.map((r) => `- ${r}`).join("\n") || "None found"}

---
`);
	}

	parts.push(`## Tasks
`);

	for (let i = 0; i < wbs.tasks.length; i++) {
		const task = wbs.tasks[i];
		const taskId = `${issue.id}-T${i + 1}`;

		parts.push(`### ${taskId}: ${task.title}

${task.description || "No description provided."}

| Field | Value |
|-------|-------|
| **Files** | ${task.files.length > 0 ? task.files.map((f) => `\`${f}\``).join(", ") : "None specified"} |
| **Dependencies** | ${task.depends_on.length > 0 ? task.depends_on.map((d) => `${issue.id}-T${Number(d) + 1}`).join(", ") : "None"} |
| **Parallel Group** | ${task.parallel_group} |
| **Risk** | ${task.risk || "Not assessed"} |
| **Rollback** | ${task.rollback || "Revert commit"} |

#### Checks
${task.checks.length > 0 ? task.checks.map((c) => `- \`${c}\``).join("\n") : "- No checks specified"}

#### Acceptance Criteria
${task.acceptance.length > 0 ? task.acceptance.map((a) => `- [ ] ${a.description}${a.check_command ? ` (\`${a.check_command}\`)` : ""}`).join("\n") : "- No acceptance criteria specified"}

---
`);
	}

	parts.push(`## Next Steps

1. Review this WBS for completeness and accuracy
2. Run \`milhouse consolidate\` to merge all WBS into unified Execution Plan
3. Run \`milhouse exec\` to execute tasks
`);

	return parts.join("\n");
}

/**
 * Run the plan command - Planner agents with DEEP parallel planning
 *
 * Each issue is planned by a dedicated agent in parallel (default: 5 agents).
 * Each agent reads the validation report and performs deep codebase research.
 * Generates WBS for each validated (CONFIRMED or PARTIAL) issue.
 */
export async function runPlan(options: RuntimeOptions): Promise<PlanResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Initialize milhouse directory if needed
	initializeDir(workDir);

	// Select or require an active run using explicit run ID
	const runSelection = await selectOrRequireRun(options.runId, workDir, {
		requirePhase: ["validate", "plan"],
	});
	if (!runSelection) {
		logError("No active run found. Run 'milhouse scan' and 'milhouse validate' first.");
		return {
			success: false,
			issuesPlanned: 0,
			tasksCreated: 0,
			inputTokens: 0,
			outputTokens: 0,
			planPaths: [],
			error: "No active run",
		};
	}
	const { runId, runMeta: currentRun } = runSelection;

	// Load issues for this specific run
	const issues = loadIssuesForRun(runId, workDir);

	// Build filter options from CLI arguments
	const filterOptions = buildFilterOptionsFromRuntime(options, ["CONFIRMED", "PARTIAL"]);
	const plannableIssues = filterIssues(issues, filterOptions);

	// Log active filters
	if (options.issueIds?.length) {
		logInfo(`Filtering to specific issues: ${options.issueIds.join(", ")}`);
	}
	if (options.excludeIssueIds?.length) {
		logInfo(`Excluding issues: ${options.excludeIssueIds.join(", ")}`);
	}
	if (options.minSeverity) {
		logInfo(`Minimum severity: ${options.minSeverity}`);
	}
	if (options.severityFilter?.length) {
		logInfo(`Severity filter: ${options.severityFilter.join(", ")}`);
	}

	if (plannableIssues.length === 0) {
		logWarn("No confirmed or partial issues found. Run 'milhouse validate' first.");
		return {
			success: true,
			issuesPlanned: 0,
			tasksCreated: 0,
			inputTokens: 0,
			outputTokens: 0,
			planPaths: [],
		};
	}

	// Update phase to plan using run-aware function
	updateRunPhaseInMeta(runId, "plan", workDir);

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
			issuesPlanned: 0,
			tasksCreated: 0,
			inputTokens: 0,
			outputTokens: 0,
			planPaths: [],
			error: `${engine.name} not available`,
		};
	}

	// Determine parallelism - DEFAULT to parallel with 5 agents (like validation)
	const maxParallel =
		options.maxParallel > 0
			? Math.min(options.maxParallel, plannableIssues.length, DEFAULT_PARALLEL_PLANNERS)
			: Math.min(DEFAULT_PARALLEL_PLANNERS, plannableIssues.length);

	logInfo(`Starting DEEP planning with ${engine.name} (engine: ${options.aiEngine})`);
	logInfo(
		`Mode: ${pc.cyan(`${maxParallel} parallel agents`)} (each agent = 1 issue + validation report)`,
	);
	logInfo(`Role: ${AGENT_ROLES.PL}`);
	logInfo(`Issues to plan: ${plannableIssues.length}`);

	// Check for validation reports
	const reportsDir = getValidationReportsDir(workDir);
	const issuesWithReports = plannableIssues.filter((i) =>
		existsSync(join(reportsDir, `${i.id}.json`)),
	);
	logInfo(`Validation reports available: ${issuesWithReports.length}/${plannableIssues.length}`);

	// ============================================================================
	// TMUX MODE CHECK: Validate tmux mode requirements
	// ============================================================================
	let tmuxManager: TmuxSessionManager | null = null;
	let tmuxEnabled = false;

	if (options.tmux) {
		// Check if using OpenCode engine (tmux mode only works with OpenCode)
		if (options.aiEngine !== "opencode") {
			logWarn("Tmux mode is only supported with --opencode engine. Falling back to standard execution.");
		} else {
			// Try to ensure tmux is installed (with auto-install if possible)
			const tmuxResult = await ensureTmuxInstalled({ autoInstall: true, verbose: true });
			
			if (!tmuxResult.installed) {
				// Installation failed or not possible (e.g., Windows)
				logWarn("tmux is not available and could not be installed automatically.");
				if (tmuxResult.error) {
					logInfo(tmuxResult.error);
				}
				logInfo("Falling back to standard execution.");
				logInfo("");
				logInfo(getInstallationInstructions());
			} else {
				// tmux is available (either was already installed or just installed)
				if (tmuxResult.installedNow) {
					logSuccess(`tmux ${tmuxResult.version ?? "unknown"} was installed successfully via ${tmuxResult.method}`);
				} else {
					logDebug(`tmux ${tmuxResult.version ?? "unknown"} is already installed`);
				}
				
				// Initialize tmux manager
				tmuxManager = new TmuxSessionManager({
					sessionPrefix: "milhouse",
					verbose: options.verbose,
				});
				tmuxEnabled = true;
				logInfo("Tmux mode enabled - OpenCode servers will be started with TUI attachment");
			}
		}
	}

	console.log("");

	// Track results
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let issuesPlanned = 0;
	let tasksCreated = 0;
	const planPaths: string[] = [];
	const errors: string[] = [];

	// ============================================================================
	// EXECUTION: Choose between tmux mode and standard mode
	// ============================================================================
	if (tmuxEnabled && tmuxManager) {
		// TMUX MODE: Use OpenCode server with tmux sessions
		logDebug("Executing planning in tmux mode");

		// Track executors and contexts
		interface AgentContext {
			executor: OpencodeServerExecutor;
			serverInfo: ServerInfo;
			sessionId: string;
		}
		const agentContexts: AgentContext[] = [];

		// Create progress spinner for tmux mode
		const spinner = new ProgressSpinner(
			"Deep planning in progress (tmux mode)",
			Array.from({ length: maxParallel }, (_, i) => `PL-${i + 1}`),
		);

		logInfo(`Starting ${maxParallel} OpenCode servers for planning...`);

		try {
			// Start servers and create tmux sessions for each agent slot
			for (let i = 0; i < Math.min(maxParallel, plannableIssues.length); i++) {
				const agentNum = i + 1;

				// Update spinner to show server startup progress
				spinner.updateStep(`Starting server ${agentNum}/${maxParallel}...`);

				const executor = new OpencodeServerExecutor({
					autoInstall: options.autoInstall ?? true,
					verbose: options.verbose,
				});

				// Start the OpenCode server
				const port = await executor.startServer(workDir);
				const url = `http://localhost:${port}`;

				// Create the session via the API
				const session = await executor.createSession({
					title: `Milhouse Planner Agent #${agentNum}`,
				});

				// Create tmux session with opencode attach
				const tmuxSessionBaseName = `plan-PL${agentNum}`;
				const sessionName = tmuxManager.buildSessionName(tmuxSessionBaseName);
				const attachCmd = `opencode attach ${url} -s ${session.id}`;

				// Kill existing session if it exists (handles retry case)
				await tmuxManager.killSessionIfExists(tmuxSessionBaseName);

				const tmuxResult = await tmuxManager.createSession({
					name: tmuxSessionBaseName,
					command: attachCmd,
					workDir,
				});

				if (!tmuxResult.success) {
					logWarn(`Failed to create tmux session for PL-${agentNum}: ${tmuxResult.error}`);
				}

				agentContexts.push({
					executor,
					serverInfo: {
						issueId: `PL-${agentNum}`, // Agent ID, not issue ID
						port,
						sessionName,
						status: "running",
						url,
					},
					sessionId: session.id,
				});
			}

			// Display tmux mode header and attach instructions
			displayTmuxModeHeader();
			displayAttachInstructions(agentContexts.map((ctx) => ctx.serverInfo));
			console.log("");

			// Create a work queue - issues waiting to be processed
			const workQueue = [...plannableIssues];
			let workQueueIndex = 0;

			// Helper to get next issue from queue
			const getNextIssue = (): Issue | null => {
				if (workQueueIndex >= workQueue.length) {
					return null;
				}
				const issue = workQueue[workQueueIndex];
				workQueueIndex++;
				return issue;
			};

			// Helper to process a single issue with a specific agent
			const processIssue = async (
				issue: Issue,
				context: typeof agentContexts[0],
				agentNum: number,
			): Promise<{ success: boolean; issue: Issue; wbs?: ParsedWBS }> => {
				// Load validation report for this issue
				const validationReport = loadValidationReport(issue.id, workDir);

				// Build the planning prompt
				const prompt = buildDeepPlannerPrompt(issue, validationReport, workDir, agentNum);

				logDebug(`Agent #${agentNum} planning issue ${issue.id} via OpenCode server`);

				// Update spinner to show we're waiting for OpenCode response
				spinner.updateStep(`PL-${agentNum}: Planning ${issue.id.slice(0, 12)}...`);

				try {
					// Send the prompt and wait for completion
					// Use autonomy config to prevent questions and restrict to read-only tools
					const response = await context.executor.sendMessage(
						context.sessionId,
						prompt,
						getMessageOptionsForPhase("plan", options.modelOverride)
					);

					// Update spinner to show we're processing the response
					spinner.updateStep(`PL-${agentNum}: Processing response...`);

					// Calculate tokens from response
					const respInputTokens = response.info.inputTokens ?? 0;
					const respOutputTokens = response.info.outputTokens ?? 0;
					totalInputTokens += respInputTokens;
					totalOutputTokens += respOutputTokens;

					// Extract text from response parts
					const responseText = response.parts
						.filter((p) => p.type === "text")
						.map((p) => (p as { type: "text"; text: string }).text)
						.join("");

					// Parse the WBS
					const wbs = parseWBSFromResponse(responseText, issue.id);

					if (wbs) {
						const planPath = processPlanResult(runId, issue, wbs, validationReport, workDir);
						planPaths.push(planPath);
						issuesPlanned++;
						tasksCreated += wbs.tasks.length;

						const hasReport = validationReport ? pc.green("✓ report") : pc.yellow("○ no report");
						console.log(
							`  ${pc.green("✓")} PL-${agentNum}: ${issue.id} - ${pc.green(`${wbs.tasks.length} tasks`)} [${hasReport}]`,
						);
						return { success: true, issue, wbs };
					} else {
						// Save debug info if parsing failed
						if (responseText) {
							const debugPath = saveDebugResponse(issue.id, responseText, workDir);
							logDebug(`Saved debug response to: ${debugPath}`);
						}
						errors.push(`PL-${agentNum} (${issue.id}): Failed to parse WBS`);
						console.log(
							`  ${pc.red("✗")} PL-${agentNum}: ${issue.id} - ${pc.red("Failed to parse WBS")}`,
						);
						return { success: false, issue };
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					errors.push(`PL-${agentNum} (${issue.id}): ${errorMsg}`);
					console.log(`  ${pc.red("✗")} PL-${agentNum}: ${issue.id} - ${pc.red(errorMsg)}`);
					return { success: false, issue };
				}
			};

			// Worker function - each agent runs this to process issues from the queue
			const runWorker = async (context: typeof agentContexts[0], agentNum: number): Promise<void> => {
				while (true) {
					const issue = getNextIssue();
					if (!issue) {
						// No more work
						spinner.updateStep(`PL-${agentNum}: Done`);
						break;
					}
					await processIssue(issue, context, agentNum);
				}
			};

			// Start all workers - each processes issues sequentially from the shared queue
			// This ensures each server handles ONE issue at a time
			const workerPromises = agentContexts.map((context, idx) => runWorker(context, idx + 1));
			await Promise.all(workerPromises);

			// Display completion summary
			const completedServerInfos: ServerInfo[] = agentContexts.map((ctx) => ({
				...ctx.serverInfo,
				status: "completed" as const,
			}));
			displayTmuxCompletionSummary(completedServerInfos);

			// Mark spinner as successful
			spinner.success(`Planning complete`);

		} finally {
			// Cleanup: Stop all servers but keep tmux sessions for inspection
			logInfo("Stopping OpenCode servers (tmux sessions preserved for inspection)");
			for (const context of agentContexts) {
				try {
					await context.executor.stopServer();
				} catch {
					// Ignore cleanup errors
				}
			}
			PortManager.releaseAllPorts();
		}
	} else {
		// STANDARD MODE: Use engine.execute directly
		// Create progress spinner
		const spinner = new ProgressSpinner(
			"Deep planning in progress",
			Array.from({ length: maxParallel }, (_, i) => `PL-${i + 1}`),
		);

		// Process issues in parallel batches
		const batches: Issue[][] = [];
		for (let i = 0; i < plannableIssues.length; i += maxParallel) {
			batches.push(plannableIssues.slice(i, i + maxParallel));
		}

		let batchNum = 0;
		for (const batch of batches) {
			batchNum++;
			logInfo(
				`Batch ${batchNum}/${batches.length}: Planning ${batch.length} issue(s) in parallel...`,
			);

			// Create a map to track agent progress
			const agentProgress = new Map<number, string>();

			const results = await Promise.all(
				batch.map(async (issue, idx) => {
					const agentNum = idx + 1;
					// Create engine per agent to prevent prompt corruption when running concurrently
					const agentEngine = await createEngine(options.aiEngine as AIEngineName);
					return planSingleIssueDeep(issue, agentEngine, workDir, options, agentNum, (step) => {
						agentProgress.set(agentNum, step);
						const progressStr = Array.from(agentProgress.entries())
							.map(([num, s]) => `PL-${num}: ${s.slice(0, 20)}`)
							.join(" | ");
						spinner.updateStep(progressStr);
					});
				}),
			);

			// Process batch results
			for (let i = 0; i < batch.length; i++) {
				const issue = batch[i];
				const result = results[i];
				const agentNum = i + 1;

				totalInputTokens += result.inputTokens;
				totalOutputTokens += result.outputTokens;

				if (result.error) {
					errors.push(`PL-${agentNum} (${issue.id}): ${result.error}`);
					console.log(`  ${pc.red("✗")} Agent #${agentNum}: ${issue.id} - ${pc.red(result.error)}`);
					continue;
				}

				if (result.wbs) {
					// Load validation report for markdown generation
					const validationReport = loadValidationReport(issue.id, workDir);

					const planPath = processPlanResult(runId, issue, result.wbs, validationReport, workDir);
					planPaths.push(planPath);
					issuesPlanned++;
					tasksCreated += result.wbs.tasks.length;

					const durationSec = (result.durationMs / 1000).toFixed(1);
					const hasReport = validationReport ? pc.green("✓ report") : pc.yellow("○ no report");
					console.log(
						`  ${pc.green("✓")} Agent #${agentNum}: ${issue.id} - ${pc.green(`${result.wbs.tasks.length} tasks`)} (${durationSec}s) [${hasReport}]`,
					);
				} else {
					errors.push(`PL-${agentNum} (${issue.id}): Failed to parse WBS`);
					console.log(
						`  ${pc.red("✗")} Agent #${agentNum}: ${issue.id} - ${pc.red("Failed to parse WBS")}`,
					);
				}
			}
			console.log("");
		}

		if (errors.length > 0) {
			spinner.warn(`Planning completed with ${errors.length} error(s)`);
		} else {
			spinner.success(`Deep planning complete ${formatTokens(totalInputTokens, totalOutputTokens)}`);
		}
	}

	// Update run state using run-aware functions
	const nextPhase = issuesPlanned > 0 ? "exec" : "completed";
	updateRunPhaseInMeta(runId, nextPhase, workDir);
	updateRunStats(runId, { tasks_total: loadTasksForRun(runId, workDir).length }, workDir);

	const duration = Date.now() - startTime;

	// Sync legacy plans view after all writes
	if (planPaths.length > 0) {
		syncLegacyPlansView(workDir);
		logDebug("Synced legacy plans view");
	}

	// Summary
	console.log("");
	console.log("=".repeat(60));
	logInfo("Deep Planning Summary:");
	console.log(`  Issues planned:    ${pc.cyan(String(issuesPlanned))}`);
	console.log(`  Tasks created:     ${pc.green(String(tasksCreated))}`);
	console.log(`  Duration:          ${formatDuration(duration)}`);
	console.log(`  Plans directory:   ${pc.cyan(getCurrentPlansDir(workDir))}`);
	console.log("=".repeat(60));

	if (planPaths.length > 0) {
		console.log("");
		logInfo("Generated Plans:");
		for (const path of planPaths) {
			console.log(`  ${pc.cyan(path)}`);
		}
	}

	if (errors.length > 0) {
		console.log("");
		logWarn("Errors encountered:");
		for (const err of errors) {
			console.log(`  - ${pc.red(err)}`);
		}
	}

	if (issuesPlanned > 0) {
		console.log("");
		logSuccess(`Run ${pc.cyan("milhouse consolidate")} to merge plans into unified Execution Plan`);
	}

	return {
		success: errors.length === 0,
		issuesPlanned,
		tasksCreated,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		planPaths,
		error: errors.length > 0 ? errors.join("; ") : undefined,
	};
}

/**
 * Process WBS result - save markdown and create tasks
 */
function processPlanResult(
	runId: string,
	issue: Issue,
	wbs: ParsedWBS,
	validationReport: DeepValidationReport | null,
	workDir: string,
): string {
	// Generate and save WBS markdown using PlanStore with run ID
	const markdown = generateWBSMarkdown(issue, wbs, validationReport, workDir);
	const planPath = writeIssueWbsPlanForRun(workDir, runId, issue.id, markdown);
	logDebug(`Wrote WBS plan to ${planPath}`);

	// Also save the raw WBS JSON for reference using PlanStore with run ID
	const wbsJsonPath = writeIssueWbsJsonForRun(workDir, runId, issue.id, wbs);
	logDebug(`Wrote WBS JSON to ${wbsJsonPath}`);

	// Create tasks in state for this specific run
	const createdTaskIds: string[] = [];
	for (let i = 0; i < wbs.tasks.length; i++) {
		const wbsTask = wbs.tasks[i];

		// Convert depends_on indices to task IDs
		const dependsOn = wbsTask.depends_on
			.map((dep) => {
				const depIndex = typeof dep === "string" ? Number.parseInt(dep, 10) : dep;
				if (depIndex >= 0 && depIndex < createdTaskIds.length) {
					return createdTaskIds[depIndex];
				}
				return null;
			})
			.filter((id): id is string => id !== null);

		const task = createTaskForRun(
			runId,
			{
				issue_id: issue.id,
				title: wbsTask.title,
				description: wbsTask.description,
				files: wbsTask.files || [],
				depends_on: dependsOn,
				checks: wbsTask.checks || [],
				acceptance: (wbsTask.acceptance || []).map((a) => ({
					description: a.description,
					check_command: a.check_command,
					verified: false,
				})),
				risk: wbsTask.risk,
				rollback: wbsTask.rollback,
				parallel_group: wbsTask.parallel_group || 0,
				status: "pending",
			},
			workDir,
		);

		createdTaskIds.push(task.id);
	}

	// Update issue with related task IDs for this specific run
	updateIssueForRun(
		runId,
		issue.id,
		{
			related_task_ids: [...issue.related_task_ids, ...createdTaskIds],
		},
		workDir,
	);

	logDebug(`Created ${createdTaskIds.length} tasks for issue ${issue.id}`);

	return planPath;
}
