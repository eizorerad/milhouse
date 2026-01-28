import * as fs from "node:fs";
import * as path from "node:path";
import { BaseProbe, type CommandResult, executeCommandWithTimeout } from "./base.ts";
import {
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	type ReproProbeOutput,
	type ReproStep,
	createProbeFinding,
} from "./types.ts";

/**
 * Log file patterns to search for
 */
const LOG_FILE_PATTERNS = [
	"*.log",
	"logs/*.log",
	"log/*.log",
	".log/*.log",
	"tmp/*.log",
	"*.error",
	"*.err",
	"debug.log",
	"error.log",
	"app.log",
	"server.log",
	"npm-debug.log",
	"yarn-error.log",
	"pnpm-debug.log",
	"crash.log",
	"crash-*.log",
];

/**
 * Error patterns to detect in logs
 */
const ERROR_PATTERNS: Array<{
	pattern: RegExp;
	category: string;
	severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}> = [
	// JavaScript/Node.js errors
	{ pattern: /TypeError:/i, category: "type_error", severity: "HIGH" },
	{ pattern: /ReferenceError:/i, category: "reference_error", severity: "HIGH" },
	{ pattern: /SyntaxError:/i, category: "syntax_error", severity: "CRITICAL" },
	{ pattern: /RangeError:/i, category: "range_error", severity: "MEDIUM" },
	{ pattern: /Error:\s+ENOENT/i, category: "file_not_found", severity: "HIGH" },
	{ pattern: /Error:\s+EACCES/i, category: "permission_denied", severity: "HIGH" },
	{ pattern: /Error:\s+ECONNREFUSED/i, category: "connection_refused", severity: "HIGH" },
	{ pattern: /Error:\s+ETIMEDOUT/i, category: "timeout", severity: "MEDIUM" },
	{ pattern: /UnhandledPromiseRejection/i, category: "unhandled_promise", severity: "CRITICAL" },
	{ pattern: /FATAL\s+ERROR/i, category: "fatal", severity: "CRITICAL" },

	// Python errors
	{
		pattern: /Traceback \(most recent call last\)/i,
		category: "python_traceback",
		severity: "HIGH",
	},
	{ pattern: /ImportError:/i, category: "import_error", severity: "HIGH" },
	{ pattern: /ModuleNotFoundError:/i, category: "module_not_found", severity: "HIGH" },
	{ pattern: /AttributeError:/i, category: "attribute_error", severity: "HIGH" },
	{ pattern: /KeyError:/i, category: "key_error", severity: "MEDIUM" },
	{ pattern: /ValueError:/i, category: "value_error", severity: "MEDIUM" },

	// Database errors
	{ pattern: /SQLSTATE\[/i, category: "sql_error", severity: "HIGH" },
	{ pattern: /ER_ACCESS_DENIED/i, category: "db_access_denied", severity: "CRITICAL" },
	{ pattern: /ER_NO_SUCH_TABLE/i, category: "table_not_found", severity: "HIGH" },
	{ pattern: /duplicate key/i, category: "duplicate_key", severity: "MEDIUM" },
	{ pattern: /deadlock/i, category: "deadlock", severity: "CRITICAL" },
	{ pattern: /connection refused.*postgres/i, category: "postgres_connection", severity: "HIGH" },
	{ pattern: /connection refused.*redis/i, category: "redis_connection", severity: "HIGH" },
	{ pattern: /connection refused.*mongo/i, category: "mongo_connection", severity: "HIGH" },

	// Docker/Container errors
	{ pattern: /OOMKilled/i, category: "oom_killed", severity: "CRITICAL" },
	{ pattern: /container.*exited with code [1-9]/i, category: "container_exit", severity: "HIGH" },
	{ pattern: /no space left on device/i, category: "disk_full", severity: "CRITICAL" },

	// Generic severity patterns
	{ pattern: /\[CRITICAL\]/i, category: "critical_log", severity: "CRITICAL" },
	{ pattern: /\[FATAL\]/i, category: "fatal_log", severity: "CRITICAL" },
	{ pattern: /\[ERROR\]/i, category: "error_log", severity: "HIGH" },
	{ pattern: /\[WARN(ING)?\]/i, category: "warning_log", severity: "MEDIUM" },
	{ pattern: /panic:/i, category: "panic", severity: "CRITICAL" },
	{ pattern: /segmentation fault/i, category: "segfault", severity: "CRITICAL" },
	{ pattern: /out of memory/i, category: "oom", severity: "CRITICAL" },
	{ pattern: /stack overflow/i, category: "stack_overflow", severity: "CRITICAL" },
];

/**
 * Repro step file patterns
 */
const REPRO_FILE_PATTERNS = [
	"REPRO.md",
	"repro.md",
	"REPRODUCE.md",
	"reproduce.md",
	"reproduction-steps.md",
	"steps-to-reproduce.md",
	".github/ISSUE_TEMPLATE/*.md",
	"BUG_REPORT.md",
	"bug_report.md",
];

/**
 * Test command patterns
 */
const TEST_COMMANDS: Record<string, string[]> = {
	npm: ["npm test", "npm run test"],
	yarn: ["yarn test"],
	pnpm: ["pnpm test"],
	cargo: ["cargo test"],
	go: ["go test ./..."],
	python: ["pytest", "python -m pytest", "python -m unittest"],
	make: ["make test"],
};

/**
 * Reproduction Runner (RR)
 *
 * Analyzes logs and executes reproduction steps:
 * - Scans log files for errors and warnings
 * - Parses reproduction step files
 * - Executes reproduction commands with timeout
 * - Captures stdout/stderr and exit codes
 * - Categorizes errors by type and severity
 *
 * Capabilities:
 * - Read and analyze log files
 * - Execute shell commands (with safety checks)
 * - Parse markdown reproduction files
 * - Capture command output and timing
 *
 * Output:
 * - Whether issue was reproduced
 * - Execution steps with output
 * - Detected errors from logs
 * - Artifacts (log file paths)
 */
export class ReproProbe extends BaseProbe<ReproProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		// ReproProbe is NOT read-only by default as it may execute commands
		// Force read_only to false regardless of what user passes
		super("repro", { ...configOverrides, read_only: false });
	}

	/**
	 * Get commands to execute for reproduction
	 */
	protected getCommands(_input: ProbeInput): Array<{ command: string; args: string[] }> {
		// Commands are determined dynamically based on repro steps
		return [];
	}

	/**
	 * Get unsafe patterns for repro probe
	 * Override to allow more commands since repro needs to execute tests
	 */
	getUnsafePatterns(): RegExp[] {
		// Repro probe has fewer restrictions but still blocks dangerous operations
		return [
			// Block destructive file operations
			/\brm\s+-rf\s+\//i,
			/\brm\s+-rf\s+~\//i,
			/\brm\s+-rf\s+\.\./i,
			/\brmdir\s+\//i,
			// Block system modifications
			/\bsudo\s/i,
			/\bchmod\s+777\s/i,
			/\bchown\s+-R\s/i,
			// Block network attacks
			/\bcurl\s.*\|\s*bash/i,
			/\bwget\s.*\|\s*bash/i,
			// Block database destructive operations
			/\bDROP\s+DATABASE/i,
			/\bDROP\s+TABLE\s/i,
			/\bTRUNCATE\s+TABLE/i,
			/\bFLUSHALL\b/i,
			/\bFLUSHDB\b/i,
			// Block git force operations
			/\bgit\s+push\s+.*--force/i,
			/\bgit\s+reset\s+--hard\s+origin/i,
		];
	}

	/**
	 * Override execute to handle reproduction logic
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			return this.createReproErrorResult(
				startTime,
				"Invalid probe input: workDir is required and must exist",
			);
		}

		// Check if workDir exists
		if (!fs.existsSync(input.workDir)) {
			return this.createReproErrorResult(
				startTime,
				`Working directory does not exist: ${input.workDir}`,
			);
		}

		try {
			// Scan for log files
			const logFiles = this.findLogFiles(input.workDir);

			// Analyze logs for errors
			const logErrors = this.analyzeLogFiles(input.workDir, logFiles);

			// Find reproduction steps
			const reproSteps = this.findReproductionSteps(input);

			// Execute reproduction steps if provided
			const executedSteps = await this.executeReproSteps(
				input.workDir,
				reproSteps,
				input.timeout_ms,
			);

			// Collect environment info
			const environment = this.collectEnvironment(input.workDir);

			// Determine if issue was reproduced
			const reproduced = this.determineReproduced(executedSteps, logErrors);

			// Build the output
			const output: ReproProbeOutput = {
				reproduced,
				steps: executedSteps,
				environment,
				logs: logFiles,
				artifacts: this.findArtifacts(input.workDir),
				issues: [],
			};

			// Extract findings
			const findings = this.extractFindings(output);

			// Add log error findings
			for (const logError of logErrors.slice(0, 10)) {
				findings.push(
					createProbeFinding(
						`log-error-${logError.category}`,
						`Log error: ${logError.category}`,
						logError.message,
						logError.severity,
						{
							file: logError.file,
							line: logError.line,
							suggestion: this.getSuggestionForError(logError.category),
							metadata: {
								category: logError.category,
								pattern: logError.pattern,
							},
						},
					),
				);
			}

			const duration = Date.now() - startTime;
			return {
				probe_id: this.generateProbeId(),
				probe_type: "repro",
				success: true,
				output: this.formatOutput(output),
				timestamp: new Date().toISOString(),
				read_only: false,
				duration_ms: duration,
				findings,
				raw_output: JSON.stringify(output, null, 2),
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return this.createReproErrorResult(
				startTime,
				`Failed to execute reproduction: ${errorMessage}`,
			);
		}
	}

	/**
	 * Generate a unique probe ID
	 */
	private generateProbeId(): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).slice(2, 8);
		return `repro-${timestamp}-${random}`;
	}

	/**
	 * Create an error result for repro probe
	 */
	private createReproErrorResult(startTime: number, error: string): ProbeResult {
		const duration = Date.now() - startTime;
		return {
			probe_id: this.generateProbeId(),
			probe_type: "repro",
			success: false,
			error,
			timestamp: new Date().toISOString(),
			read_only: false,
			duration_ms: duration,
			findings: [],
		};
	}

	/**
	 * Find log files in the working directory
	 */
	findLogFiles(workDir: string): string[] {
		const logFiles: string[] = [];

		const searchPaths = [
			workDir,
			path.join(workDir, "logs"),
			path.join(workDir, "log"),
			path.join(workDir, "tmp"),
			path.join(workDir, ".log"),
		];

		for (const searchPath of searchPaths) {
			if (!fs.existsSync(searchPath)) {
				continue;
			}

			try {
				const files = fs.readdirSync(searchPath);
				for (const file of files) {
					const filePath = path.join(searchPath, file);
					const stat = fs.statSync(filePath);

					if (!stat.isFile()) {
						continue;
					}

					// Check if it's a log file
					if (this.isLogFile(file)) {
						// Only include files under a reasonable size (10MB)
						if (stat.size <= 10 * 1024 * 1024) {
							logFiles.push(path.relative(workDir, filePath));
						}
					}
				}
			} catch {
				// Ignore errors reading directories
			}
		}

		return logFiles;
	}

	/**
	 * Check if a file is a log file
	 */
	isLogFile(filename: string): boolean {
		const lowerName = filename.toLowerCase();
		return (
			lowerName.endsWith(".log") ||
			lowerName.endsWith(".err") ||
			lowerName.endsWith(".error") ||
			lowerName === "debug.log" ||
			lowerName === "error.log" ||
			lowerName === "npm-debug.log" ||
			lowerName === "yarn-error.log" ||
			lowerName === "pnpm-debug.log" ||
			lowerName.startsWith("crash")
		);
	}

	/**
	 * Analyze log files for errors
	 */
	analyzeLogFiles(
		workDir: string,
		logFiles: string[],
	): Array<{
		file: string;
		line: number;
		message: string;
		category: string;
		pattern: string;
		severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
	}> {
		const errors: Array<{
			file: string;
			line: number;
			message: string;
			category: string;
			pattern: string;
			severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
		}> = [];

		for (const logFile of logFiles) {
			const filePath = path.join(workDir, logFile);
			if (!fs.existsSync(filePath)) {
				continue;
			}

			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split("\n");

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					for (const errorPattern of ERROR_PATTERNS) {
						if (errorPattern.pattern.test(line)) {
							errors.push({
								file: logFile,
								line: i + 1,
								message: line.trim().slice(0, 500), // Limit message length
								category: errorPattern.category,
								pattern: errorPattern.pattern.source,
								severity: errorPattern.severity,
							});
							break; // Only match first pattern per line
						}
					}
				}
			} catch {
				// Ignore errors reading log files
			}
		}

		// Sort by severity (CRITICAL first)
		const severityOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
		errors.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

		return errors;
	}

	/**
	 * Find reproduction steps from input or files
	 */
	findReproductionSteps(input: ProbeInput): string[] {
		// Check if steps provided in options
		if (input.options.reproSteps && Array.isArray(input.options.reproSteps)) {
			return input.options.reproSteps as string[];
		}

		// Look for reproduction files
		for (const pattern of REPRO_FILE_PATTERNS) {
			const filePath = path.join(input.workDir, pattern);
			if (fs.existsSync(filePath)) {
				const content = fs.readFileSync(filePath, "utf-8");
				const steps = this.parseReproStepsFromMarkdown(content);
				if (steps.length > 0) {
					return steps;
				}
			}
		}

		// Default: try to detect test command
		return this.detectTestCommand(input.workDir);
	}

	/**
	 * Parse reproduction steps from markdown
	 */
	parseReproStepsFromMarkdown(content: string): string[] {
		const steps: string[] = [];

		// Look for code blocks after "Steps to Reproduce" or similar headings
		const reproSectionMatch = content.match(
			/(?:steps?\s+to\s+reproduce|reproduction\s+steps?|how\s+to\s+reproduce|repro(?:duction)?)/i,
		);

		if (!reproSectionMatch) {
			// Try to find any numbered steps
			const numberedSteps = content.matchAll(/^\d+\.\s+`([^`]+)`/gm);
			for (const match of numberedSteps) {
				if (this.isExecutableCommand(match[1])) {
					steps.push(match[1]);
				}
			}
			return steps;
		}

		// Find code blocks after the repro section
		const afterRepro = content.slice(reproSectionMatch.index);
		const codeBlocks = afterRepro.matchAll(/```(?:bash|sh|shell)?\n([^`]+)```/gm);

		for (const match of codeBlocks) {
			const commands = match[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"));
			steps.push(...commands);
		}

		// Also look for inline code commands
		const inlineCommands = afterRepro.matchAll(/^\d+\.\s+`([^`]+)`/gm);
		for (const match of inlineCommands) {
			if (this.isExecutableCommand(match[1])) {
				steps.push(match[1]);
			}
		}

		return steps;
	}

	/**
	 * Check if a string looks like an executable command
	 */
	isExecutableCommand(command: string): boolean {
		const firstWord = command.trim().split(/\s+/)[0];
		const executablePrefixes = [
			"npm",
			"yarn",
			"pnpm",
			"node",
			"npx",
			"python",
			"python3",
			"pip",
			"pytest",
			"cargo",
			"go",
			"make",
			"docker",
			"docker-compose",
			"curl",
			"wget",
			"git",
			"cat",
			"echo",
			"ls",
			"cd",
			"mkdir",
			"./",
		];
		return executablePrefixes.some(
			(prefix) =>
				firstWord === prefix || firstWord.startsWith("./") || firstWord.startsWith("node "),
		);
	}

	/**
	 * Detect test command based on project files
	 */
	detectTestCommand(workDir: string): string[] {
		// Check for package.json (Node.js)
		const packageJsonPath = path.join(workDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
				if (
					packageJson.scripts?.test &&
					packageJson.scripts.test !== 'echo "Error: no test specified" && exit 1'
				) {
					// Detect package manager
					if (fs.existsSync(path.join(workDir, "pnpm-lock.yaml"))) {
						return ["pnpm test"];
					}
					if (fs.existsSync(path.join(workDir, "yarn.lock"))) {
						return ["yarn test"];
					}
					return ["npm test"];
				}
			} catch {
				// Ignore JSON parse errors
			}
		}

		// Check for Cargo.toml (Rust)
		if (fs.existsSync(path.join(workDir, "Cargo.toml"))) {
			return ["cargo test"];
		}

		// Check for go.mod (Go)
		if (fs.existsSync(path.join(workDir, "go.mod"))) {
			return ["go test ./..."];
		}

		// Check for pytest/python
		if (
			fs.existsSync(path.join(workDir, "pytest.ini")) ||
			fs.existsSync(path.join(workDir, "pyproject.toml")) ||
			fs.existsSync(path.join(workDir, "setup.py"))
		) {
			return ["pytest"];
		}

		// Check for Makefile
		if (fs.existsSync(path.join(workDir, "Makefile"))) {
			try {
				const makefile = fs.readFileSync(path.join(workDir, "Makefile"), "utf-8");
				if (makefile.includes("test:")) {
					return ["make test"];
				}
			} catch {
				// Ignore errors
			}
		}

		return [];
	}

	/**
	 * Execute reproduction steps
	 */
	async executeReproSteps(
		workDir: string,
		steps: string[],
		timeoutMs: number,
	): Promise<ReproStep[]> {
		const results: ReproStep[] = [];

		for (let i = 0; i < steps.length; i++) {
			const command = steps[i];

			// Safety check
			const unsafePatterns = this.getUnsafePatterns();
			const blockedPattern = unsafePatterns.find((pattern) => pattern.test(command));
			if (blockedPattern) {
				results.push({
					step: i + 1,
					command,
					success: false,
					stderr: `Command blocked by safety check: ${blockedPattern.source}`,
				});
				continue;
			}

			const stepStart = Date.now();
			try {
				const result = await executeCommandWithTimeout(command, [], workDir, timeoutMs);

				results.push({
					step: i + 1,
					command,
					success: result.success,
					duration_ms: Date.now() - stepStart,
					exit_code: result.exitCode ?? undefined,
					stdout: result.stdout.slice(0, 10000), // Limit output size
					stderr: result.stderr.slice(0, 10000),
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				results.push({
					step: i + 1,
					command,
					success: false,
					duration_ms: Date.now() - stepStart,
					stderr: errorMessage,
				});
			}
		}

		return results;
	}

	/**
	 * Collect environment information
	 */
	collectEnvironment(workDir: string): Record<string, string> {
		const environment: Record<string, string> = {};

		// Node version
		environment.node_version = process.version;

		// Platform info
		environment.platform = process.platform;
		environment.arch = process.arch;

		// Working directory
		environment.working_directory = workDir;

		// Check for common tools
		const packageJsonPath = path.join(workDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
				if (packageJson.name) {
					environment.project_name = packageJson.name;
				}
				if (packageJson.version) {
					environment.project_version = packageJson.version;
				}
			} catch {
				// Ignore errors
			}
		}

		return environment;
	}

	/**
	 * Find artifacts (screenshots, logs, etc.)
	 */
	findArtifacts(workDir: string): string[] {
		const artifacts: string[] = [];
		const artifactPatterns = [
			"screenshots/*.png",
			"screenshots/*.jpg",
			"*.screenshot.png",
			"coverage/**/*.html",
			"test-results/**/*",
			"playwright-report/**/*",
		];

		const artifactDirs = ["screenshots", "coverage", "test-results", "playwright-report"];

		for (const dir of artifactDirs) {
			const dirPath = path.join(workDir, dir);
			if (fs.existsSync(dirPath)) {
				try {
					const files = fs.readdirSync(dirPath);
					for (const file of files.slice(0, 10)) {
						artifacts.push(path.join(dir, file));
					}
				} catch {
					// Ignore errors
				}
			}
		}

		return artifacts;
	}

	/**
	 * Determine if issue was reproduced
	 */
	determineReproduced(steps: ReproStep[], logErrors: Array<{ severity: string }>): boolean {
		// If any step explicitly failed
		if (steps.some((s) => !s.success && s.exit_code !== 0)) {
			return true;
		}

		// If there are CRITICAL or HIGH errors in logs
		const criticalErrors = logErrors.filter(
			(e) => e.severity === "CRITICAL" || e.severity === "HIGH",
		);
		if (criticalErrors.length > 0) {
			return true;
		}

		// If step output contains error patterns
		for (const step of steps) {
			const output = (step.stdout || "") + (step.stderr || "");
			for (const pattern of ERROR_PATTERNS) {
				if (pattern.severity === "CRITICAL" || pattern.severity === "HIGH") {
					if (pattern.pattern.test(output)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Get suggestion for an error category
	 */
	getSuggestionForError(category: string): string {
		const suggestions: Record<string, string> = {
			type_error: "Check type annotations and ensure correct types are passed",
			reference_error: "Verify variable declarations and imports",
			syntax_error: "Fix syntax errors in the source code",
			file_not_found: "Verify file paths and ensure files exist",
			permission_denied: "Check file/directory permissions",
			connection_refused: "Verify the service is running and accessible",
			timeout: "Increase timeout or optimize slow operations",
			unhandled_promise: "Add try/catch blocks or .catch() handlers to promises",
			fatal: "Review the stack trace to identify the root cause",
			python_traceback: "Review the Python traceback for error details",
			import_error: "Verify module is installed and in PYTHONPATH",
			module_not_found: "Install the missing module with pip/poetry",
			sql_error: "Review SQL query syntax and database schema",
			db_access_denied: "Check database credentials and permissions",
			table_not_found: "Run database migrations or create the table",
			duplicate_key: "Handle unique constraint violations",
			deadlock: "Review transaction isolation and locking strategy",
			postgres_connection: "Verify PostgreSQL is running and connection string is correct",
			redis_connection: "Verify Redis is running and connection string is correct",
			mongo_connection: "Verify MongoDB is running and connection string is correct",
			oom_killed: "Increase container memory limits or optimize memory usage",
			container_exit: "Check container logs for error details",
			disk_full: "Free up disk space or increase volume size",
			panic: "Review panic message and stack trace",
			segfault: "Check for memory corruption or invalid pointers",
			oom: "Reduce memory usage or increase available memory",
			stack_overflow: "Fix recursive calls or reduce stack depth",
		};

		return suggestions[category] || "Review the error message for details";
	}

	/**
	 * Extract findings from the probe output
	 */
	extractFindings(output: ReproProbeOutput): ProbeFinding[] {
		const findings: ProbeFinding[] = [...output.issues];

		// Issue was reproduced
		if (output.reproduced) {
			findings.push(
				createProbeFinding(
					"issue-reproduced",
					"Issue was reproduced",
					"The issue was successfully reproduced during probe execution",
					"HIGH",
					{
						suggestion: "Review the reproduction steps and error logs to diagnose the issue",
					},
				),
			);
		}

		// No reproduction steps found
		if (output.steps.length === 0) {
			findings.push(
				createProbeFinding(
					"no-repro-steps",
					"No reproduction steps found",
					"Could not find reproduction steps in project files or options",
					"INFO",
					{
						suggestion:
							"Create a REPRO.md file with steps to reproduce or pass reproSteps in options",
					},
				),
			);
		}

		// Failed steps
		const failedSteps = output.steps.filter((s) => !s.success);
		if (failedSteps.length > 0) {
			findings.push(
				createProbeFinding(
					"failed-steps",
					`${failedSteps.length} reproduction step(s) failed`,
					`Failed commands: ${failedSteps.map((s) => s.command).join(", ")}`,
					"HIGH",
					{
						suggestion: "Review failed step output for error details",
						metadata: {
							failed_steps: failedSteps.map((s) => s.step),
						},
					},
				),
			);
		}

		// No log files found
		if (output.logs.length === 0) {
			findings.push(
				createProbeFinding(
					"no-log-files",
					"No log files found",
					"Could not find any log files to analyze",
					"INFO",
					{
						suggestion: "Enable logging in your application or specify log file locations",
					},
				),
			);
		}

		// Many log files
		if (output.logs.length > 10) {
			findings.push(
				createProbeFinding(
					"many-log-files",
					`Found ${output.logs.length} log files`,
					"Consider implementing log rotation or archiving old logs",
					"LOW",
					{
						suggestion: "Implement log rotation to manage log file growth",
					},
				),
			);
		}

		return findings;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: ReproProbeOutput): string {
		const lines: string[] = [];

		lines.push("# Reproduction Analysis");
		lines.push("");

		// Status
		lines.push("## Status");
		lines.push(`Issue Reproduced: ${output.reproduced ? "YES" : "NO"}`);
		lines.push("");

		// Environment
		lines.push("## Environment");
		for (const [key, value] of Object.entries(output.environment)) {
			lines.push(`- ${key}: ${value}`);
		}
		lines.push("");

		// Reproduction steps
		if (output.steps.length > 0) {
			lines.push("## Reproduction Steps");
			lines.push("| Step | Command | Status | Duration | Exit Code |");
			lines.push("|------|---------|--------|----------|-----------|");
			for (const step of output.steps) {
				const status = step.success ? "PASS" : "FAIL";
				const duration = step.duration_ms ? `${step.duration_ms}ms` : "-";
				const exitCode = step.exit_code !== undefined ? step.exit_code : "-";
				lines.push(
					`| ${step.step} | \`${step.command.slice(0, 40)}${step.command.length > 40 ? "..." : ""}\` | ${status} | ${duration} | ${exitCode} |`,
				);
			}
			lines.push("");

			// Failed step details
			const failedSteps = output.steps.filter((s) => !s.success);
			if (failedSteps.length > 0) {
				lines.push("### Failed Step Details");
				for (const step of failedSteps) {
					lines.push(`#### Step ${step.step}: \`${step.command}\``);
					if (step.stderr) {
						lines.push("```");
						lines.push(step.stderr.slice(0, 1000));
						lines.push("```");
					}
				}
				lines.push("");
			}
		} else {
			lines.push("## Reproduction Steps");
			lines.push("No reproduction steps were executed.");
			lines.push("");
		}

		// Log files
		if (output.logs.length > 0) {
			lines.push("## Log Files");
			for (const log of output.logs.slice(0, 10)) {
				lines.push(`- ${log}`);
			}
			if (output.logs.length > 10) {
				lines.push(`- ... and ${output.logs.length - 10} more`);
			}
			lines.push("");
		}

		// Artifacts
		if (output.artifacts.length > 0) {
			lines.push("## Artifacts");
			for (const artifact of output.artifacts) {
				lines.push(`- ${artifact}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Parse raw output (for BaseProbe compatibility)
	 */
	parseOutput(rawOutput: string): ReproProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as ReproProbeOutput;
		} catch {
			return {
				reproduced: false,
				steps: [],
				environment: {},
				logs: [],
				artifacts: [],
				issues: [],
			};
		}
	}

	/**
	 * Allow continuation when commands fail
	 * Repro probe should continue even if steps fail
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return true;
	}
}

/**
 * Create a Repro probe with optional configuration overrides
 */
export function createReproProbe(configOverrides?: Partial<ProbeConfig>): ReproProbe {
	return new ReproProbe(configOverrides);
}

/**
 * Check if a directory has reproduction configuration
 */
export function hasReproConfig(workDir: string): boolean {
	// Check for repro files
	for (const pattern of REPRO_FILE_PATTERNS) {
		const filePath = path.join(workDir, pattern);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}

	// Check for test configuration
	const testConfigFiles = [
		"package.json",
		"Cargo.toml",
		"go.mod",
		"pytest.ini",
		"pyproject.toml",
		"Makefile",
	];

	for (const file of testConfigFiles) {
		if (fs.existsSync(path.join(workDir, file))) {
			return true;
		}
	}

	return false;
}

/**
 * Find log files in a directory
 */
export function findLogFilesInDirectory(workDir: string): string[] {
	const probe = new ReproProbe();
	return probe.findLogFiles(workDir);
}

/**
 * Analyze log files for errors
 */
export function analyzeLogsForErrors(
	workDir: string,
	logFiles: string[],
): Array<{
	file: string;
	line: number;
	message: string;
	category: string;
	severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}> {
	const probe = new ReproProbe();
	return probe.analyzeLogFiles(workDir, logFiles).map(({ pattern, ...rest }) => rest);
}

/**
 * Parse reproduction steps from markdown content
 */
export function parseReproSteps(markdownContent: string): string[] {
	const probe = new ReproProbe();
	return probe.parseReproStepsFromMarkdown(markdownContent);
}

/**
 * Detect test command for a project
 */
export function detectProjectTestCommand(workDir: string): string[] {
	const probe = new ReproProbe();
	return probe.detectTestCommand(workDir);
}

/**
 * Format repro probe output as markdown
 */
export function formatReproOutputAsMarkdown(output: ReproProbeOutput): string {
	const probe = new ReproProbe();
	return probe.formatOutput(output);
}

/**
 * Check if a command is safe to execute
 */
export function isCommandSafe(command: string): boolean {
	const probe = new ReproProbe();
	const unsafePatterns = probe.getUnsafePatterns();
	return !unsafePatterns.some((pattern) => pattern.test(command));
}
