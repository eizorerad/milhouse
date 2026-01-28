/**
 * @fileoverview Validation Round Orchestration Module
 *
 * Functions for orchestrating validation rounds:
 * - sleep: Utility function for retry delays
 * - getIssuesToValidateForRound: Get issues needing validation for current round
 * - executeValidationRound: Execute a single round of validation
 *
 * @module cli/commands/utils/validation-round
 */

import { writeFileSync } from "node:fs";
import pLimit from "p-limit";
import pc from "picocolors";
import type { RuntimeOptions } from "../../../config/index.ts";
import { createEngine } from "../../../engines/index.ts";
import type { AIEngineName } from "../../../engines/types.ts";
import { buildFilterOptionsFromRuntime, filterIssues, loadIssues, updateIssueFromValidation } from "../../../state/issues.ts";
import type { Evidence, Issue, IssueStatus } from "../../../state/types.ts";
import { logDebug } from "../../../ui/logger.ts";
import { DynamicAgentSpinner } from "../../../ui/spinners.ts";
import type { DeepValidationReport, ValidationRoundResult } from "./validation-types.ts";
import { generateMarkdownReport, saveValidationReport } from "./validation-report.ts";

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
