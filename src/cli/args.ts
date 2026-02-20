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
import type { Severity } from "../state/types.ts";
import { banner, theme } from "../ui/theme";
import type { RuntimeOptions } from "./runtime-options.ts";
import { MILHOUSE_BRANDING, MILHOUSE_PHASES, type MilhousePhase } from "./types.ts";

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
		.description("Correctness-first AI coding orchestrator")
		.version(VERSION)
		.argument("[task...]", "Single task to execute, or 'runs' subcommand")
		.allowExcessArguments(true)

		// ── Setup ──────────────────────────────────────────────
		.option("--init", "Initialize .milhouse/ with config and directory structure")
		.option("--config", "Show current configuration")
		.option("--add-rule <rule>", "Add a rule to .milhouse/config.ts")

		// ── Pipeline ───────────────────────────────────────────
		.option("--run", "Run full pipeline (phases configured in .milhouse/config.ts)")
		.option("--resume", "Resume pipeline from where it left off")
		.option("--run-id <id>", "Use a specific run ID (full or partial match)")
		.option("--start-phase <phase>", "Start from this phase (scan|validate|plan|consolidate|exec|verify)")
		.option("--end-phase <phase>", "Stop after this phase")
		.option("--force", "Re-run even if phases already completed")
		.option("--fail-fast", "Stop on first phase failure (default: true)")

		// ── Individual Phases ──────────────────────────────────
		.option("--scan", "Run scan phase (Lead Investigator)")
		.option("--scope <focus>", "Focus area for scan (e.g. 'auth bugs', 'add search feature')")
		.option("--type <type>", "Work item type hint: bug|feature|refactor|improvement|task")
		.option("--validate", "Run validation phase")
		.option("--plan", "Run planning phase (WBS generation)")
		.option("--consolidate", "Run consolidation phase (merge & deduplicate)")
		.option("--exec", "Run execution phase")
		.option("--verify", "Run verification gates")
		.option("--report", "Generate run report")
		.option("--export", "Export state to md/json")
		.option("--format <formats>", "Export formats: md,json", "md,json")

		// ── AI Engine ──────────────────────────────────────────
		.option("--claude", "Use Claude Code (default)")
		.option("--aider", "Use Aider")
		.option("--gemini", "Use Gemini CLI")
		.option("--opencode", "Use OpenCode")
		.option("--cursor", "Use Cursor Agent")
		.option("--codex", "Use Codex")
		.option("--qwen", "Use Qwen-Code")
		.option("--droid", "Use Factory Droid")
		.option("--model <name>", "Override model (e.g. opus, sonnet, gemini-2.0-flash)")
		.option("--sonnet", "Shortcut for --claude --model sonnet")

		// ── Execution ──────────────────────────────────────────
		.option("--workers [n]", "Parallel workers (default: 3)")
		.option("--isolate", "Isolate each issue in a branch/worktree")
		.option("--no-commit", "Don't auto-commit changes")
		.option("--no-merge", "Skip auto-merge after execution")
		.option("--pr", "Create pull request after execution")
		.option("--draft", "Create PRs as draft")
		.option("--base-branch <branch>", "Base branch for PRs and worktrees")
		.option("--exec-fail-fast", "Stop on first task failure")

		// ── Filtering ──────────────────────────────────────────
		.option("--issues <ids>", "Process only these issue IDs (comma-separated)")
		.option("--exclude-issues <ids>", "Skip these issue IDs (comma-separated)")
		.option("--severity <levels>", "Filter by severity: CRITICAL,HIGH,MEDIUM,LOW")
		.option("--min-severity <level>", "Minimum severity to process")
		.option("--task-id <id>", "Execute a specific task by ID")

		// ── Skips ──────────────────────────────────────────────
		.option("--no-tests, --skip-tests", "Skip tests")
		.option("--no-lint, --skip-lint", "Skip linting")
		.option("--fast", "Skip both tests and lint")
		.option("--skip-probes", "Skip probe execution")
		.option("--dry-run", "Show what would happen without executing")

		// ── Retries ────────────────────────────────────────────
		.option("--max-retries <n>", "Max retries per task", "3")
		.option("--retry-delay <n>", "Retry delay in seconds", "5")
		.option("--max-validation-retries <n>", "Max retries for unvalidated issues", "2")
		.option("--no-retry-unvalidated", "Don't retry unvalidated issues")
		.option("--retry-on-any-failure", "Retry all failures, not just retryable ones")

		// ── Task Sources (legacy PRD mode) ─────────────────────
		.option("--input <path>", "Task file or folder", "PRD.md")
		.option("--tasks <path>", "Alias for --input")
		.option("--yaml <file>", "YAML task file")
		.option("--github <repo>", "GitHub repo (owner/repo)")
		.option("--github-label <label>", "Filter GitHub issues by label")
		.option("--max-iterations <n>", "Max iterations, 0 = unlimited", "0")

		// ── Tmux (OpenCode only) ───────────────────────────────
		.option("--tmux", "Run agents in tmux windows (--opencode only)")
		.option("--tmux-auto-attach", "Auto-attach to tmux session")

		// ── Advanced ───────────────────────────────────────────
		.option("--worktree-per-task", "Alias for --isolate")
		.option("--worktrees", "Force worktree isolation")
		.option("--exec-by-issue", "Group tasks by issue (default)")
		.option("--no-exec-by-issue", "Sequential/task-parallel mode")
		.option("--browser", "Enable browser automation")
		.option("--no-browser", "Disable browser automation")
		.option("--auto-install", "Auto-install missing deps (OpenCode, tmux)")
		.option("--no-auto-install", "Don't auto-install")
		.option("--retry-delay-validation <ms>", "Validation retry delay in ms", "2000")
		.option("--unsafe-dod-checks", "Skip DoD command safety checks (SECURITY RISK)")
		.option("-v, --verbose", "Verbose output");

	program.addHelpText("after", `
Examples:
  $ milhouse --init                          # Create .milhouse/config.ts
  $ milhouse --scan --scope "auth bugs"      # Scan repo for issues
  $ milhouse --run                           # Run full pipeline
  $ milhouse --resume                        # Resume from last checkpoint
  $ milhouse --exec --workers 5              # Execute with 5 parallel agents
  $ milhouse "Fix the login bug"             # Single task mode
  $ milhouse runs list                       # List all runs

Pipeline:  scan → validate → plan → consolidate → exec → verify

Config:    Edit .milhouse/config.ts to configure phases, workers, rules,
           gates, cost budgets, and more. CLI flags override config per run.
`);

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
 * Validate and parse a pipeline phase name
 */
function validatePhase(value: string | undefined): MilhousePhase | undefined {
	if (!value) return undefined;
	const phases: readonly string[] = MILHOUSE_PHASES;
	if (phases.includes(value)) return value as MilhousePhase;
	console.error(`Error: invalid phase "${value}". Valid phases: ${MILHOUSE_PHASES.join(", ")}`);
	process.exit(1);
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
		failFast: opts.execFailFast || opts.failFast !== false,
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
		// Tmux mode options (OpenCode only)
		tmux: opts.tmux || false,
		tmuxAutoAttach: opts.tmuxAutoAttach || false,
		autoInstall: opts.autoInstall !== false, // Default true, --no-auto-install sets to false
	};

	// Validate tmux mode options
	if (options.tmux && aiEngine !== "opencode") {
		console.error(
			"Error: --tmux flag is only supported with --opencode engine.\n" +
				"Other engines (claude, gemini, etc.) do not have a Server API with TUI attachment capability.",
		);
		process.exit(1);
	}

	if (options.tmuxAutoAttach && !options.tmux) {
		console.error("Error: --tmux-auto-attach requires --tmux flag.");
		process.exit(1);
	}

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
		startPhase: validatePhase(opts.startPhase),
		endPhase: validatePhase(opts.endPhase),
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

	const $ = theme.dim("$");
	const m = MILHOUSE_BRANDING.shortName;
	const c = (s: string) => theme.muted(s);

	console.log(`
${theme.bold("Quick Start:")}
  ${$} ${m} --init                          ${c("# Create .milhouse/config.ts")}
  ${$} ${m} --scan --scope "auth bugs"      ${c("# Scan repo for issues")}
  ${$} ${m} --run                           ${c("# Run full pipeline")}
  ${$} ${m} "Fix the login bug"             ${c("# Single task mode")}

${theme.bold("Pipeline:")}
  ${theme.phase.scan("scan")} → ${theme.phase.validate("validate")} → ${theme.phase.plan("plan")} → ${theme.phase.consolidate("consolidate")} → ${theme.phase.exec("exec")} → ${theme.phase.verify("verify")}

  ${$} ${m} --run --start-phase plan        ${c("# Start from plan phase")}
  ${$} ${m} --run --end-phase consolidate   ${c("# Stop after consolidation")}
  ${$} ${m} --resume                        ${c("# Resume from last checkpoint")}
  ${$} ${m} --exec --workers 5              ${c("# Execute with 5 parallel agents")}

${theme.bold("Runs:")}
  ${$} ${m} runs list                       ${c("# List all runs")}
  ${$} ${m} runs info [id]                  ${c("# Show run details")}
  ${$} ${m} runs switch <id>                ${c("# Switch active run")}
  ${$} ${m} runs delete <id>                ${c("# Delete a run")}

${theme.bold("Filtering:")}
  ${$} ${m} --validate --issues P-xxx,P-yyy ${c("# Validate specific issues")}
  ${$} ${m} --run --min-severity HIGH       ${c("# Only HIGH+ severity")}
  ${$} ${m} --exec --exclude-issues P-xxx   ${c("# Skip specific issues")}

${theme.bold("Config:")}
  Edit ${theme.highlight(".milhouse/config.ts")} to configure phases, workers, rules, gates, and more.
  CLI flags override config values for that run only.

${theme.muted(`${MILHOUSE_BRANDING.repoUrl}`)}
`);
}
