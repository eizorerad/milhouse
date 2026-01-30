import pc from "picocolors";
import type { RuntimeOptions } from "../../config/index.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngine, AIEngineName, AIResult } from "../../engines/types.ts";
import {
	OpencodeServerExecutor,
	PortManager,
	displayTmuxModeHeader,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	type ServerInfo,
} from "../../engines/opencode/index.ts";
import { TmuxSessionManager, ensureTmuxInstalled, getInstallationInstructions } from "../../engines/tmux/index.ts";
import { buildFilterOptionsFromRuntime, filterIssues, loadIssuesForRun, updateIssueForRun } from "../../state/issues.ts";
import {
	syncLegacyPlansView,
	writeProblemBriefForRun,
} from "../../state/plan-store.ts";
import { generateId, initializeDir } from "../../state/manager.ts";
import {
	updateRunPhaseInMeta,
	updateRunStats,
} from "../../state/runs.ts";
import { saveProbeResult } from "../../state/probes.ts";
import {
	AGENT_ROLES,
	type Evidence,
	type Issue,
	type IssueStatus,
	type ProbeResult,
} from "../../state/types.ts";
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
import type { ProgressSpinner } from "../../ui/spinners.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { formatProbeResultsForPrompt, runApplicableProbes } from "./utils/probeIntegration.ts";
import type {
	DeepValidationReport,
	ParsedValidation,
	ValidateResult,
	ValidationRetryConfig,
	ValidationRoundResult,
} from "./utils/validation-types.ts";
import {
	buildDeepIssueValidatorPrompt,
	buildIssueValidatorPrompt,
} from "./utils/validation-prompt.ts";
import {
	generateMarkdownReport,
	getValidationReportsDir,
	saveValidationReport,
} from "./utils/validation-report.ts";
import { generateValidatedProblemBrief } from "./utils/problem-brief.ts";
import {
	executeValidationRound,
	executeValidationRoundTmux,
	getIssuesToValidateForRound,
	sleep,
} from "./utils/validation-round.ts";
import { selectOrRequireRun } from "./utils/run-selector.ts";

/**
 * Default number of parallel validation agents
 */
const DEFAULT_PARALLEL_VALIDATORS = 5;

/**
 * Parse validation result from AI response
 */
function parseValidationFromResponse(response: string, issueId: string): ParsedValidation | null {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		logDebug(`Failed to extract JSON from validation response for ${issueId}`);
		return null;
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (!isValidParsedValidation(parsed)) {
			logWarn(`Invalid validation response structure for ${issueId}`);
			return null;
		}

		// Ensure issue_id matches
		if (parsed.issue_id !== issueId) {
			logDebug(`Issue ID mismatch: expected ${issueId}, got ${parsed.issue_id}`);
			parsed.issue_id = issueId;
		}

		return parsed;
	} catch (error) {
		logDebug("Failed to parse JSON validation response:", error);

		// Try to find JSON object in the response
		const objectMatch = response.match(/\{\s*"issue_id"[\s\S]*?\}\s*\]/);
		if (objectMatch) {
			try {
				// Add closing brace if needed
				let jsonAttempt = objectMatch[0];
				if (!jsonAttempt.endsWith("}")) {
					jsonAttempt += "}";
				}
				const parsed = JSON.parse(jsonAttempt);
				if (isValidParsedValidation(parsed)) {
					return parsed;
				}
			} catch {
				// Fall through
			}
		}

		return null;
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

	if (typeof obj.issue_id !== "string" || obj.issue_id.trim() === "") {
		return false;
	}

	const validStatuses: IssueStatus[] = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"];
	if (typeof obj.status !== "string" || !validStatuses.includes(obj.status as IssueStatus)) {
		return false;
	}

	// Evidence should be an array if present
	if (obj.evidence !== undefined && !Array.isArray(obj.evidence)) {
		return false;
	}

	return true;
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
 * Validate a single issue with deep investigation
 */
async function validateSingleIssueDeep(
	issue: Issue,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
	agentNum: number,
	onProgress?: (step: string) => void,
): Promise<{
	report: DeepValidationReport | null;
	inputTokens: number;
	outputTokens: number;
	error?: string;
	durationMs: number;
}> {
	const startTime = Date.now();

	// Run probes before validation (unless skipped)
	let probeEvidence: string | undefined;
	if (!options.skipProbes) {
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
	} else {
		logDebug(`Agent #${agentNum}: Skipping probes (--skip-probes flag set)`);
	}

	const prompt = buildDeepIssueValidatorPrompt(issue, workDir, agentNum, probeEvidence);

	logDebug(`Agent #${agentNum} validating issue ${issue.id}: ${issue.symptom.slice(0, 50)}...`);

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
						onProgress?.(`Agent #${agentNum}: Investigating`);
					}
				},
				{ modelOverride: options.modelOverride },
			);
		} else {
			onProgress?.(`Agent #${agentNum}: Executing deep validation`);
			result = await engine.execute(prompt, workDir, {
				modelOverride: options.modelOverride,
			});
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			report: null,
			inputTokens: 0,
			outputTokens: 0,
			error: errorMsg,
			durationMs: Date.now() - startTime,
		};
	}

	if (!result.success) {
		return {
			report: null,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			error: result.error || "Unknown error",
			durationMs: Date.now() - startTime,
		};
	}

	const report = parseDeepValidationFromResponse(result.response, issue.id);
	if (report) {
		report.validation_duration_ms = Date.now() - startTime;
	}

	return {
		report,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		durationMs: Date.now() - startTime,
	};
}

/**
 * Validate a single issue (legacy wrapper for backwards compatibility)
 */
async function validateSingleIssue(
	issue: Issue,
	engine: AIEngine,
	workDir: string,
	options: RuntimeOptions,
	spinner: ProgressSpinner,
): Promise<{
	validation: ParsedValidation | null;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}> {
	const result = await validateSingleIssueDeep(issue, engine, workDir, options, 0, (step) => {
		spinner.updateStep(step);
	});

	if (result.report) {
		// Convert deep report to legacy ParsedValidation format
		return {
			validation: {
				issue_id: result.report.issue_id,
				status: result.report.status,
				corrected_description: result.report.corrected_description,
				evidence: result.report.evidence,
			},
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
		};
	}

	return {
		validation: null,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		error: result.error,
	};
}

/**
 * Run the validate command - Issue Validator agents with DEEP parallel validation
 *
 * Each issue is validated by a dedicated agent in parallel (default: 5 agents).
 * Each agent performs thorough investigation and generates a detailed report.
 * Updates issue status to CONFIRMED, FALSE, PARTIAL, or MISDIAGNOSED.
 *
 * Supports automatic retry for UNVALIDATED issues (default: 2 retries).
 */
export async function runValidate(options: RuntimeOptions): Promise<ValidateResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Initialize milhouse directory if needed
	initializeDir(workDir);

	// Select or require a run using explicit run ID or interactive selection
	let runId: string;
	let runMeta;
	try {
		const selection = await selectOrRequireRun(options.runId, workDir, {
			requirePhase: ["scan", "validate"],
		});
		runId = selection.runId;
		runMeta = selection.runMeta;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logError(errorMsg);
		return {
			success: false,
			issuesValidated: 0,
			issuesConfirmed: 0,
			issuesFalse: 0,
			issuesPartial: 0,
			issuesMisdiagnosed: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: "No active run",
		};
	}

	// Build retry configuration from options
	const retryConfig: ValidationRetryConfig = {
		maxRetries: options.maxValidationRetries ?? 2,
		enabled: options.retryUnvalidated ?? true,
		delayMs: options.retryDelayValidation ?? 2000,
	};

	// Load issues for initial check using run-aware function
	const issues = loadIssuesForRun(runId, workDir);

	// Build filter options from CLI arguments
	const filterOptions = buildFilterOptionsFromRuntime(options, ["UNVALIDATED"]);
	const initialUnvalidatedIssues = filterIssues(issues, filterOptions);

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

	if (initialUnvalidatedIssues.length === 0) {
		logWarn("No unvalidated issues found. Nothing to validate.");
		return {
			success: true,
			issuesValidated: 0,
			issuesConfirmed: 0,
			issuesFalse: 0,
			issuesPartial: 0,
			issuesMisdiagnosed: 0,
			inputTokens: 0,
			outputTokens: 0,
		};
	}

	// Update phase to validate using run-aware function
	updateRunPhaseInMeta(runId, "validate", workDir);

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
			issuesValidated: 0,
			issuesConfirmed: 0,
			issuesFalse: 0,
			issuesPartial: 0,
			issuesMisdiagnosed: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: `${engine.name} not available`,
		};
	}

	// Determine parallelism - DEFAULT to parallel with 5 agents
	const maxParallel =
		options.maxParallel > 0
			? Math.min(options.maxParallel, initialUnvalidatedIssues.length, DEFAULT_PARALLEL_VALIDATORS)
			: Math.min(DEFAULT_PARALLEL_VALIDATORS, initialUnvalidatedIssues.length);

	logInfo(`Starting DEEP validation with ${engine.name} (engine: ${options.aiEngine})`);
	logInfo(`Mode: ${pc.cyan(`${maxParallel} parallel agents`)} (each agent = 1 issue)`);
	logInfo(`Role: ${AGENT_ROLES.IV}`);
	logInfo(`Issues to validate: ${initialUnvalidatedIssues.length}`);
	if (retryConfig.enabled) {
		logInfo(
			`Retry: ${pc.cyan(`enabled`)} (max ${retryConfig.maxRetries} retries, ${retryConfig.delayMs}ms delay)`,
		);
	} else {
		logInfo(`Retry: ${pc.gray(`disabled`)}`);
	}

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

	// Track cumulative results across all rounds
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalValidated = 0;
	let totalConfirmed = 0;
	let totalFalse = 0;
	let totalPartial = 0;
	let totalMisdiagnosed = 0;
	const allErrors: string[] = [];
	const allReports: DeepValidationReport[] = [];

	// Run validation rounds
	let currentRound = 1;
	const maxRounds = retryConfig.enabled ? retryConfig.maxRetries + 1 : 1;
	let totalRounds = 0;

	while (currentRound <= maxRounds) {
		// Get issues to validate for this round
		const issuesToValidate = getIssuesToValidateForRound(workDir, options, currentRound);

		if (issuesToValidate.length === 0) {
			if (currentRound === 1) {
				logWarn("No unvalidated issues found. Nothing to validate.");
			} else {
				logSuccess(`All issues validated after ${currentRound - 1} round(s)`);
			}
			break;
		}

		// Log round info
		if (currentRound > 1) {
			console.log("");
			logInfo(
				`[RETRY] Round ${currentRound}/${maxRounds}: Retrying ${issuesToValidate.length} UNVALIDATED issue(s)`,
			);
			await sleep(retryConfig.delayMs);
		} else {
			logInfo(`Starting validation round 1: ${issuesToValidate.length} issue(s)`);
		}
		console.log("");

		// Execute validation for this round - choose between tmux and standard mode
		let roundResult: ValidationRoundResult;
		if (tmuxEnabled && tmuxManager) {
			// TMUX MODE: Use OpenCode server with tmux sessions
			roundResult = await executeValidationRoundTmux(
				issuesToValidate,
				workDir,
				options,
				currentRound,
				maxParallel,
				tmuxManager,
				runId,
			);
		} else {
			// STANDARD MODE: Use engine.execute directly
			roundResult = await executeValidationRound(
				issuesToValidate,
				workDir,
				options,
				currentRound,
				maxParallel,
				validateSingleIssueDeep,
			);
		}

		// Accumulate results
		totalInputTokens += roundResult.inputTokens;
		totalOutputTokens += roundResult.outputTokens;
		totalValidated += roundResult.validatedCount;
		totalConfirmed += roundResult.confirmedCount;
		totalFalse += roundResult.falseCount;
		totalPartial += roundResult.partialCount;
		totalMisdiagnosed += roundResult.misdiagnosedCount;
		allErrors.push(...roundResult.errors);
		allReports.push(...roundResult.reports);
		totalRounds = currentRound;

		// Log round summary
		if (roundResult.validatedCount > 0) {
			logInfo(`Round ${currentRound} completed: ${roundResult.validatedCount} issue(s) validated`);
		}

		// Check if we should continue
		if (roundResult.unvalidatedCount === 0) {
			logSuccess(`All issues validated in round ${currentRound}`);
			break;
		}

		// Check if retry is disabled or max rounds reached
		if (!retryConfig.enabled || currentRound >= maxRounds) {
			if (roundResult.unvalidatedCount > 0) {
				logWarn(
					`[RETRY] Max retries (${retryConfig.maxRetries}) reached. ${roundResult.unvalidatedCount} issue(s) remain UNVALIDATED`,
				);
			}
			break;
		}

		currentRound++;
	}

	// Generate updated Problem Brief using PlanStore (run-aware)
	const allIssues = loadIssuesForRun(runId, workDir);
	const problemBriefContent = generateValidatedProblemBrief(allIssues, runId);
	const problemBriefPath = writeProblemBriefForRun(workDir, runId, problemBriefContent);
	logDebug(`Problem Brief written to: ${problemBriefPath}`);

	// Sync legacy plans view for backward compatibility
	syncLegacyPlansView(workDir);
	logDebug("Legacy plans view synced");

	// Count final unvalidated
	const finalUnvalidated = allIssues.filter((i) => i.status === "UNVALIDATED").length;

	// Update run state using run-aware functions
	const nextPhase = totalConfirmed > 0 || totalPartial > 0 ? "plan" : "completed";
	updateRunPhaseInMeta(runId, nextPhase, workDir);
	updateRunStats(runId, { issues_validated: totalValidated }, workDir);

	const duration = Date.now() - startTime;

	// Summary
	console.log("");
	console.log("=".repeat(60));
	logInfo("Deep Validation Summary:");
	console.log(`  Issues validated:  ${pc.cyan(String(totalValidated))}`);
	console.log(`  ${pc.red("●")} Confirmed:       ${pc.red(String(totalConfirmed))}`);
	console.log(`  ${pc.green("✓")} False positives: ${pc.green(String(totalFalse))}`);
	console.log(`  ${pc.yellow("◐")} Partial:         ${pc.yellow(String(totalPartial))}`);
	console.log(`  ${pc.magenta("◑")} Misdiagnosed:    ${pc.magenta(String(totalMisdiagnosed))}`);
	if (finalUnvalidated > 0) {
		console.log(`  ${pc.gray("○")} Unvalidated:     ${pc.gray(String(finalUnvalidated))}`);
	}
	console.log(`  Validation rounds: ${pc.cyan(String(totalRounds))}`);
	console.log(`  Duration:          ${formatDuration(duration)}`);
	console.log(`  Tokens:            ${formatTokens(totalInputTokens, totalOutputTokens)}`);
	console.log(`  Problem Brief:     ${pc.cyan(problemBriefPath)}`);
	console.log(`  Validation Reports: ${pc.cyan(getValidationReportsDir(workDir))}`);
	console.log("=".repeat(60));

	if (allErrors.length > 0) {
		console.log("");
		logWarn("Errors encountered:");
		for (const err of allErrors) {
			console.log(`  - ${pc.red(err)}`);
		}
	}

	// Show high-confidence confirmed issues
	const highConfidenceConfirmed = allReports.filter(
		(r) => r.status === "CONFIRMED" && r.confidence === "HIGH",
	);
	if (highConfidenceConfirmed.length > 0) {
		console.log("");
		logInfo(`High-confidence issues requiring attention (${highConfidenceConfirmed.length}):`);
		for (const report of highConfidenceConfirmed) {
			console.log(`  ${pc.red("●")} ${report.issue_id}: ${report.summary.slice(0, 60)}...`);
		}
	}

	if (totalConfirmed > 0 || totalPartial > 0) {
		console.log("");
		logSuccess(`Run ${pc.cyan("milhouse plan")} to generate WBS for confirmed issues`);
	} else if (totalFalse === totalValidated && totalValidated > 0) {
		console.log("");
		logSuccess("All issues were false positives. No planning needed.");
	}

	return {
		success: allErrors.length === 0,
		issuesValidated: totalValidated,
		issuesConfirmed: totalConfirmed,
		issuesFalse: totalFalse,
		issuesPartial: totalPartial,
		issuesMisdiagnosed: totalMisdiagnosed,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		error: allErrors.length > 0 ? allErrors.join("; ") : undefined,
	};
}

/**
 * Process validation result from deep report and update issue
 */
function processValidationResultFromReport(
	runId: string,
	issue: Issue,
	report: DeepValidationReport,
	workDir: string,
): void {
	// Prepare evidence with proper timestamps
	const evidence: Evidence[] = (report.evidence || []).map((ev) => ({
		...ev,
		timestamp: ev.timestamp || new Date().toISOString(),
	}));

	// Update the issue with comprehensive data from deep report
	updateIssueForRun(
		runId,
		issue.id,
		{
			status: report.status,
			corrected_description: report.corrected_description,
			evidence: [...issue.evidence, ...evidence],
			validated_by: "IV",
			// Store additional metadata from deep validation
			severity: (report.impact_assessment.actual_severity as Issue["severity"]) || issue.severity,
			strategy: report.recommendations.fix_approach,
		},
		workDir,
	);

	logDebug(
		`Issue ${issue.id} deep-validated as ${report.status} (${report.confidence} confidence)`,
	);
}

/**
 * Process validation result and update issue
 */
function processValidationResult(
	runId: string,
	issue: Issue,
	validation: ParsedValidation,
	workDir: string,
): void {
	// Prepare evidence with proper timestamps
	const evidence: Evidence[] = (validation.evidence || []).map((ev) => ({
		...ev,
		timestamp: ev.timestamp || new Date().toISOString(),
	}));

	// Save probe results if any
	if (validation.probe_results) {
		for (const probeOutput of validation.probe_results) {
			const probeResult: ProbeResult = {
				probe_id: generateId("probe"),
				probe_type: "validation",
				success: true,
				output: probeOutput,
				timestamp: new Date().toISOString(),
				read_only: true,
				findings: [],
			};
			saveProbeResult(probeResult, workDir);

			// Add probe reference to evidence
			evidence.push({
				type: "probe",
				probe_id: probeResult.probe_id,
				timestamp: probeResult.timestamp,
			});
		}
	}

	// Update the issue
	updateIssueForRun(
		runId,
		issue.id,
		{
			status: validation.status,
			corrected_description: validation.corrected_description,
			evidence: [...issue.evidence, ...evidence],
			validated_by: "IV",
		},
		workDir,
	);

	logDebug(`Issue ${issue.id} validated as ${validation.status}`);
}
