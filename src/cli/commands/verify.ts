import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { RuntimeOptions } from "../../config/index.ts";
import { getConfigService } from "../../services/config/ConfigService.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName, AIResult } from "../../engines/types.ts";
import { validateCheckCommand } from "../../gates/dod.ts";
import { loadExecutions } from "../../state/executions.ts";
import {
	getMilhouseDir,
	initializeDir,
	updateProgress,
} from "../../state/manager.ts";
import { updateRunPhaseInMeta } from "../../state/runs.ts";
import { loadTasksForRun, saveTasksForRun } from "../../state/tasks.ts";
import { AGENT_ROLES, type Evidence, type GateResult, type Task } from "../../state/types.ts";
import { selectOrRequireRun } from "./utils/run-selector.ts";
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

/**
 * Result of verification
 */
export interface VerifyResult {
	success: boolean;
	gatesRun: number;
	gatesPassed: number;
	gatesFailed: number;
	issues: VerificationIssue[];
	inputTokens: number;
	outputTokens: number;
	error?: string;
}

/**
 * Individual verification issue found
 */
export interface VerificationIssue {
	gate: string;
	severity: "ERROR" | "WARNING";
	file?: string;
	line?: number;
	message: string;
	evidence?: Evidence;
}

/**
 * Gate definitions
 */
export const GATES = {
	evidence: "Evidence Gate - No claims without proof",
	diffHygiene: "Diff Hygiene Gate - No silent refactors",
	placeholder: "Placeholder Gate - No TODO/mock/stubs",
	envConsistency: "Environment Consistency Gate - Probes required for infra issues",
	dod: "Definition of Done Gate - All acceptance criteria verifiable",
} as const;

export type GateName = keyof typeof GATES;

/**
 * Patterns to detect placeholders
 */
const PLACEHOLDER_PATTERNS = [
	/TODO\s*[:(\[]?/i,
	/FIXME\s*[:(\[]?/i,
	/HACK\s*[:(\[]?/i,
	/XXX\s*[:(\[]?/i,
	/\breturn\s+true\s*;?\s*\/\/.*placeholder/i,
	/\breturn\s+false\s*;?\s*\/\/.*placeholder/i,
	/\breturn\s+null\s*;?\s*\/\/.*placeholder/i,
	/\bthrow\s+new\s+Error\s*\(\s*["']Not implemented["']\s*\)/i,
	/\bthrow\s+new\s+Error\s*\(\s*["']TODO["']\s*\)/i,
	/\.skip\s*\(/,
	/\.only\s*\(/,
	/mock\s*\(\s*\)/i,
	/stub\s*\(\s*\)/i,
];

/**
 * File extensions to check for placeholders
 */
const CODE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
];

/**
 * Build the Truth Verifier prompt for verification
 */
export function buildVerifierPrompt(
	tasks: Task[],
	issues: VerificationIssue[],
	workDir: string,
): string {
	const parts: string[] = [];

	parts.push(`## Role: Truth Verifier (TV)
${AGENT_ROLES.TV}

You are verifying the execution results of completed tasks.
Your job is to ensure all changes are legitimate, complete, and meet quality standards.`);

	const configService = getConfigService(workDir);
	const config = configService.getConfig();
	
	// Build project context from config
	if (config) {
		const contextParts: string[] = [];
		if (config.project.name) contextParts.push(`Project: ${config.project.name}`);
		if (config.project.language) contextParts.push(`Language: ${config.project.language}`);
		if (config.project.framework) contextParts.push(`Framework: ${config.project.framework}`);
		if (config.project.description) contextParts.push(`Description: ${config.project.description}`);
		
		if (contextParts.length > 0) {
			parts.push(`## Project Context
${contextParts.join("\n")}`);
		}
	}

	if (config) {
		if (config.commands.test) {
			parts.push(`Test command: ${config.commands.test}`);
		}
		if (config.commands.lint) {
			parts.push(`Lint command: ${config.commands.lint}`);
		}
		if (config.commands.build) {
			parts.push(`Build command: ${config.commands.build}`);
		}
	}

	const completedTasks = tasks.filter((t) => t.status === "done");
	const failedTasks = tasks.filter((t) => t.status === "failed");

	parts.push(`## Execution Summary

**Completed Tasks**: ${completedTasks.length}
**Failed Tasks**: ${failedTasks.length}
**Total Tasks**: ${tasks.length}`);

	if (completedTasks.length > 0) {
		parts.push(`### Completed Tasks

${completedTasks.map((t) => `- **${t.id}**: ${t.title}`).join("\n")}`);
	}

	if (issues.length > 0) {
		parts.push(`## Pre-check Issues Found

The following issues were detected by automated gates:

${issues.map((i) => `- **[${i.severity}]** ${i.gate}: ${i.message}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : ""}`).join("\n")}`);
	}

	parts.push(`## Verification Task

1. Review the completed tasks and verify their implementation
2. Check that all acceptance criteria are met
3. Verify no regressions were introduced
4. Confirm all tests pass
5. Ensure no placeholder code remains

## Output Format

Respond with JSON in this exact format:

\`\`\`json
{
  "overall_pass": true|false,
  "gates": [
    {
      "gate": "evidence|diffHygiene|placeholder|envConsistency|dod",
      "passed": true|false,
      "message": "Description of findings",
      "evidence": []
    }
  ],
  "recommendations": ["List of recommendations if any"],
  "regressions_found": false,
  "summary": "Brief summary of verification results"
}
\`\`\``);

	return parts.join("\n\n");
}

/**
 * Run the placeholder gate - check for TODO/mock/stub code
 */
export function runPlaceholderGate(runId: string, workDir: string): GateResult {
	const issues: VerificationIssue[] = [];
	const evidence: Evidence[] = [];

	const milDir = getMilhouseDir(workDir);
	const stateDir = join(milDir, "state");

	if (!existsSync(stateDir)) {
		return {
			gate: "placeholder",
			passed: true,
			message: "No state directory found",
			evidence: [],
			timestamp: new Date().toISOString(),
		};
	}

	const tasks = loadTasksForRun(runId, workDir);
	const completedTasks = tasks.filter((t) => t.status === "done");
	const filesToCheck = new Set<string>();

	for (const task of completedTasks) {
		for (const file of task.files) {
			const ext = file.substring(file.lastIndexOf("."));
			if (CODE_EXTENSIONS.includes(ext)) {
				filesToCheck.add(file);
			}
		}
	}

	for (const file of filesToCheck) {
		const fullPath = join(workDir, file);
		if (!existsSync(fullPath)) {
			continue;
		}

		try {
			const content = readFileSync(fullPath, "utf-8");
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				for (const pattern of PLACEHOLDER_PATTERNS) {
					if (pattern.test(line)) {
						issues.push({
							gate: "placeholder",
							severity: "ERROR",
							file,
							line: i + 1,
							message: `Placeholder found: ${line.trim().slice(0, 80)}`,
						});
						evidence.push({
							type: "file",
							file,
							line_start: i + 1,
							line_end: i + 1,
							output: line.trim(),
							timestamp: new Date().toISOString(),
						});
					}
				}
			}
		} catch (error) {
			logDebug(`Failed to read file ${file}: ${error}`);
		}
	}

	return {
		gate: "placeholder",
		passed: issues.length === 0,
		message:
			issues.length === 0 ? "No placeholders found" : `Found ${issues.length} placeholder(s)`,
		evidence,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Run the diff hygiene gate - check for silent refactors
 */
export function runDiffHygieneGate(runId: string, workDir: string): GateResult {
	const evidence: Evidence[] = [];
	const tasks = loadTasksForRun(runId, workDir);
	const completedTasks = tasks.filter((t) => t.status === "done");

	const declaredFiles = new Set<string>();
	for (const task of completedTasks) {
		for (const file of task.files) {
			declaredFiles.add(file);
		}
	}

	const executions = loadExecutions(workDir);
	let silentChanges = 0;

	for (const exec of executions) {
		const task = tasks.find((t) => t.id === exec.task_id);
		if (!task || task.status !== "done") {
			continue;
		}

		// Check if execution has files that weren't declared in the task
		// Note: Currently executions don't track changed files, so this is a placeholder
		// that checks if the execution has a branch (indicating work was done)
		// but the task has no declared files (potential silent refactor)
		if (exec.branch && task.files.length === 0) {
			silentChanges++;
			evidence.push({
				type: "file",
				output: `Task ${task.id} completed on branch ${exec.branch} but has no declared files`,
				timestamp: new Date().toISOString(),
			});
			logDebug(`Execution ${exec.id} has branch ${exec.branch} but task declares no files`);
		}
	}

	return {
		gate: "diffHygiene",
		passed: silentChanges === 0,
		message:
			silentChanges === 0
				? "No silent refactors detected"
				: `Found ${silentChanges} potential silent change(s)`,
		evidence,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Run the evidence gate - verify claims have proof
 */
export function runEvidenceGate(runId: string, workDir: string): GateResult {
	const evidence: Evidence[] = [];
	const tasks = loadTasksForRun(runId, workDir);
	const completedTasks = tasks.filter((t) => t.status === "done");
	let missingEvidence = 0;

	for (const task of completedTasks) {
		if (task.acceptance.length === 0) {
			continue;
		}

		const unverified = task.acceptance.filter((a) => !a.verified);
		if (unverified.length > 0) {
			missingEvidence += unverified.length;
			evidence.push({
				type: "file",
				output: `Task ${task.id} has ${unverified.length} unverified acceptance criteria`,
				timestamp: new Date().toISOString(),
			});
		}
	}

	return {
		gate: "evidence",
		passed: missingEvidence === 0,
		message:
			missingEvidence === 0
				? "All claims have evidence"
				: `${missingEvidence} acceptance criteria unverified`,
		evidence,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Execute a check_command and return success status
 */
function executeCheckCommand(
	command: string,
	workDir: string,
	options?: { unsafeDoDChecks?: boolean },
): { success: boolean; skipped?: boolean; reason?: string } {
	// Validate the command before execution unless explicitly disabled
	if (!options?.unsafeDoDChecks) {
		const validation = validateCheckCommand(command);
		if (!validation.valid) {
			logWarn(`Skipping unsafe command: ${command}`);
			for (const issue of validation.issues) {
				logDebug(`  - ${issue}`);
			}
			return { success: false, skipped: true, reason: validation.issues.join("; ") };
		}

		// Surface warnings in verbose mode (not blocking)
		if (validation.warnings.length > 0) {
			for (const w of validation.warnings) {
				logDebug(`DoD check_command warning: ${w} (cmd: ${command})`);
			}
		}
	}

	try {
			execSync(command, {
			cwd: workDir,
			stdio: "pipe",
			timeout: 30000, // 30 second timeout per command
		});
		return { success: true };
	} catch {
		return { success: false };
	}
}

/**
 * Run the DoD gate - verify all acceptance criteria by executing check_commands
 * This will automatically run check_commands and update verified status
 */
export function runDoDGate(runId: string, workDir: string, options?: { unsafeDoDChecks?: boolean }): GateResult {
	const evidence: Evidence[] = [];
	const tasks = loadTasksForRun(runId, workDir);
	const completedTasks = tasks.filter((t) => t.status === "done");

	let totalCriteria = 0;
	let verifiedCriteria = 0;
	let tasksModified = false;

	for (const task of completedTasks) {
		for (const criterion of task.acceptance) {
			totalCriteria++;

			// If already verified, count it
			if (criterion.verified) {
				verifiedCriteria++;
				continue;
			}

			// If has check_command, run it to verify
			if (criterion.check_command) {
				logDebug(`Running check: ${criterion.check_command}`);
				const result = executeCheckCommand(criterion.check_command, workDir, options);

				if (result.success) {
					criterion.verified = true;
					tasksModified = true;
					verifiedCriteria++;
					logDebug(`✓ Check passed: ${criterion.description}`);
				} else if (result.skipped) {
					evidence.push({
						type: "command",
						command: criterion.check_command,
						output: `Task ${task.id}: "${criterion.description}" - check_command skipped (unsafe): ${result.reason}`,
						timestamp: new Date().toISOString(),
					});
					logDebug(`⚠ Check skipped: ${criterion.description}`);
				} else {
					evidence.push({
						type: "command",
						command: criterion.check_command,
						output: `Task ${task.id}: "${criterion.description}" - check_command failed`,
						timestamp: new Date().toISOString(),
					});
					logDebug(`✗ Check failed: ${criterion.description}`);
				}
			} else {
				// No check_command defined, mark as unverified
				evidence.push({
					type: "file",
					output: `Task ${task.id}: "${criterion.description}" - no check_command defined`,
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	// Save updated tasks with verified status if any were modified
	if (tasksModified) {
		saveTasksForRun(runId, tasks, workDir);
		logDebug(`Updated ${verifiedCriteria} verified criteria in tasks.json`);
	}

	const passed = totalCriteria === 0 || verifiedCriteria === totalCriteria;

	return {
		gate: "dod",
		passed,
		message:
			totalCriteria === 0
				? "No acceptance criteria defined"
				: `${verifiedCriteria}/${totalCriteria} criteria verified`,
		evidence,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Run the environment consistency gate
 */
export function runEnvConsistencyGate(workDir: string): GateResult {
	const milDir = getMilhouseDir(workDir);
	const probesDir = join(milDir, "probes");

	if (!existsSync(probesDir)) {
		return {
			gate: "envConsistency",
			passed: true,
			message: "No probes directory found",
			evidence: [],
			timestamp: new Date().toISOString(),
		};
	}

	const probeTypes = existsSync(probesDir)
		? readdirSync(probesDir).filter((f) => {
				const path = join(probesDir, f);
				return existsSync(path) && statSync(path).isDirectory();
			})
		: [];

	return {
		gate: "envConsistency",
		passed: true,
		message: `${probeTypes.length} probe type(s) available`,
		evidence: [],
		timestamp: new Date().toISOString(),
	};
}

/**
 * Run all gates
 *
 * IMPORTANT: Order matters! DoD gate must run before Evidence gate
 * because DoD gate executes check_commands and updates verified status,
 * while Evidence gate checks that verified status.
 */
export function runAllGates(runId: string, workDir: string): GateResult[] {
	return [
		runPlaceholderGate(runId, workDir),
		runDiffHygieneGate(runId, workDir),
		runDoDGate(runId, workDir),          // Must run BEFORE Evidence gate (executes check_commands)
		runEvidenceGate(runId, workDir),     // Checks verified status (set by DoD gate)
		runEnvConsistencyGate(workDir),
	];
}

/**
 * Parse verification result from AI response
 */
interface ParsedVerification {
	overall_pass: boolean;
	gates: Array<{
		gate: string;
		passed: boolean;
		message: string;
		evidence?: Evidence[];
	}>;
	recommendations: string[];
	regressions_found: boolean;
	summary: string;
}

function parseVerificationFromResponse(response: string): ParsedVerification | null {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		logDebug("Failed to extract JSON from verification response");
		return null;
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed.overall_pass !== "boolean") {
			return null;
		}

		return {
			overall_pass: parsed.overall_pass,
			gates: parsed.gates || [],
			recommendations: parsed.recommendations || [],
			regressions_found: parsed.regressions_found || false,
			summary: parsed.summary || "",
		};
	} catch {
		return null;
	}
}

/**
 * Run the verify command - Truth Verifier agent
 *
 * Runs gates and checks for regressions after execution.
 */
export async function runVerify(options: RuntimeOptions): Promise<VerifyResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	setVerbose(options.verbose);
	initializeDir(workDir);

	// Select or require a run - verify operates on existing runs in exec or verify phase
	const runSelection = await selectOrRequireRun(options.runId, workDir, {
		requirePhase: ["exec", "verify"],
	});

	if (!runSelection) {
		logError("No active run found. Run the previous pipeline steps first.");
		return {
			success: false,
			gatesRun: 0,
			gatesPassed: 0,
			gatesFailed: 0,
			issues: [],
			inputTokens: 0,
			outputTokens: 0,
			error: "No active run",
		};
	}

	const { runId, runMeta: currentRunMeta } = runSelection;
	let currentRun = currentRunMeta;

	const tasks = loadTasksForRun(runId, workDir);
	const completedTasks = tasks.filter((t) => t.status === "done");
	const failedTasks = tasks.filter((t) => t.status === "failed");

	if (completedTasks.length === 0 && failedTasks.length === 0) {
		logWarn("No completed or failed tasks found. Nothing to verify.");
		return {
			success: true,
			gatesRun: 0,
			gatesPassed: 0,
			gatesFailed: 0,
			issues: [],
			inputTokens: 0,
			outputTokens: 0,
		};
	}

	const updatedRun = updateRunPhaseInMeta(runId, "verify", workDir);
	if (updatedRun) {
		currentRun = updatedRun;
	}

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
			gatesRun: 0,
			gatesPassed: 0,
			gatesFailed: 0,
			issues: [],
			inputTokens: 0,
			outputTokens: 0,
			error: `${engine.name} not available`,
		};
	}

	logInfo(`Starting verification with ${engine.name}`);
	logInfo(`Role: ${AGENT_ROLES.TV}`);
	logInfo(`Completed tasks: ${completedTasks.length}`);
	logInfo(`Failed tasks: ${failedTasks.length}`);
	console.log("");

	const spinner = new ProgressSpinner("Running verification gates", ["TV"]);

	spinner.updateStep("Running automated gates");
	// Pass through unsafe DoD option so DoD check_command are not blocked if requested
	const gateResults = [
		runPlaceholderGate(runId, workDir),
		runDiffHygieneGate(runId, workDir),
		runDoDGate(runId, workDir, { unsafeDoDChecks: options.unsafeDoDChecks }),
		runEvidenceGate(runId, workDir),
		runEnvConsistencyGate(workDir),
	];

	const gatesPassed = gateResults.filter((g) => g.passed).length;
	const gatesFailed = gateResults.filter((g) => !g.passed).length;

	const issues: VerificationIssue[] = [];
	for (const gate of gateResults) {
		if (!gate.passed) {
			for (const ev of gate.evidence) {
				issues.push({
					gate: gate.gate,
					severity: "ERROR",
					file: ev.file,
					line: ev.line_start,
					message: ev.output || gate.message || "Gate check failed",
					evidence: ev,
				});
			}
			if (gate.evidence.length === 0) {
				issues.push({
					gate: gate.gate,
					severity: "ERROR",
					message: gate.message || "Gate check failed",
				});
			}
		}
	}

	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	spinner.updateStep("Running AI verification");
	const prompt = buildVerifierPrompt(tasks, issues, workDir);

	let aiVerification: ParsedVerification | null = null;
	try {
		let result: AIResult;
		if (engine.executeStreaming) {
			result = await engine.executeStreaming(
				prompt,
				workDir,
				(step) => {
					if (!step) {
						spinner.updateStep("TV: Verifying");
					} else if (typeof step === "string") {
						spinner.updateStep(`TV: ${step}`);
					} else {
						// DetailedStep object - let the spinner handle it properly
						spinner.updateStep(step);
					}
				},
				{ modelOverride: options.modelOverride },
			);
		} else {
			result = await engine.execute(prompt, workDir, {
				modelOverride: options.modelOverride,
			});
		}

		totalInputTokens = result.inputTokens;
		totalOutputTokens = result.outputTokens;

		if (result.success && result.response) {
			aiVerification = parseVerificationFromResponse(result.response);
		}
	} catch (error) {
		logDebug(`AI verification failed: ${error}`);
	}

	const allGatesPassed = gatesFailed === 0;
	const aiPassed = aiVerification?.overall_pass ?? true;
	const overallSuccess = allGatesPassed && aiPassed && failedTasks.length === 0;

	const finalPhase = overallSuccess ? "completed" : "failed";
	const finalRun = updateRunPhaseInMeta(runId, finalPhase, workDir);
	if (finalRun) {
		currentRun = finalRun;
	}

	const duration = Date.now() - startTime;

	if (overallSuccess) {
		spinner.success(`Verification passed ${formatTokens(totalInputTokens, totalOutputTokens)}`);
	} else {
		spinner.warn("Verification completed with issues");
	}

	console.log("");
	console.log("=".repeat(50));
	logInfo("Verification Summary:");
	console.log(`  Gates run:       ${pc.cyan(String(gateResults.length))}`);
	console.log(`  Gates passed:    ${pc.green(String(gatesPassed))}`);
	console.log(`  Gates failed:    ${pc.red(String(gatesFailed))}`);
	console.log(`  Issues found:    ${pc.yellow(String(issues.length))}`);
	console.log(`  Duration:        ${formatDuration(duration)}`);
	console.log("=".repeat(50));

	console.log("");
	logInfo("Gate Results:");
	for (const gate of gateResults) {
		const status = gate.passed ? pc.green("✓ PASS") : pc.red("✗ FAIL");
		console.log(`  ${status} ${GATES[gate.gate as GateName] || gate.gate}`);
		if (!gate.passed && gate.message) {
			console.log(`         ${pc.dim(gate.message)}`);
		}
	}

	if (issues.length > 0) {
		console.log("");
		logWarn("Issues Found:");
		for (const issue of issues.slice(0, 10)) {
			const severity = issue.severity === "ERROR" ? pc.red("[ERROR]") : pc.yellow("[WARN]");
			console.log(`  ${severity} ${issue.message}`);
			if (issue.file) {
				console.log(`         ${pc.dim(`at ${issue.file}${issue.line ? `:${issue.line}` : ""}`)}`);
			}
		}
		if (issues.length > 10) {
			console.log(`  ${pc.dim(`... and ${issues.length - 10} more`)}`);
		}
	}

	if (aiVerification?.recommendations && aiVerification.recommendations.length > 0) {
		console.log("");
		logInfo("Recommendations:");
		for (const rec of aiVerification.recommendations) {
			console.log(`  - ${rec}`);
		}
	}

	if (overallSuccess) {
		console.log("");
		logSuccess("All verification checks passed!");
		logSuccess(`Run ${pc.cyan("milhouse export")} to export results`);
	} else {
		console.log("");
		logWarn("Verification failed. Please address the issues above.");
	}

	updateProgress(
		`Verification: ${gatesPassed}/${gateResults.length} gates passed, ${issues.length} issues`,
		workDir,
	);

	return {
		success: overallSuccess,
		gatesRun: gateResults.length,
		gatesPassed,
		gatesFailed,
		issues,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		error: overallSuccess ? undefined : "Verification failed",
	};
}
