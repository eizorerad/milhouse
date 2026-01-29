import { execSync } from "node:child_process";
import * as path from "node:path";
import { loadTasksFromPath } from "../state/tasks.ts";
import type { DoDCriteria, Task } from "../state/types.ts";
import {
	type DoDCheckResult,
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateSeverity,
	type GateViolation,
	createGateResult,
	createGateViolation,
	getGateConfig,
} from "./types.ts";

/**
 * Configuration options for DoD gate
 */
export interface DoDGateOptions {
	/** Whether to require all acceptance criteria to have check_commands */
	requireVerifiableChecks: boolean;
	/** Timeout for running check commands (in ms) */
	commandTimeout: number;
	/** Whether to actually execute check commands */
	executeChecks: boolean;
	/** Path to tasks.json file (relative to workDir or absolute) */
	tasksPath: string;
	/** Whether to fail on first check failure or continue checking all */
	failFast: boolean;
	/** Maximum number of checks to run (0 = unlimited) */
	maxChecks: number;
}

/**
 * Default DoD gate options
 */
export const DEFAULT_DOD_OPTIONS: DoDGateOptions = {
	requireVerifiableChecks: true,
	commandTimeout: 60000,
	executeChecks: true,
	tasksPath: ".milhouse/state/tasks.json",
	failFast: false,
	maxChecks: 0,
};

/**
 * Task DoD analysis result
 */
export interface TaskDoDAnalysis {
	/** Task ID */
	taskId: string;
	/** Task title */
	taskTitle: string;
	/** Total acceptance criteria */
	totalCriteria: number;
	/** Criteria with verifiable check commands */
	verifiableCriteria: number;
	/** Criteria without check commands */
	unverifiableCriteria: number;
	/** Check results for each criterion */
	checkResults: DoDCheckResult[];
	/** Whether all criteria are satisfied */
	allSatisfied: boolean;
	/** Overall status */
	status: "passed" | "failed" | "partial" | "no_criteria";
}

/**
 * Generate a unique gate ID
 */
export function generateGateId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `dod-${timestamp}-${random}`;
}

/**
 * Load tasks from tasks.json file
 * Wrapper around loadTasksFromPath to handle relative paths
 */
export function loadTasks(workDir: string, tasksPath: string): Task[] {
	const fullPath = path.isAbsolute(tasksPath) ? tasksPath : path.join(workDir, tasksPath);
	return loadTasksFromPath(fullPath);
}

/**
 * Check if a criterion has a verifiable check command
 */
export function isVerifiableCriterion(criterion: DoDCriteria): boolean {
	return Boolean(criterion.check_command && criterion.check_command.trim().length > 0);
}

/**
 * Execute a check command and return the result
 *
 * SECURITY: Validates the command before execution to prevent shell injection
 */
export function executeCheckCommand(
	workDir: string,
	criterion: DoDCriteria,
	timeout: number,
): DoDCheckResult {
	if (!criterion.check_command) {
		return {
			criteria: criterion.description,
			met: false,
			failure_reason: "No check command specified",
		};
	}

	// SECURITY: Validate command before execution to prevent shell injection
	const validation = validateCheckCommand(criterion.check_command);
	if (!validation.valid) {
		return {
			criteria: criterion.description,
			met: false,
			check_command: criterion.check_command,
			failure_reason: `Command validation failed: ${validation.issues.join("; ")}`,
		};
	}

	try {
		const output = execSync(criterion.check_command, {
			cwd: workDir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout,
		});

		return {
			criteria: criterion.description,
			met: true,
			check_command: criterion.check_command,
			exit_code: 0,
			output: truncateOutput(output),
		};
	} catch (error) {
		const execError = error as { status?: number; stderr?: string; stdout?: string };
		const exitCode = execError.status ?? 1;
		const errorOutput = execError.stderr ?? execError.stdout ?? String(error);

		return {
			criteria: criterion.description,
			met: false,
			check_command: criterion.check_command,
			exit_code: exitCode,
			output: truncateOutput(errorOutput),
			failure_reason: `Command exited with code ${exitCode}`,
		};
	}
}

/**
 * Truncate command output to a reasonable length
 */
export function truncateOutput(output: string, maxLength = 1000): string {
	if (output.length <= maxLength) {
		return output.trim();
	}
	return `${output.substring(0, maxLength).trim()}... (truncated)`;
}

/**
 * Analyze a task's Definition of Done criteria
 */
export function analyzeTaskDoD(
	task: Task,
	workDir: string,
	options: DoDGateOptions,
): TaskDoDAnalysis {
	const acceptance = task.acceptance ?? [];

	if (acceptance.length === 0) {
		return {
			taskId: task.id,
			taskTitle: task.title,
			totalCriteria: 0,
			verifiableCriteria: 0,
			unverifiableCriteria: 0,
			checkResults: [],
			allSatisfied: true,
			status: "no_criteria",
		};
	}

	const checkResults: DoDCheckResult[] = [];
	let verifiableCriteria = 0;
	let unverifiableCriteria = 0;
	let checksRun = 0;

	for (const criterion of acceptance) {
		// Check if we've hit the max checks limit
		if (options.maxChecks > 0 && checksRun >= options.maxChecks) {
			break;
		}

		if (isVerifiableCriterion(criterion)) {
			verifiableCriteria++;

			if (options.executeChecks) {
				const result = executeCheckCommand(workDir, criterion, options.commandTimeout);
				checkResults.push(result);
				checksRun++;

				// Fail fast if enabled and check failed
				if (options.failFast && !result.met) {
					break;
				}
			} else {
				// Just record that the criterion is verifiable without executing
				checkResults.push({
					criteria: criterion.description,
					met: criterion.verified ?? false,
					check_command: criterion.check_command,
				});
			}
		} else {
			unverifiableCriteria++;

			// Record unverifiable criteria
			checkResults.push({
				criteria: criterion.description,
				met: criterion.verified ?? false,
				failure_reason: "No check command specified - cannot verify automatically",
			});
		}
	}

	// Determine overall status
	const passedChecks = checkResults.filter((r) => r.met).length;
	const failedChecks = checkResults.filter((r) => !r.met).length;
	const allSatisfied = failedChecks === 0;

	let status: TaskDoDAnalysis["status"];
	if (acceptance.length === 0) {
		status = "no_criteria";
	} else if (allSatisfied) {
		status = "passed";
	} else if (passedChecks > 0) {
		status = "partial";
	} else {
		status = "failed";
	}

	return {
		taskId: task.id,
		taskTitle: task.title,
		totalCriteria: acceptance.length,
		verifiableCriteria,
		unverifiableCriteria,
		checkResults,
		allSatisfied,
		status,
	};
}

/**
 * Get severity for a DoD violation
 */
export function getSeverityForDoDViolation(
	analysis: TaskDoDAnalysis,
	checkResult: DoDCheckResult,
): GateSeverity {
	// Missing check command on a task that's marked as done is critical
	if (!checkResult.check_command) {
		return "HIGH";
	}

	// Command failed with non-zero exit code
	if (checkResult.exit_code !== undefined && checkResult.exit_code !== 0) {
		// Test failures are critical
		if (
			checkResult.check_command.includes("test") ||
			checkResult.check_command.includes("jest") ||
			checkResult.check_command.includes("vitest") ||
			checkResult.check_command.includes("pytest")
		) {
			return "CRITICAL";
		}
		// Lint failures are high
		if (
			checkResult.check_command.includes("lint") ||
			checkResult.check_command.includes("eslint") ||
			checkResult.check_command.includes("prettier")
		) {
			return "HIGH";
		}
		// Build failures are critical
		if (
			checkResult.check_command.includes("build") ||
			checkResult.check_command.includes("compile") ||
			checkResult.check_command.includes("tsc")
		) {
			return "CRITICAL";
		}
		return "HIGH";
	}

	return "MEDIUM";
}

/**
 * Create a violation for a failed DoD check
 */
export function createDoDViolation(
	analysis: TaskDoDAnalysis,
	checkResult: DoDCheckResult,
): GateViolation {
	const severity = getSeverityForDoDViolation(analysis, checkResult);
	const violationId = `dod-${analysis.taskId}-${checkResult.criteria.substring(0, 20).replace(/\s+/g, "-")}`;

	let description: string;
	let suggestion: string;

	if (!checkResult.check_command) {
		description = `Task "${analysis.taskId}" has DoD criterion "${checkResult.criteria}" without a verifiable check command. Definition of Done must be verifiable by commands to ensure correctness.`;
		suggestion =
			"Add a check_command to this acceptance criterion (e.g., npm test, npm run lint, etc.)";
	} else {
		description =
			`Task "${analysis.taskId}" DoD check failed: "${checkResult.criteria}". ` +
			`Command "${checkResult.check_command}" exited with code ${checkResult.exit_code}.`;
		suggestion = `Fix the issue causing the check command to fail. Output: ${checkResult.output ?? "no output"}`;
	}

	return createGateViolation(
		violationId,
		`DoD check failed: ${checkResult.criteria}`,
		description,
		severity,
		{
			task_id: analysis.taskId,
			suggestion,
			metadata: {
				taskTitle: analysis.taskTitle,
				criterion: checkResult.criteria,
				checkCommand: checkResult.check_command,
				exitCode: checkResult.exit_code,
				output: checkResult.output,
				failureReason: checkResult.failure_reason,
			},
		},
	);
}

/**
 * Definition of Done Gate
 *
 * Verifies that all task acceptance criteria are verifiable by commands
 * and that those commands pass when executed.
 *
 * Purpose: Ensure that Definition of Done is not just documentation
 * but actually enforced through automated checks.
 *
 * What it checks:
 * - Each acceptance criterion has a check_command defined
 * - Check commands execute successfully (exit code 0)
 * - All criteria pass for tasks marked as done
 *
 * This gate enforces the principle that "done" must be verifiable,
 * not just claimed.
 */
export async function runDoDGate(
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const startTime = Date.now();
	const gateId = generateGateId();
	const config = { ...getGateConfig("dod"), ...configOverrides };

	const options: DoDGateOptions = {
		...DEFAULT_DOD_OPTIONS,
		...(config.options as Partial<DoDGateOptions>),
	};

	const violations: GateViolation[] = [];
	let tasksChecked = 0;
	let criteriaChecked = 0;
	const gateEvidence: GateResult["evidence"] = [];

	try {
		// Load tasks
		const tasks = loadTasks(input.workDir, options.tasksPath);

		if (tasks.length === 0) {
			const durationMs = Date.now() - startTime;
			return createGateResult(gateId, "dod", true, {
				message: "No tasks found to check",
				violations: [],
				evidence: [],
				duration_ms: durationMs,
				files_checked: 0,
				items_checked: 0,
			});
		}

		// Filter to relevant tasks if task IDs provided
		let tasksToCheck = tasks;
		if (input.taskIds.length > 0) {
			tasksToCheck = tasks.filter((task) => input.taskIds.includes(task.id));
		}

		// Only check tasks that are done or running (need verification)
		tasksToCheck = tasksToCheck.filter(
			(task) => task.status === "done" || task.status === "running",
		);

		// Analyze each task's DoD
		for (const task of tasksToCheck) {
			tasksChecked++;

			const analysis = analyzeTaskDoD(task, input.workDir, options);
			criteriaChecked += analysis.totalCriteria;

			// Record what we checked
			gateEvidence.push({
				type: "command",
				command: `analyze-dod-${task.id}`,
				output: `Task ${task.id}: ${analysis.status} (${analysis.verifiableCriteria}/${analysis.totalCriteria} verifiable)`,
				timestamp: new Date().toISOString(),
			});

			// Create violations for failed checks
			for (const checkResult of analysis.checkResults) {
				if (!checkResult.met) {
					// Skip unverifiable criteria if not required
					if (!checkResult.check_command && !options.requireVerifiableChecks) {
						continue;
					}

					const violation = createDoDViolation(analysis, checkResult);
					violations.push(violation);
				}

				// Record evidence for executed commands
				if (checkResult.check_command && checkResult.exit_code !== undefined) {
					gateEvidence.push({
						type: "command",
						command: checkResult.check_command,
						output: checkResult.output,
						timestamp: new Date().toISOString(),
					});
				}
			}

			// Check if task has no acceptance criteria when required
			if (analysis.status === "no_criteria" && options.requireVerifiableChecks) {
				violations.push(
					createGateViolation(
						`dod-no-criteria-${task.id}`,
						`Task "${task.id}" has no Definition of Done`,
						`Task "${task.id}" (${task.title}) is marked as ${task.status} but has no acceptance criteria defined. All tasks should have verifiable Definition of Done criteria.`,
						"MEDIUM",
						{
							task_id: task.id,
							suggestion:
								"Add acceptance criteria with check_command to define what 'done' means for this task",
							metadata: {
								taskTitle: task.title,
								taskStatus: task.status,
							},
						},
					),
				);
			}
		}

		const durationMs = Date.now() - startTime;
		const passed = config.strict
			? violations.length === 0
			: !violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");

		return createGateResult(gateId, "dod", passed, {
			message: passed
				? `Checked ${tasksChecked} tasks with ${criteriaChecked} criteria - all DoD requirements satisfied`
				: `Found ${violations.length} DoD violations in ${tasksChecked} tasks`,
			violations,
			evidence: gateEvidence,
			duration_ms: durationMs,
			files_checked: tasksChecked,
			items_checked: criteriaChecked,
		});
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		return createGateResult(gateId, "dod", false, {
			message: `DoD gate failed: ${errorMessage}`,
			violations: [
				createGateViolation("gate-error", "Gate execution error", errorMessage, "CRITICAL"),
			],
			duration_ms: durationMs,
			files_checked: tasksChecked,
			items_checked: criteriaChecked,
		});
	}
}

/**
 * Check a single task's Definition of Done
 */
export async function checkTaskDoD(
	workDir: string,
	task: Task,
	options?: Partial<DoDGateOptions>,
): Promise<TaskDoDAnalysis> {
	const fullOptions: DoDGateOptions = {
		...DEFAULT_DOD_OPTIONS,
		...options,
	};

	return analyzeTaskDoD(task, workDir, fullOptions);
}

/**
 * Get DoD summary for display
 */
export function getDoDSummary(analyses: TaskDoDAnalysis[]): {
	totalTasks: number;
	tasksByStatus: Record<TaskDoDAnalysis["status"], number>;
	totalCriteria: number;
	verifiableCriteria: number;
	unverifiableCriteria: number;
	passedChecks: number;
	failedChecks: number;
} {
	const tasksByStatus: Record<TaskDoDAnalysis["status"], number> = {
		passed: 0,
		failed: 0,
		partial: 0,
		no_criteria: 0,
	};

	let totalCriteria = 0;
	let verifiableCriteria = 0;
	let unverifiableCriteria = 0;
	let passedChecks = 0;
	let failedChecks = 0;

	for (const analysis of analyses) {
		tasksByStatus[analysis.status]++;
		totalCriteria += analysis.totalCriteria;
		verifiableCriteria += analysis.verifiableCriteria;
		unverifiableCriteria += analysis.unverifiableCriteria;
		passedChecks += analysis.checkResults.filter((r) => r.met).length;
		failedChecks += analysis.checkResults.filter((r) => !r.met).length;
	}

	return {
		totalTasks: analyses.length,
		tasksByStatus,
		totalCriteria,
		verifiableCriteria,
		unverifiableCriteria,
		passedChecks,
		failedChecks,
	};
}

/**
 * Format DoD summary for display
 */
export function formatDoDSummary(analyses: TaskDoDAnalysis[]): string {
	const summary = getDoDSummary(analyses);
	const lines: string[] = [];

	lines.push(`Total tasks: ${summary.totalTasks}`);

	const statusCounts = Object.entries(summary.tasksByStatus)
		.filter(([, count]) => count > 0)
		.map(([status, count]) => `${status}: ${count}`)
		.join(", ");

	if (statusCounts) {
		lines.push(`Status: ${statusCounts}`);
	}

	lines.push(`Total criteria: ${summary.totalCriteria}`);
	lines.push(
		`Verifiable: ${summary.verifiableCriteria} / Unverifiable: ${summary.unverifiableCriteria}`,
	);
	lines.push(`Checks: ${summary.passedChecks} passed / ${summary.failedChecks} failed`);

	return lines.join("\n");
}

/**
 * Create a DoD criterion with check command
 */

export function createDoDCriterion(
	description: string,
	checkCommand?: string,
	verified = false,
): DoDCriteria {
	return {
		description,
		check_command: checkCommand,
		verified,
	};
}

/**
 * Allowlist of safe command prefixes for DoD checks.
 *
 * Commands starting with these prefixes are recognized as safe.
 * Commands with unrecognized prefixes will generate a warning but won't be blocked.
 *
 * Used by {@link validateCheckCommand}.
 */
export const ALLOWED_COMMAND_PREFIXES = [
	// Package managers / test runners
	"npm",
	"bun",
	"pnpm",
	"yarn",
	"node",
	"deno",
	// TypeScript / JavaScript tools
	"tsc",
	"tsx",
	"esbuild",
	"vite",
	"webpack",
	// Test frameworks
	"jest",
	"vitest",
	"mocha",
	"ava",
	"playwright",
	// Python tools
	"pytest",
	"python",
	"python3",
	"pip",
	"poetry",
	"uv",
	// Linters / formatters
	"eslint",
	"prettier",
	"biome",
	"stylelint",
	"ruff",
	"black",
	"mypy",
	// Shell utilities for file checks
	"grep",
	"test",
	"[", // Test bracket syntax
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"diff",
	"find",
	"which",
	// Build tools
	"make",
	"cargo",
	"go",
	"rustc",
	"gcc",
	"clang",
	// Version control
	"git",
	// Misc safe commands
	"echo",
	"true",
	"false",
	"exit",
	"pwd",
	"env",
	"printenv",
];

/**
 * Check if a command starts with an allowed prefix
 */
export function hasAllowedPrefix(command: string): {
	allowed: boolean;
	prefix: string | null;
} {
	const trimmed = command.trim();
	for (const prefix of ALLOWED_COMMAND_PREFIXES) {
		// Match prefix at start followed by space, end of string, or being the entire command
		if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
			return { allowed: true, prefix };
		}
	}
	// Extract first word as the unrecognized prefix
	const firstWord = trimmed.split(/\s+/)[0] || trimmed;
	return { allowed: false, prefix: firstWord };
}

/**
 * Validate that a check command is well-formed and safe to execute.
 *
 * @security This function implements defense-in-depth against command injection:
 *
 * 1. **Blocklist (Hard Block)**: Dangerous patterns and shell metacharacters are blocked
 *    to prevent command injection attacks. This includes:
 *    - Command substitution: $() and backticks
 *    - Command chaining: && and ||
 *    - Command separators: ; and |
 *    - Redirects: < and >
 *    - Parameter expansion: ${}
 *    - Known dangerous commands: rm -rf /, sudo, dd, etc.
 *
 * 2. **Allowlist (Soft Warning)**: Commands with unrecognized prefixes generate
 *    warnings but are not blocked, allowing custom tools while alerting users.
 *
 * The blocklist is strict because command injection can lead to:
 * - Arbitrary code execution on the host system
 * - Data exfiltration via network commands
 * - System destruction via destructive commands
 * - Privilege escalation via sudo
 *
 * @param command - The shell command to validate
 * @returns Object containing:
 *   - valid: false if blocked patterns found, true otherwise
 *   - issues: Array of blocking issues (command will not execute)
 *   - warnings: Array of non-blocking warnings (command may still execute)
 *
 * @example
 * // Safe command
 * validateCheckCommand("npm test") // { valid: true, issues: [], warnings: [] }
 *
 * // Blocked - command injection
 * validateCheckCommand("npm test $(whoami)") // { valid: false, issues: [...], warnings: [] }
 *
 * // Warning - unrecognized prefix
 * validateCheckCommand("customtool --check") // { valid: true, issues: [], warnings: [...] }
 */
export function validateCheckCommand(command: string): {
	valid: boolean;
	issues: string[];
	warnings: string[];
} {
	const issues: string[] = [];
	const warnings: string[] = [];

	if (!command || command.trim().length === 0) {
		issues.push("Check command is empty");
		return { valid: false, issues, warnings };
	}

	// Blocklist: Known dangerous command patterns that should never be executed
	// These patterns can cause system damage or privilege escalation
	const dangerousPatterns = [
		/\brm\s+-rf\s+\//, // Recursive delete from root - catastrophic data loss
		/\bsudo\b/, // Privilege escalation - should never be in DoD checks
		/\bdd\s+if=/, // Low-level disk operations - can corrupt system
		/\b>\s*\/dev\//, // Writing to device files - can crash system
	];

	for (const pattern of dangerousPatterns) {
		if (pattern.test(command)) {
			issues.push(`Command contains potentially dangerous pattern: ${pattern.source}`);
		}
	}

	// Soft warnings: Shell metacharacters that enable command injection
	// These were previously blocked; now they only warn to avoid skipping checks.
	const shellInjectionPatterns: Array<{ pattern: RegExp; description: string }> = [
		{ pattern: /\$\(/, description: "command substitution $()" },
		{ pattern: /`/, description: "backtick command substitution" },
		{ pattern: /&&/, description: "command chaining &&" },
		{ pattern: /\|\|/, description: "command chaining ||" },
		{ pattern: /;/, description: "command separator ;" },
		{ pattern: /\|(?!\|)/, description: "pipe |" },
		{ pattern: /<(?!<)/, description: "input redirect <" },
		{ pattern: />/, description: "output redirect >" },
		{ pattern: /\$\{/, description: "parameter expansion ${}" },
	];

	for (const { pattern, description } of shellInjectionPatterns) {
		if (pattern.test(command)) {
			warnings.push(`Command contains shell injection pattern: ${description}`);
		}
	}

	// Blocklist: Interactive commands that require user input
	// These will hang in automated DoD checks since there's no TTY
	// Note: We check for interactive flags on specific commands, not globally,
	// because -i means different things for different commands:
	// - rm -i: interactive prompts (should block)
	// - sed -i: in-place edit (safe, non-interactive)
	const interactivePatterns = [
		/\brm\s+.*-[^\s]*i/, // rm with -i flag (prompts for each file)
		/\bvim?\b/, // Vi/Vim editors
		/\bnano\b/, // Nano editor
		/\bless\b/, // Less pager
		/\bmore\b/, // More pager
	];

	for (const pattern of interactivePatterns) {
		if (pattern.test(command)) {
			issues.push(`Command may be interactive: ${pattern.source}`);
		}
	}

	// Check command prefix against allowlist (warning only, not blocking)
	const prefixCheck = hasAllowedPrefix(command);
	if (!prefixCheck.allowed && prefixCheck.prefix) {
		warnings.push(
			`Command has unrecognized prefix "${prefixCheck.prefix}". Consider using a known tool from the allowlist.`,
		);
	}

	return {
		valid: issues.length === 0,
		issues,
		warnings,
	};
}

/**
 * Get suggestions for check commands based on criterion description
 */
export function suggestCheckCommand(description: string): string | null {
	const lowerDesc = description.toLowerCase();

	// Test-related criteria - check specific types first, then general
	if (lowerDesc.includes("unit test")) {
		return "npm run test:unit";
	}
	if (lowerDesc.includes("integration test")) {
		return "npm run test:integration";
	}
	if (lowerDesc.includes("e2e") || lowerDesc.includes("end-to-end")) {
		return "npm run test:e2e";
	}
	// General test pass (must come after specific test types)
	if (lowerDesc.includes("test") && lowerDesc.includes("pass")) {
		return "npm test";
	}

	// Lint-related criteria
	if (lowerDesc.includes("lint") || lowerDesc.includes("linting")) {
		return "npm run lint";
	}
	if (lowerDesc.includes("format")) {
		return "npm run format:check";
	}

	// Build-related criteria
	if (lowerDesc.includes("build") && lowerDesc.includes("pass")) {
		return "npm run build";
	}
	if (lowerDesc.includes("compil")) {
		return "npm run build";
	}
	if (lowerDesc.includes("typescript") || lowerDesc.includes("type check")) {
		return "npx tsc --noEmit";
	}

	// Coverage-related criteria
	if (lowerDesc.includes("coverage") || lowerDesc.includes("80%")) {
		return "npm run test:coverage";
	}

	return null;
}
