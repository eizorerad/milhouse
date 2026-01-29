/**
 * @fileoverview Milhouse CLI Argument Parser
 *
 * This module provides the command-line argument parsing for Milhouse.
 * It uses Commander.js to define the CLI interface and parse arguments
 * into structured RuntimeOptions.
 *
 * @module cli/args
 *
 * @since 4.3.0
 *
 * @example
 * ```typescript
 * import { parseArgs, printHelp } from "./args.ts";
 *
 * const { options, task, runMode } = parseArgs(process.argv);
 * if (!task && !runMode) {
 *   printHelp();
 * }
 * ```
 */

import { existsSync, statSync } from "node:fs";
import { Command } from "commander";
import type { RuntimeOptions } from "./runtime-options.ts";
import type { Severity } from "../state/types.ts";
import { banner, theme } from "../ui/theme";
import { MILHOUSE_BRANDING, type MilhousePhase } from "./types.ts";

/**
 * Milhouse CLI version
 * @constant
 */
const VERSION = MILHOUSE_BRANDING.version;

/**
 * Create the Milhouse CLI program with all options
 *
 * @returns {Command} The configured Commander.js program
 *
 * @description
 * Creates and configures the main Milhouse CLI program with all available
 * commands and options. The program supports:
 *
 * - **Pipeline phases**: scan, validate, plan, consolidate, exec, verify
 * - **AI engines**: Aider, Claude, Gemini, OpenCode, Cursor, Codex, Qwen, Droid
 * - **Execution modes**: sequential, parallel, worktree-based
 * - **Task sources**: PRD markdown, YAML files, GitHub issues
 *
 * @example
 * ```typescript
 * const program = createProgram();
 * program.parse(process.argv);
 * const opts = program.opts();
 * ```
 */
export function createProgram(): Command {
	const program = new Command();

	program
		.name(MILHOUSE_BRANDING.shortName)
		.description(
			`${theme.muted(MILHOUSE_BRANDING.description)} - ${theme.dim("Supports ")}${theme.engine.aider("Aider")}${theme.dim(", ")}${theme.engine.claude("Claude")}${theme.dim(", ")}${theme.engine.gemini("Gemini")}${theme.dim(", ")}${theme.engine.opencode("OpenCode")}${theme.dim(", ")}${theme.engine.codex("Codex")}${theme.dim(", ")}${theme.engine.cursor("Cursor")}${theme.dim(", ")}${theme.engine.qwen("Qwen")}${theme.dim(" and ")}${theme.engine.droid("Droid")}`,
		)
		.version(VERSION)
		.argument("[task...]", "Single task to execute (brownfield mode), or 'runs' subcommand")
		.allowExcessArguments(true)
		.option("--init", `Initialize ${MILHOUSE_BRANDING.configDir}/ configuration`)
		.option("--config", "Show current Milhouse configuration")
		.option("--add-rule <rule>", "Add a rule to Milhouse config")
		.option("--scan", `Run ${theme.phase.scan("Lead Investigator")} to create Problem Brief v0`)
		.option(
			"--scope <focus>",
			"Focus scan on specific area (e.g., 'frontend zustand', 'auth flow')",
		)
		.option(
			"--validate",
			`Run ${theme.phase.validate("Issue Validators")} to validate issues with probes`,
		)
		.option("--plan", `Run ${theme.phase.plan("Planners")} to generate WBS for validated issues`)
		.option(
			"--consolidate",
			`${theme.phase.consolidate("Merge")} WBS into unified Execution Plan with dependencies`,
		)
		.option("--exec", `${theme.phase.exec("Execute")} tasks from the Execution Plan`)
		.option("--task-id <id>", "Execute a specific task by ID")
		.option("--issues <ids>", "Comma-separated list of issue IDs to process (e.g., P-xxx,P-yyy)")
		.option("--exclude-issues <ids>", "Comma-separated list of issue IDs to exclude")
		.option("--severity <levels>", "Filter by severity: CRITICAL,HIGH,MEDIUM,LOW (comma-separated)")
		.option(
			"--min-severity <level>",
			"Minimum severity level to process (CRITICAL > HIGH > MEDIUM > LOW)",
		)
		.option("--verify", `Run ${theme.phase.verify("verification")} gates and check for regressions`)
		.option("--export", "Export Milhouse state to md/json formats")
		.option("--format <formats>", "Export formats: md,json (default: md,json)", "md,json")
		.option(
			"--run",
			`Run ${theme.highlight("full Milhouse pipeline")} (scan → validate → plan → consolidate → exec → verify)`,
		)
		.option("--run-id <id>", "Specify run ID to use (full or partial match)")
		.option("--resume", "Resume Milhouse pipeline from where it left off")
		.option("--force", "Force re-run even if phases already completed")
		.option("--fail-fast", "Stop pipeline on first phase failure (default: true)")
		.option(
			"--start-phase <phase>",
			"Start from a specific phase (scan, validate, plan, consolidate, exec, verify)",
		)
		.option(
			"--end-phase <phase>",
			"Stop after a specific phase (scan, validate, plan, consolidate, exec, verify)",
		)
		.option("--no-tests, --skip-tests", "Skip running tests")
		.option("--no-lint, --skip-lint", "Skip running lint")
		.option("--fast", "Skip both tests and lint")
		.option("--aider", `Use ${theme.engine.aider("Aider")}`)
		.option("--claude", `Use ${theme.engine.claude("Claude Code")} (default)`)
		.option("--gemini", `Use ${theme.engine.gemini("Gemini CLI")}`)
		.option("--opencode", `Use ${theme.engine.opencode("OpenCode")}`)
		.option("--cursor", `Use ${theme.engine.cursor("Cursor Agent")}`)
		.option("--codex", `Use ${theme.engine.codex("Codex")}`)
		.option("--qwen", `Use ${theme.engine.qwen("Qwen-Code")}`)
		.option("--droid", `Use ${theme.engine.droid("Factory Droid")}`)
		.option("--dry-run", "Show what Milhouse would do without executing")
		.option("--max-iterations <n>", "Maximum iterations (0 = unlimited)", "0")
		.option("--max-retries <n>", "Maximum retries per task", "3")
		.option("--retry-delay <n>", "Delay between retries in seconds", "5")
		// Milhouse-first flags
		.option("--workers [n]", "Enable parallel execution with optional worker count (default: 3)")
		.option("--input <path>", "Task input file or folder (auto-detected)", "PRD.md")
		.option("--tasks <path>", "Task input file or folder (alias for --input)")
		.option("--pr", "Create pull request after each task")
		.option("--draft", "Create PRs as draft (use with --pr)")
		.option("--isolate", "Create isolated branch/worktree for each task")
		.option("--worktree-per-task", "Create isolated worktree for each task (alias for --isolate)")
		.option("--base-branch <branch>", "Base branch for PRs")
		.option("--yaml <file>", "YAML task file")
		.option("--github <repo>", "GitHub repo for issues (owner/repo)")
		.option("--github-label <label>", "Filter GitHub issues by label")
		.option("--no-commit", "Don't auto-commit changes")
		.option("--browser", "Enable browser automation (agent-browser)")
		.option("--no-browser", "Disable browser automation")
		.option("--model <name>", "Override default model for the engine")
		.option("--sonnet", `Shortcut for --claude --model ${theme.code("sonnet")}`)
		.option("--no-merge", "Skip automatic branch merging after parallel execution")
		.option("--exec-fail-fast", "Stop execution on first task failure")
		.option(
			"--worktrees",
			"Force worktree isolation for parallel execution (default when --workers)",
		)
		.option("--exec-by-issue", "Execute tasks grouped by issue (default)")
		.option("--no-exec-by-issue", "Use sequential/task-parallel mode instead of issue-based")
		.option("--skip-probes", "Skip automatic probe execution (use AI-only validation/planning)")
		// Validation retry options
		.option(
			"--max-validation-retries <n>",
			"Maximum retry attempts for UNVALIDATED issues during validation",
			"2",
		)
		.option("--no-retry-unvalidated", "Disable automatic retry for UNVALIDATED issues")
		.option(
			"--retry-delay-validation <ms>",
			"Delay between validation retry rounds in milliseconds",
			"2000",
		)
		.option(
			"--unsafe-dod-checks",
			"Disable safety validation for DoD check_command execution (executes commands as-is). SECURITY RISK.",
		)
		.option(
			"--retry-on-any-failure",
			"Retry any failure, not just retryable errors (safety net mode). When enabled, all failures are retried up to maxRetries.",
		)
		.option("-v, --verbose", "Verbose Milhouse output");

	return program;
}

/**
 * Parse comma-separated issue IDs
 *
 * @param str - Comma-separated string of issue IDs
 * @returns Array of issue IDs or undefined if input is empty
 *
 * @example
 * ```typescript
 * parseIssueIds("P-001,P-002,P-003") // ["P-001", "P-002", "P-003"]
 * parseIssueIds(undefined) // undefined
 * ```
 */
function parseIssueIds(str: string | undefined): string[] | undefined {
	if (!str) return undefined;
	return str
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

/**
 * Parse comma-separated severity levels
 *
 * @param str - Comma-separated string of severity levels
 * @returns Array of valid severity levels or undefined
 *
 * @example
 * ```typescript
 * parseSeverityLevels("CRITICAL,HIGH") // ["CRITICAL", "HIGH"]
 * parseSeverityLevels("invalid") // undefined
 * ```
 */
function parseSeverityLevels(str: string | undefined): Severity[] | undefined {
	if (!str) return undefined;
	const valid: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
	const levels = str
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter((s): s is Severity => valid.includes(s as Severity));
	return levels.length > 0 ? levels : undefined;
}

/**
 * Parse single severity level
 *
 * @param str - Single severity level string
 * @returns Valid severity level or undefined
 *
 * @example
 * ```typescript
 * parseSingleSeverity("HIGH") // "HIGH"
 * parseSingleSeverity("invalid") // undefined
 * ```
 */
function parseSingleSeverity(str: string | undefined): Severity | undefined {
	if (!str) return undefined;
	const valid: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
	const normalized = str.trim().toUpperCase() as Severity;
	return valid.includes(normalized) ? normalized : undefined;
}

/**
 * Parsed CLI arguments result
 */
export interface ParsedArgs {
	/** Runtime options for Milhouse execution */
	options: RuntimeOptions;
	/** Single task to execute (brownfield mode) */
	task: string | undefined;
	/** Initialize Milhouse configuration */
	initMode: boolean;
	/** Show current configuration */
	showConfig: boolean;
	/** Rule to add to config */
	addRule: string | undefined;
	/** Run scan phase */
	scanMode: boolean;
	/** Run validate phase */
	validateMode: boolean;
	/** Run plan phase */
	planMode: boolean;
	/** Run consolidate phase */
	consolidateMode: boolean;
	/** Run exec phase */
	execMode: boolean;
	/** Run verify phase */
	verifyMode: boolean;
	/** Export state */
	exportMode: boolean;
	/** Export format string */
	exportFormat: string;
	/** Run full pipeline */
	runMode: boolean;
	/** Resume from last checkpoint */
	resumeMode: boolean;
	/** Force re-run */
	forceMode: boolean;
	/** Stop on first failure */
	failFast: boolean;
	/** Starting phase for partial pipeline */
	startPhase: MilhousePhase | undefined;
	/** Ending phase for partial pipeline */
	endPhase: MilhousePhase | undefined;
	/** Runs management mode */
	runsMode: boolean;
	/** Runs subcommand (list, info, switch, delete) */
	runsSubcommand: string | undefined;
	/** Additional args for runs subcommand */
	runsArgs: string[];
}

/**
 * Parse command line arguments into RuntimeOptions
 *
 * @param args - Command line arguments (typically process.argv)
 * @returns Parsed arguments with options and mode flags
 *
 * @description
 * Parses command line arguments and returns a structured object containing:
 * - RuntimeOptions for Milhouse execution
 * - Mode flags indicating which command to run
 * - Additional parameters for specific commands
 *
 * @example
 * ```typescript
 * const parsed = parseArgs(process.argv);
 *
 * if (parsed.initMode) {
 *   await runInit();
 * } else if (parsed.runMode) {
 *   await runPipeline(parsed.options);
 * }
 * ```
 */
export function parseArgs(args: string[]): ParsedArgs {
	const program = createProgram();
	program.parse(args);

	const opts = program.opts();
	const programArgs = program.args;
	const [task] = programArgs;

	// Check for "runs" subcommand: milhouse runs list|info|switch|delete
	const runsMode = task === "runs";
	const runsSubcommand = runsMode ? programArgs[1] : undefined;
	const runsArgs = runsMode ? programArgs.slice(2) : [];

	// Determine AI engine (--sonnet implies --claude)
	let aiEngine = "claude";
	if (opts.sonnet) aiEngine = "claude";
	else if (opts.aider) aiEngine = "aider";
	else if (opts.gemini) aiEngine = "gemini";
	else if (opts.opencode) aiEngine = "opencode";
	else if (opts.cursor) aiEngine = "cursor";
	else if (opts.codex) aiEngine = "codex";
	else if (opts.qwen) aiEngine = "qwen";
	else if (opts.droid) aiEngine = "droid";

	// Determine model override (--sonnet is shortcut for --model sonnet)
	const modelOverride = opts.sonnet ? "sonnet" : opts.model || undefined;

	// Handle --input/--tasks flags
	// Note: --input has a default value of "PRD.md", so we need to check if --tasks was explicitly provided
	// If --tasks is provided and --input is at its default, use --tasks
	const inputFile = opts.tasks && opts.input === "PRD.md" ? opts.tasks : opts.input || "PRD.md";

	// Determine PRD source with auto-detection for file vs folder
	let prdSource: "markdown" | "markdown-folder" | "yaml" | "github" = "markdown";
	let prdFile = inputFile;
	let prdIsFolder = false;

	if (opts.yaml) {
		prdSource = "yaml";
		prdFile = opts.yaml;
	} else if (opts.github) {
		prdSource = "github";
	} else {
		// Auto-detect if PRD path is a file or folder
		if (existsSync(prdFile)) {
			const stat = statSync(prdFile);
			if (stat.isDirectory()) {
				prdSource = "markdown-folder";
				prdIsFolder = true;
			}
		}
	}

	// Handle --fast
	const skipTests = opts.fast || opts.skipTests;
	const skipLint = opts.fast || opts.skipLint;

	// Handle --workers flag
	// --workers can be boolean (true) or have a value (number of workers)
	const hasWorkersFlag = opts.workers !== undefined;
	const workersValue =
		typeof opts.workers === "string" ? Number.parseInt(opts.workers, 10) : undefined;
	const useParallel = hasWorkersFlag;
	const workerCount = workersValue || 3;

	// Handle --pr/--draft flags
	const createPr = opts.pr || false;
	const draftPr = opts.draft || false;

	// Handle --isolate/--worktree-per-task flags
	const isolateTask = opts.isolate || opts.worktreePerTask || false;

	const options: RuntimeOptions = {
		skipTests,
		skipLint,
		aiEngine,
		dryRun: opts.dryRun || false,
		maxIterations: Number.parseInt(opts.maxIterations, 10) || 0,
		maxRetries: Number.parseInt(opts.maxRetries, 10) || 3,
		retryDelay: (Number.parseInt(opts.retryDelay, 10) || 5) * 1000, // Convert seconds to ms
		verbose: opts.verbose || false,
		branchPerTask: isolateTask,
		baseBranch: opts.baseBranch || "",
		createPr,
		draftPr,
		parallel: useParallel,
		maxParallel: workerCount,
		prdSource,
		prdFile,
		prdIsFolder,
		githubRepo: opts.github || "",
		githubLabel: opts.githubLabel || "",
		autoCommit: opts.commit !== false,
		browserEnabled: opts.browser === true ? "true" : opts.browser === false ? "false" : "auto",
		modelOverride,
		skipMerge: opts.merge === false,
		failFast: opts.execFailFast || false,
		useWorktrees: opts.worktrees || useParallel || false,
		// execByIssue defaults to true (issue-based parallel execution is the default)
		// --no-exec-by-issue explicitly sets it to false
		execByIssue: opts.execByIssue !== false,
		taskId: opts.taskId,
		scanFocus: opts.scope,
		issueIds: parseIssueIds(opts.issues),
		excludeIssueIds: parseIssueIds(opts.excludeIssues),
		minSeverity: parseSingleSeverity(opts.minSeverity),
		severityFilter: parseSeverityLevels(opts.severity),
		skipProbes: opts.skipProbes || false,
		runId: opts.runId,
		// Validation retry options
		maxValidationRetries:
			opts.maxValidationRetries !== undefined ? Number.parseInt(opts.maxValidationRetries, 10) : 2,
		retryUnvalidated: opts.retryUnvalidated !== false, // Default true, --no-retry-unvalidated sets to false
		retryDelayValidation: Number.parseInt(opts.retryDelayValidation, 10) || 2000,
		unsafeDoDChecks: opts.unsafeDodChecks || false,
		retryOnAnyFailure: opts.retryOnAnyFailure || false,
	};

	return {
		options,
		task: runsMode ? undefined : task,
		initMode: opts.init || false,
		showConfig: opts.config || false,
		addRule: opts.addRule,
		scanMode: opts.scan || false,
		validateMode: opts.validate || false,
		planMode: opts.plan || false,
		consolidateMode: opts.consolidate || false,
		execMode: opts.exec || false,
		verifyMode: opts.verify || false,
		exportMode: opts.export || false,
		exportFormat: opts.format || "md,json",
		runMode: opts.run || false,
		resumeMode: opts.resume || false,
		forceMode: opts.force || false,
		failFast: opts.failFast !== false,
		startPhase: opts.startPhase as MilhousePhase | undefined,
		endPhase: opts.endPhase as MilhousePhase | undefined,
		runsMode,
		runsSubcommand,
		runsArgs,
	};
}

/**
 * Print Milhouse version with branding
 *
 * @description
 * Displays the Milhouse version in a styled format using the theme colors.
 *
 * @example
 * ```typescript
 * printVersion(); // Outputs: milhouse v4.3.0
 * ```
 */
export function printVersion(): void {
	console.log(`${theme.primary(MILHOUSE_BRANDING.shortName)} ${theme.secondary(`v${VERSION}`)}`);
}

/**
 * Print Milhouse help with banner and examples
 *
 * @description
 * Displays the full Milhouse help including:
 * - ASCII art banner
 * - All available options
 * - Usage examples
 * - Pipeline phase diagram
 * - Run management commands
 * - Issue filtering examples
 *
 * @example
 * ```typescript
 * printHelp(); // Outputs full help text
 * ```
 */
export function printHelp(): void {
	console.log(banner);
	const program = createProgram();
	program.outputHelp();

	// Add footer with Milhouse-specific examples
	console.log(`
${theme.bold("Examples:")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --init                    ${theme.muted("# Initialize Milhouse configuration")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --scan --scope "frontend" ${theme.muted("# Scan with focus, creates new run")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --run                     ${theme.muted("# Run full Milhouse pipeline")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --workers          ${theme.muted("# Execute tasks in parallel")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --workers 5        ${theme.muted("# Execute with 5 parallel workers")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} "Fix the login bug"       ${theme.muted("# Single task mode")}

${theme.bold("Milhouse Pipeline Phases:")}
	 ${theme.phase.scan("scan")}        → ${theme.phase.validate("validate")}    → ${theme.phase.plan("plan")}        → ${theme.phase.consolidate("consolidate")} → ${theme.phase.exec("exec")}        → ${theme.phase.verify("verify")}

${theme.bold("Run Management:")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} runs list                 ${theme.muted("# List all Milhouse runs")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} runs info [id]            ${theme.muted("# Show run details")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} runs switch <id>          ${theme.muted("# Switch to a different run")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} runs delete <id>          ${theme.muted("# Delete a run")}

${theme.bold("Issue Filtering:")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --validate --issues P-xxx,P-yyy    ${theme.muted("# Validate specific issues")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --plan --min-severity HIGH         ${theme.muted("# Plan only HIGH+ severity")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --run --severity CRITICAL,HIGH     ${theme.muted("# Full pipeline for CRITICAL/HIGH")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --exclude-issues P-xxx      ${theme.muted("# Execute all except specified")}

${theme.bold("Task Sources:")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --run --input tasks.md    ${theme.muted("# Use custom task file")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --run --tasks ./specs/    ${theme.muted("# Use folder of task specs")}

${theme.bold("Pull Requests:")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --pr               ${theme.muted("# Create PR after each task")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --pr --draft       ${theme.muted("# Create draft PRs")}
	 ${theme.dim("$")} ${MILHOUSE_BRANDING.shortName} --exec --isolate          ${theme.muted("# Isolate each task in worktree")}

${theme.muted(`For more information, visit: ${MILHOUSE_BRANDING.repoUrl}`)}
`);
}
