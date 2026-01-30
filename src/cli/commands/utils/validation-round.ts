/**
 * @fileoverview Validation Round Orchestration Module
 *
 * Functions for orchestrating validation rounds:
 * - sleep: Utility function for retry delays
 * - getIssuesToValidateForRound: Get issues needing validation for current round
 * - executeValidationRound: Execute a single round of validation
 * - executeValidationRoundTmux: Execute a single round of validation using tmux mode
 *
 * @module cli/commands/utils/validation-round
 */

import { writeFileSync } from "node:fs";
import pLimit from "p-limit";
import pc from "picocolors";
import type { RuntimeOptions } from "../../../config/index.ts";
import { createEngine } from "../../../engines/index.ts";
import type { AIEngineName } from "../../../engines/types.ts";
import {
	OpencodeServerExecutor,
	PortManager,
	displayTmuxModeHeader,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	getMessageOptionsForPhase,
	type ServerInfo,
} from "../../../engines/opencode/index.ts";
import type { TmuxSessionManager } from "../../../engines/tmux/index.ts";
import { buildFilterOptionsFromRuntime, filterIssues, loadIssues, updateIssueFromValidation } from "../../../state/issues.ts";
import type { Evidence, Issue, IssueStatus } from "../../../state/types.ts";
import { logDebug, logInfo, logWarn } from "../../../ui/logger.ts";
import { DynamicAgentSpinner, ProgressSpinner } from "../../../ui/spinners.ts";
import type { DeepValidationReport, ValidationRoundResult } from "./validation-types.ts";
import { generateMarkdownReport, saveValidationReport } from "./validation-report.ts";
import { buildDeepIssueValidatorPrompt } from "./validation-prompt.ts";
import { extractJsonFromResponse } from "../../../utils/json-extractor.ts";

/**
 * Sleep utility for retry delays
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get issues that need validation for the current round
 *
 * @param workDir - Working directory
 * @param options - Runtime options with filters
 * @param round - Current round number - 1 for initial, 2+ for retries
 * @returns Array of issues to validate
 */
export function getIssuesToValidateForRound(
	workDir: string,
	options: RuntimeOptions,
	round: number,
): Issue[] {
	const issues = loadIssues(workDir);

	// Build filter options from CLI arguments
	const filterOptions = buildFilterOptionsFromRuntime(options, ["UNVALIDATED"]);
	let filtered = filterIssues(issues, filterOptions);

	// For retry rounds, only include issues that are still UNVALIDATED
	// This handles cases where some issues succeeded in round 1
	if (round > 1) {
		filtered = filtered.filter((issue) => issue.status === "UNVALIDATED");
	}

	return filtered;
}

/**
 * Validate a single issue with deep investigation
 * This is a function type definition for the callback parameter
 */
type ValidateSingleIssueFn = (
	issue: Issue,
	engine: Awaited<ReturnType<typeof createEngine>>,
	workDir: string,
	options: RuntimeOptions,
	agentNum: number,
	onProgress?: (step: string) => void,
) => Promise<{
	report: DeepValidationReport | null;
	inputTokens: number;
	outputTokens: number;
	error?: string;
	durationMs: number;
}>;

/**
 * Execute a single round of validation
 *
 * @param issues - Issues to validate in this round
 * @param workDir - Working directory
 * @param options - Runtime options
 * @param round - Current round number
 * @param maxParallel - Maximum parallel validators
 * @param validateSingleIssueDeep - Function to validate a single issue
 * @returns Round result with statistics
 */
export async function executeValidationRound(
	issues: Issue[],
	workDir: string,
	options: RuntimeOptions,
	round: number,
	maxParallel: number,
	validateSingleIssueDeep: ValidateSingleIssueFn,
): Promise<ValidationRoundResult> {
	const spinner = new DynamicAgentSpinner(
		maxParallel,
		issues.length,
		round === 1 ? "Deep validation in progress" : `Retry round ${round}`,
	);

	let inputTokens = 0;
	let outputTokens = 0;
	let validatedCount = 0;
	let confirmedCount = 0;
	let falseCount = 0;
	let partialCount = 0;
	let misdiagnosedCount = 0;
	const errors: string[] = [];
	const reports: DeepValidationReport[] = [];

	const limit = pLimit(maxParallel);
	let nextAgentNum = 0;

	const validationPromises = issues.map((issue) =>
		limit(async () => {
			nextAgentNum++;
			const agentNum = ((nextAgentNum - 1) % maxParallel) + 1;

			try {
				spinner.acquireSlot(issue.id);
			} catch {
				// Continue even if spinner fails
			}

			// Create engine per agent
			const agentEngine = await createEngine(options.aiEngine as AIEngineName);

			// Execute validation
			const result = await validateSingleIssueDeep(
				issue,
				agentEngine,
				workDir,
				options,
				agentNum,
				(step) => {
					const shortStatus =
						typeof step === "string" ? step.replace(/^Agent #\d+: /, "").slice(0, 15) : "thinking";
					spinner.updateSlot(agentNum, shortStatus);
				},
			);

			// Process result
			inputTokens += result.inputTokens;
			outputTokens += result.outputTokens;

			if (result.error) {
				errors.push(`IV-${agentNum} (${issue.id}): ${result.error}`);
				console.log(`  ${pc.red("✗")} IV-${agentNum}: ${issue.id} - ${pc.red(result.error)}`);
				spinner.releaseSlot(agentNum, false);
				return { success: false, issue };
			}

			if (result.report) {
				// Save detailed report
				const reportPath = saveValidationReport(result.report, workDir);
				reports.push(result.report);

				// Also save markdown report
				const mdReportPath = reportPath.replace(".json", ".md");
				const mdReport = generateMarkdownReport(result.report);
				writeFileSync(mdReportPath, mdReport);

				// Prepare validated evidence
				const validatedEvidence: Evidence[] = [];
				for (const ev of result.report.evidence || []) {
					const validTypes = ["file", "probe", "log", "command"] as const;
					const evType = validTypes.includes(ev.type as (typeof validTypes)[number])
						? (ev.type as (typeof validTypes)[number])
						: "file";

					const evidenceItem: Evidence = {
						type: evType,
						timestamp: ev.timestamp || new Date().toISOString(),
					};

					if (ev.file) evidenceItem.file = String(ev.file);
					if (typeof ev.line_start === "number") evidenceItem.line_start = ev.line_start;
					if (typeof ev.line_end === "number") evidenceItem.line_end = ev.line_end;
					if (ev.probe_id) evidenceItem.probe_id = String(ev.probe_id);
					if (ev.command) evidenceItem.command = String(ev.command);
					if (ev.output) evidenceItem.output = String(ev.output);

					validatedEvidence.push(evidenceItem);
				}

				// Validate severity
				const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
				const reportedSeverity = result.report.impact_assessment.actual_severity;
				const validatedSeverity =
					reportedSeverity && validSeverities.includes(reportedSeverity)
						? (reportedSeverity as Issue["severity"])
						: issue.severity;

				// Validate status
				const validStatuses = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] as const;
				const validatedStatus = validStatuses.includes(
					result.report.status as (typeof validStatuses)[number],
				)
					? result.report.status
					: ("UNVALIDATED" as IssueStatus);

				// Update issue using concurrent-safe function
				await updateIssueFromValidation(
					issue.id,
					{
						status: validatedStatus,
						evidence: validatedEvidence,
						corrected_description: result.report.corrected_description,
						validated_by: "IV",
						severity: validatedSeverity,
						strategy: result.report.recommendations.fix_approach,
					},
					workDir,
				);

				validatedCount++;

				// Count by status and log
				switch (result.report.status) {
					case "CONFIRMED":
						confirmedCount++;
						console.log(
							`  ${pc.red("●")} IV-${agentNum}: ${issue.id} - ${pc.red("CONFIRMED")} (${result.report.confidence} confidence)`,
						);
						break;
					case "FALSE":
						falseCount++;
						console.log(
							`  ${pc.green("✓")} IV-${agentNum}: ${issue.id} - ${pc.green("FALSE POSITIVE")}`,
						);
						break;
					case "PARTIAL":
						partialCount++;
						console.log(
							`  ${pc.yellow("◐")} IV-${agentNum}: ${issue.id} - ${pc.yellow("PARTIAL")} (${result.report.confidence} confidence)`,
						);
						break;
					case "MISDIAGNOSED":
						misdiagnosedCount++;
						console.log(
							`  ${pc.magenta("◑")} IV-${agentNum}: ${issue.id} - ${pc.magenta("MISDIAGNOSED")}`,
						);
						break;
				}

				logDebug(`  Report saved: ${reportPath}`);
			}

			spinner.releaseSlot(agentNum, true);
			return { success: true, issue, report: result.report };
		}),
	);

	await Promise.all(validationPromises);

	// Count remaining UNVALIDATED issues
	const updatedIssues = loadIssues(workDir);
	const unvalidatedCount = updatedIssues.filter((i) => i.status === "UNVALIDATED").length;

	spinner.success();

	return {
		round,
		validatedCount,
		unvalidatedCount,
		confirmedCount,
		falseCount,
		partialCount,
		misdiagnosedCount,
		inputTokens,
		outputTokens,
		errors,
		reports,
	};
}

/**
 * Parse deep validation report from AI response
 */
function parseDeepValidationFromResponse(
	response: string,
	issueId: string,
): DeepValidationReport | null {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		logDebug(`Failed to extract JSON from deep validation response for ${issueId}`);
		return null;
	}

	try {
		const parsed = JSON.parse(jsonStr);

		// Ensure issue_id matches
		if (parsed.issue_id !== issueId) {
			parsed.issue_id = issueId;
		}

		// Set defaults for missing fields
		return {
			issue_id: parsed.issue_id,
			status: parsed.status || "UNVALIDATED",
			confidence: parsed.confidence || "LOW",
			summary: parsed.summary || "No summary provided",
			investigation: {
				files_examined: parsed.investigation?.files_examined || [],
				commands_run: parsed.investigation?.commands_run || [],
				patterns_found: parsed.investigation?.patterns_found || [],
				related_code: parsed.investigation?.related_code || [],
			},
			root_cause_analysis: {
				confirmed_cause: parsed.root_cause_analysis?.confirmed_cause,
				alternative_causes: parsed.root_cause_analysis?.alternative_causes || [],
				why_not_false_positive: parsed.root_cause_analysis?.why_not_false_positive,
			},
			impact_assessment: {
				severity_confirmed: parsed.impact_assessment?.severity_confirmed ?? false,
				actual_severity: parsed.impact_assessment?.actual_severity,
				affected_components: parsed.impact_assessment?.affected_components || [],
				user_impact: parsed.impact_assessment?.user_impact,
				security_implications: parsed.impact_assessment?.security_implications,
			},
			reproduction: {
				reproducible: parsed.reproduction?.reproducible ?? false,
				steps: parsed.reproduction?.steps || [],
				conditions: parsed.reproduction?.conditions,
			},
			recommendations: {
				fix_approach: parsed.recommendations?.fix_approach || "No fix approach provided",
				estimated_complexity: parsed.recommendations?.estimated_complexity || "MEDIUM",
				prerequisites: parsed.recommendations?.prerequisites || [],
				test_strategy: parsed.recommendations?.test_strategy,
			},
			evidence: parsed.evidence || [],
			corrected_description: parsed.corrected_description,
		};
	} catch (error) {
		logDebug("Failed to parse deep validation JSON:", error);
		return null;
	}
}

/**
 * Execute a single round of validation using tmux mode with OpenCode servers
 *
 * This function implements a proper work queue pattern where:
 * - N servers are started (where N = min(maxParallel, issues.length))
 * - Each server handles ONE issue at a time
 * - When a server completes, it pulls the next issue from the queue
 * - This prevents multiple issues from being queued in the same OpenCode session
 *
 * @param issues - Issues to validate in this round
 * @param workDir - Working directory
 * @param options - Runtime options
 * @param round - Current round number
 * @param maxParallel - Maximum parallel validators
 * @param tmuxManager - Tmux session manager
 * @param runId - Current run ID
 * @returns Round result with statistics
 */
export async function executeValidationRoundTmux(
	issues: Issue[],
	workDir: string,
	options: RuntimeOptions,
	round: number,
	maxParallel: number,
	tmuxManager: TmuxSessionManager,
	runId: string,
): Promise<ValidationRoundResult> {
	let inputTokens = 0;
	let outputTokens = 0;
	let validatedCount = 0;
	let confirmedCount = 0;
	let falseCount = 0;
	let partialCount = 0;
	let misdiagnosedCount = 0;
	const errors: string[] = [];
	const reports: DeepValidationReport[] = [];

	// Limit parallel agents to the number of issues or maxParallel
	const actualParallel = Math.min(maxParallel, issues.length);

	// Track executors, server info, and session IDs separately
	interface AgentContext {
		executor: OpencodeServerExecutor;
		serverInfo: ServerInfo;
		sessionId: string;
		agentNum: number;
	}
	const agentContexts: AgentContext[] = [];

	// Create progress spinner for tmux mode
	const spinner = new ProgressSpinner(
		round === 1 ? "Deep validation in progress (tmux mode)" : `Retry round ${round} (tmux mode)`,
		Array.from({ length: actualParallel }, (_, i) => `IV-${i + 1}`),
	);

	logInfo(`Starting ${actualParallel} OpenCode servers for validation...`);

	try {
		// Start servers - one per agent, NOT one per issue
		// Each server will handle multiple issues sequentially
		for (let i = 0; i < actualParallel; i++) {
			const agentNum = i + 1;

			// Update spinner to show server startup progress
			spinner.updateStep(`Starting server ${agentNum}/${actualParallel}...`);

			const executor = new OpencodeServerExecutor({
				autoInstall: options.autoInstall ?? true,
				verbose: options.verbose,
			});

			// Start the OpenCode server
			const port = await executor.startServer(workDir);
			const url = `http://localhost:${port}`;

			// Create the session via the API
			const session = await executor.createSession({
				title: `Milhouse Validator Agent #${agentNum}`,
			});

			// Build unique tmux session name with round number to avoid conflicts on retry
			const tmuxSessionBaseName = `validate-IV${agentNum}-r${round}`;
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
				logWarn(`Failed to create tmux session for IV-${agentNum}: ${tmuxResult.error}`);
			}

			agentContexts.push({
				executor,
				serverInfo: {
					issueId: `IV-${agentNum}`, // Agent ID, not issue ID
					port,
					sessionName,
					status: "running",
					url,
				},
				sessionId: session.id,
				agentNum,
			});
		}

		// Display tmux mode header and attach instructions
		displayTmuxModeHeader();
		displayAttachInstructions(agentContexts.map((ctx) => ctx.serverInfo));
		console.log("");

		// Create a work queue - issues waiting to be processed
		const workQueue = [...issues];
		let workQueueIndex = 0;
		const workQueueLock = { locked: false };

		// Helper to get next issue from queue (thread-safe)
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
			context: AgentContext,
		): Promise<{ success: boolean; issue: Issue; report?: DeepValidationReport }> => {
			const { executor, sessionId, agentNum } = context;

			// Build the validation prompt
			const prompt = buildDeepIssueValidatorPrompt(issue, workDir, agentNum);

			logDebug(`Agent #${agentNum} validating issue ${issue.id} via OpenCode server`);

			// Update spinner to show we're waiting for OpenCode response
			spinner.updateStep(`IV-${agentNum}: Validating ${issue.id.slice(0, 12)}...`);

			try {
				// Send the prompt and wait for completion
				// Use autonomy config to prevent questions and restrict to read-only tools
				const response = await executor.sendMessage(
					sessionId,
					prompt,
					getMessageOptionsForPhase("validate", options.modelOverride)
				);

				// Update spinner to show we're processing the response
				spinner.updateStep(`IV-${agentNum}: Processing response...`);

				// Calculate tokens from response
				const respInputTokens = response.info.inputTokens ?? 0;
				const respOutputTokens = response.info.outputTokens ?? 0;
				inputTokens += respInputTokens;
				outputTokens += respOutputTokens;

				// Extract text from response parts
				const responseText = response.parts
					.filter((p) => p.type === "text")
					.map((p) => (p as { type: "text"; text: string }).text)
					.join("");

				// Parse the validation report
				const report = parseDeepValidationFromResponse(responseText, issue.id);

				if (report) {
					// Save detailed report
					const reportPath = saveValidationReport(report, workDir);
					reports.push(report);

					// Also save markdown report
					const mdReportPath = reportPath.replace(".json", ".md");
					const mdReport = generateMarkdownReport(report);
					writeFileSync(mdReportPath, mdReport);

					// Prepare validated evidence
					const validatedEvidence: Evidence[] = [];
					for (const ev of report.evidence || []) {
						const validTypes = ["file", "probe", "log", "command"] as const;
						const evType = validTypes.includes(ev.type as (typeof validTypes)[number])
							? (ev.type as (typeof validTypes)[number])
							: "file";

						const evidenceItem: Evidence = {
							type: evType,
							timestamp: ev.timestamp || new Date().toISOString(),
						};

						if (ev.file) evidenceItem.file = String(ev.file);
						if (typeof ev.line_start === "number") evidenceItem.line_start = ev.line_start;
						if (typeof ev.line_end === "number") evidenceItem.line_end = ev.line_end;
						if (ev.probe_id) evidenceItem.probe_id = String(ev.probe_id);
						if (ev.command) evidenceItem.command = String(ev.command);
						if (ev.output) evidenceItem.output = String(ev.output);

						validatedEvidence.push(evidenceItem);
					}

					// Validate severity
					const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
					const reportedSeverity = report.impact_assessment.actual_severity;
					const validatedSeverity =
						reportedSeverity && validSeverities.includes(reportedSeverity)
							? (reportedSeverity as Issue["severity"])
							: issue.severity;

					// Validate status
					const validStatuses = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] as const;
					const validatedStatus = validStatuses.includes(
						report.status as (typeof validStatuses)[number],
					)
						? report.status
						: ("UNVALIDATED" as IssueStatus);

					// Update issue using concurrent-safe function
					await updateIssueFromValidation(
						issue.id,
						{
							status: validatedStatus,
							evidence: validatedEvidence,
							corrected_description: report.corrected_description,
							validated_by: "IV",
							severity: validatedSeverity,
							strategy: report.recommendations.fix_approach,
						},
						workDir,
					);

					validatedCount++;

					// Count by status and log
					switch (report.status) {
						case "CONFIRMED":
							confirmedCount++;
							console.log(
								`  ${pc.red("●")} IV-${agentNum}: ${issue.id} - ${pc.red("CONFIRMED")} (${report.confidence} confidence)`,
							);
							break;
						case "FALSE":
							falseCount++;
							console.log(
								`  ${pc.green("✓")} IV-${agentNum}: ${issue.id} - ${pc.green("FALSE POSITIVE")}`,
							);
							break;
						case "PARTIAL":
							partialCount++;
							console.log(
								`  ${pc.yellow("◐")} IV-${agentNum}: ${issue.id} - ${pc.yellow("PARTIAL")} (${report.confidence} confidence)`,
							);
							break;
						case "MISDIAGNOSED":
							misdiagnosedCount++;
							console.log(
								`  ${pc.magenta("◑")} IV-${agentNum}: ${issue.id} - ${pc.magenta("MISDIAGNOSED")}`,
							);
							break;
					}

					logDebug(`  Report saved: ${reportPath}`);
					return { success: true, issue, report };
				} else {
					errors.push(`IV-${agentNum} (${issue.id}): Failed to parse validation response`);
					console.log(
						`  ${pc.red("✗")} IV-${agentNum}: ${issue.id} - ${pc.red("Failed to parse response")}`,
					);
					return { success: false, issue };
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				errors.push(`IV-${agentNum} (${issue.id}): ${errorMsg}`);
				console.log(`  ${pc.red("✗")} IV-${agentNum}: ${issue.id} - ${pc.red(errorMsg)}`);
				return { success: false, issue };
			}
		};

		// Worker function - each agent runs this to process issues from the queue
		const runWorker = async (context: AgentContext): Promise<void> => {
			while (true) {
				const issue = getNextIssue();
				if (!issue) {
					// No more work
					spinner.updateStep(`IV-${context.agentNum}: Done`);
					break;
				}
				await processIssue(issue, context);
			}
		};

		// Start all workers - each processes issues sequentially from the shared queue
		// This ensures each server handles ONE issue at a time
		const workerPromises = agentContexts.map((context) => runWorker(context));
		await Promise.all(workerPromises);

		// Display completion summary
		const completedServerInfos: ServerInfo[] = agentContexts.map((ctx) => ({
			...ctx.serverInfo,
			status: "completed" as const,
		}));
		displayTmuxCompletionSummary(completedServerInfos);

		// Mark spinner as successful
		spinner.success(`Validation complete`);

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

	// Count remaining UNVALIDATED issues
	const updatedIssues = loadIssues(workDir);
	const unvalidatedCount = updatedIssues.filter((i) => i.status === "UNVALIDATED").length;

	return {
		round,
		validatedCount,
		unvalidatedCount,
		confirmedCount,
		falseCount,
		partialCount,
		misdiagnosedCount,
		inputTokens,
		outputTokens,
		errors,
		reports,
	};
}
