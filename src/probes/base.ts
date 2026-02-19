import { type ChildProcess, spawn } from "node:child_process";
import {
	type ProbeConfig,
	type ProbeInput,
	type ProbeMetrics,
	type ProbeResult,
	type ProbeType,
	createEmptyProbeMetrics,
	createMetricsFromProbeResult,
	createProbeResult,
	getProbeConfig,
} from "./types.ts";

/**
 * Error thrown when probe execution fails
 */
export class ProbeExecutionError extends Error {
	constructor(
		message: string,
		public readonly probeType: ProbeType,
		public readonly cause?: Error,
	) {
		super(message);
		this.name = "ProbeExecutionError";
	}
}

/**
 * Error thrown when probe times out
 */
export class ProbeTimeoutError extends Error {
	constructor(
		message: string,
		public readonly probeType: ProbeType,
		public readonly timeoutMs: number,
	) {
		super(message);
		this.name = "ProbeTimeoutError";
	}
}

/**
 * Error thrown when probe safety check fails
 */
export class ProbeSafetyError extends Error {
	constructor(
		message: string,
		public readonly probeType: ProbeType,
		public readonly unsafeOperation?: string,
	) {
		super(message);
		this.name = "ProbeSafetyError";
	}
}

/**
 * Probe execution options
 */
export interface ProbeExecutionOptions {
	/** Override the default timeout */
	timeoutMs?: number;
	/** Force read-only mode even for probes that support writes */
	forceReadOnly?: boolean;
	/** Maximum retries on failure */
	maxRetries?: number;
	/** Delay between retries in milliseconds */
	retryDelayMs?: number;
	/** Enable verbose output */
	verbose?: boolean;
}

/**
 * Base probe interface - defines the contract for all probes
 */
export interface IProbe<TOutput = unknown> {
	/** Probe type identifier */
	readonly probeType: ProbeType;
	/** Probe configuration */
	readonly config: ProbeConfig;
	/** Whether the probe is read-only */
	readonly isReadOnly: boolean;
	/** Execute the probe */
	execute(input: ProbeInput, options?: ProbeExecutionOptions): Promise<ProbeResult>;
	/** Validate input before execution */
	validateInput(input: ProbeInput): boolean;
	/** Parse the raw output */
	parseOutput(rawOutput: string): TOutput;
	/** Get unsafe patterns that should be blocked */
	getUnsafePatterns(): RegExp[];
}

/**
 * Lifecycle hooks for probe execution
 */
export interface ProbeHooks {
	/** Called before probe executes */
	beforeExecute?: Array<(input: ProbeInput) => Promise<ProbeInput>>;
	/** Called after probe executes */
	afterExecute?: Array<(input: ProbeInput, result: ProbeResult) => Promise<ProbeResult>>;
	/** Called when an error occurs */
	onError?: Array<(input: ProbeInput, error: Error) => Promise<void>>;
}

/**
 * Result of a command execution
 */
export interface CommandResult {
	/** Standard output */
	stdout: string;
	/** Standard error */
	stderr: string;
	/** Exit code (null if killed by signal) */
	exitCode: number | null;
	/** Signal that killed the process (null if exited normally) */
	signal: NodeJS.Signals | null;
	/** Whether the command was successful (exit code 0) */
	success: boolean;
}

/**
 * Generate a unique probe ID
 */
export function generateProbeId(probeType: ProbeType): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${probeType}-${timestamp}-${random}`;
}

/**
 * Default unsafe patterns for read-only probes
 * These patterns detect commands that could modify state
 */
export const DEFAULT_UNSAFE_PATTERNS: RegExp[] = [
	// File system modifications
	/\brm\s/i,
	/\brmdir\b/i,
	/\bmv\s/i,
	/\bcp\s/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\btruncate\b/i,
	// Database modifications
	/\bDROP\s/i,
	/\bDELETE\s/i,
	/\bUPDATE\s/i,
	/\bINSERT\s/i,
	/\bALTER\s/i,
	/\bCREATE\s/i,
	/\bTRUNCATE\b/i,
	// Redis modifications
	/\bFLUSHDB\b/i,
	/\bFLUSHALL\b/i,
	/\bDEL\s/i,
	/\bSET\s/i,
	/\bEXPIRE\b/i,
	/\bRENAME\b/i,
	// Docker modifications
	/\bdocker\s+rm\b/i,
	/\bdocker\s+rmi\b/i,
	/\bdocker\s+stop\b/i,
	/\bdocker\s+kill\b/i,
	/\bdocker-compose\s+down\b/i,
	/\bdocker-compose\s+rm\b/i,
	// Git modifications
	/\bgit\s+push\b/i,
	/\bgit\s+reset\b/i,
	/\bgit\s+revert\b/i,
	/\bgit\s+checkout\b/i,
];

/**
 * Check if a command contains unsafe patterns
 */
export function containsUnsafePattern(
	command: string,
	patterns: RegExp[] = DEFAULT_UNSAFE_PATTERNS,
): boolean {
	return patterns.some((pattern) => pattern.test(command));
}

/**
 * Find which unsafe pattern was matched
 */
export function findUnsafePattern(
	command: string,
	patterns: RegExp[] = DEFAULT_UNSAFE_PATTERNS,
): string | undefined {
	for (const pattern of patterns) {
		if (pattern.test(command)) {
			return pattern.source;
		}
	}
	return undefined;
}

/**
 * Execute a command with timeout
 */
export async function executeCommandWithTimeout(
	command: string,
	args: string[],
	workDir: string,
	timeoutMs: number,
	env?: Record<string, string>,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let killed = false;

		const childProcess: ChildProcess = spawn(command, args, {
			cwd: workDir,
			env: { ...process.env, ...env },
			shell: true,
		});

		const timeout = setTimeout(() => {
			killed = true;
			childProcess.kill("SIGTERM");
			// Give process time to clean up, then force kill
			setTimeout(() => {
				if (!childProcess.killed) {
					childProcess.kill("SIGKILL");
				}
			}, 1000);
		}, timeoutMs);

		childProcess.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		childProcess.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		childProcess.on("error", (error: Error) => {
			clearTimeout(timeout);
			reject(new Error(`Failed to spawn process: ${error.message}`));
		});

		childProcess.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timeout);

			if (killed) {
				resolve({
					stdout,
					stderr,
					exitCode: null,
					signal: "SIGTERM",
					success: false,
				});
			} else {
				resolve({
					stdout,
					stderr,
					exitCode: code,
					signal,
					success: code === 0,
				});
			}
		});
	});
}

/**
 * Base probe class with common functionality
 *
 * Provides:
 * - Timeout handling for probe execution
 * - Safety checks to prevent unintended modifications
 * - Retry logic with configurable delays
 * - Metrics tracking
 * - Lifecycle hooks
 */
export abstract class BaseProbe<TOutput = unknown> implements IProbe<TOutput> {
	readonly probeType: ProbeType;
	readonly config: ProbeConfig;
	readonly isReadOnly: boolean;

	protected hooks: ProbeHooks = {};

	constructor(probeType: ProbeType, configOverrides?: Partial<ProbeConfig>) {
		this.probeType = probeType;
		const defaultConfig = getProbeConfig(probeType);
		this.config = {
			...defaultConfig,
			...configOverrides,
		};
		this.isReadOnly = this.config.read_only;
	}

	/**
	 * Validate probe input
	 * Subclasses can override for specific validation
	 */
	validateInput(input: ProbeInput): boolean {
		// Validate workDir is provided
		if (!input.workDir || input.workDir.trim().length === 0) {
			return false;
		}
		// Validate timeout is positive
		if (input.timeout_ms !== undefined && input.timeout_ms <= 0) {
			return false;
		}
		return true;
	}

	/**
	 * Parse the raw output from probe execution
	 * Subclasses must implement this to provide probe-specific parsing
	 */
	abstract parseOutput(rawOutput: string): TOutput;

	/**
	 * Get commands to execute for this probe
	 * Subclasses must implement this to define what commands to run
	 */
	protected abstract getCommands(input: ProbeInput): Array<{ command: string; args: string[] }>;

	/**
	 * Get unsafe patterns for this probe
	 * Subclasses can override to add probe-specific patterns
	 */
	getUnsafePatterns(): RegExp[] {
		return [...DEFAULT_UNSAFE_PATTERNS];
	}

	/**
	 * Execute the probe with safety checks and timeout
	 */
	async execute(input: ProbeInput, options?: ProbeExecutionOptions): Promise<ProbeResult> {
		const startTime = Date.now();
		const probeId = generateProbeId(this.probeType);
		const timeoutMs = options?.timeoutMs ?? input.timeout_ms ?? this.config.timeout_ms;
		const maxRetries = options?.maxRetries ?? this.config.max_retries;
		const retryDelayMs = options?.retryDelayMs ?? this.config.retry_delay_ms;
		const forceReadOnly = options?.forceReadOnly ?? false;
		let currentInput = input;
		let retries = 0;

		// Run before hooks
		currentInput = await this.runBeforeHooks(currentInput);

		// Validate input
		if (!this.validateInput(currentInput)) {
			const error = new ProbeExecutionError("Invalid probe input", this.probeType);
			await this.runErrorHooks(currentInput, error);
			return this.createErrorResult(probeId, error, startTime);
		}

		// Get commands to execute
		const commands = this.getCommands(currentInput);

		// Safety check for read-only probes
		if (this.isReadOnly || forceReadOnly) {
			const unsafePatterns = this.getUnsafePatterns();
			for (const cmd of commands) {
				const fullCommand = `${cmd.command} ${cmd.args.join(" ")}`;
				const unsafePattern = findUnsafePattern(fullCommand, unsafePatterns);
				if (unsafePattern) {
					const error = new ProbeSafetyError(
						`Unsafe command detected in read-only probe: ${unsafePattern}`,
						this.probeType,
						unsafePattern,
					);
					await this.runErrorHooks(currentInput, error);
					return this.createErrorResult(probeId, error, startTime);
				}
			}
		}

		// Execute with retries
		while (retries <= maxRetries) {
			try {
				const result = await this.executeWithTimeout(
					probeId,
					currentInput,
					commands,
					timeoutMs,
					startTime,
					forceReadOnly,
				);

				// Run after hooks
				const finalResult = await this.runAfterHooks(currentInput, result);
				return finalResult;
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));

				// Don't retry timeout errors
				if (err instanceof ProbeTimeoutError) {
					await this.runErrorHooks(currentInput, err);
					return this.createErrorResult(probeId, err, startTime);
				}

				retries++;
				if (retries > maxRetries) {
					await this.runErrorHooks(currentInput, err);
					return this.createErrorResult(probeId, err, startTime);
				}

				// Wait before retry
				await this.delay(retryDelayMs);
			}
		}

		// Should not reach here, but handle just in case
		const error = new ProbeExecutionError("Unexpected execution state", this.probeType);
		return this.createErrorResult(probeId, error, startTime);
	}

	/**
	 * Execute commands with timeout
	 */
	private async executeWithTimeout(
		probeId: string,
		input: ProbeInput,
		commands: Array<{ command: string; args: string[] }>,
		timeoutMs: number,
		startTime: number,
		forceReadOnly: boolean,
	): Promise<ProbeResult> {
		const outputs: string[] = [];
		let lastExitCode: number | null = null;

		for (const cmd of commands) {
			const commandResult = await executeCommandWithTimeout(
				cmd.command,
				cmd.args,
				input.workDir,
				timeoutMs,
			);

			outputs.push(commandResult.stdout);
			lastExitCode = commandResult.exitCode;

			// Check for timeout
			if (commandResult.signal === "SIGTERM" || commandResult.signal === "SIGKILL") {
				throw new ProbeTimeoutError(
					`Probe ${this.probeType} timed out after ${timeoutMs}ms`,
					this.probeType,
					timeoutMs,
				);
			}

			// Check for failure (but continue for some probes)
			if (!commandResult.success && !this.shouldContinueOnFailure(commandResult)) {
				const durationMs = Date.now() - startTime;
				return createProbeResult(probeId, this.probeType, false, {
					error: commandResult.stderr || `Command failed with exit code ${commandResult.exitCode}`,
					duration_ms: durationMs,
					raw_output: commandResult.stdout,
					exit_code: commandResult.exitCode ?? undefined,
					read_only: this.isReadOnly || forceReadOnly,
				});
			}
		}

		const rawOutput = outputs.join("\n");
		const durationMs = Date.now() - startTime;

		try {
			const parsedOutput = this.parseOutput(rawOutput);
			const findings = this.extractFindings(parsedOutput);

			return createProbeResult(probeId, this.probeType, true, {
				output: this.formatOutput(parsedOutput),
				duration_ms: durationMs,
				raw_output: rawOutput,
				exit_code: lastExitCode ?? undefined,
				findings,
				read_only: this.isReadOnly || forceReadOnly,
			});
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return createProbeResult(probeId, this.probeType, false, {
				error: `Failed to parse output: ${err.message}`,
				duration_ms: durationMs,
				raw_output: rawOutput,
				exit_code: lastExitCode ?? undefined,
				read_only: this.isReadOnly || forceReadOnly,
			});
		}
	}

	/**
	 * Check if probe should continue on command failure
	 * Subclasses can override for specific behavior
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return false;
	}

	/**
	 * Extract findings from parsed output
	 * Subclasses should override to extract probe-specific findings
	 */
	extractFindings(_output: TOutput): ProbeResult["findings"] {
		return [];
	}

	/**
	 * Format parsed output for human-readable display
	 * Subclasses should override for probe-specific formatting
	 */
	formatOutput(output: TOutput): string {
		return JSON.stringify(output, null, 2);
	}

	/**
	 * Create an error result
	 */
	private createErrorResult(probeId: string, error: Error, startTime: number): ProbeResult {
		const durationMs = Date.now() - startTime;
		return createProbeResult(probeId, this.probeType, false, {
			error: error.message,
			duration_ms: durationMs,
			read_only: this.isReadOnly,
		});
	}

	/**
	 * Register a before execute hook
	 */
	onBeforeExecute(hook: (input: ProbeInput) => Promise<ProbeInput>): void {
		if (!this.hooks.beforeExecute) {
			this.hooks.beforeExecute = [];
		}
		this.hooks.beforeExecute.push(hook);
	}

	/**
	 * Register an after execute hook
	 */
	onAfterExecute(hook: (input: ProbeInput, result: ProbeResult) => Promise<ProbeResult>): void {
		if (!this.hooks.afterExecute) {
			this.hooks.afterExecute = [];
		}
		this.hooks.afterExecute.push(hook);
	}

	/**
	 * Register an error hook
	 */
	onError(hook: (input: ProbeInput, error: Error) => Promise<void>): void {
		if (!this.hooks.onError) {
			this.hooks.onError = [];
		}
		this.hooks.onError.push(hook);
	}

	/**
	 * Clear all hooks
	 */
	clearHooks(): void {
		this.hooks = {};
	}

	/**
	 * Run before hooks
	 */
	private async runBeforeHooks(input: ProbeInput): Promise<ProbeInput> {
		let currentInput = input;
		if (this.hooks.beforeExecute) {
			for (const hook of this.hooks.beforeExecute) {
				currentInput = await hook(currentInput);
			}
		}
		return currentInput;
	}

	/**
	 * Run after hooks
	 */
	private async runAfterHooks(input: ProbeInput, result: ProbeResult): Promise<ProbeResult> {
		let currentResult = result;
		if (this.hooks.afterExecute) {
			for (const hook of this.hooks.afterExecute) {
				currentResult = await hook(input, currentResult);
			}
		}
		return currentResult;
	}

	/**
	 * Run error hooks
	 */
	private async runErrorHooks(input: ProbeInput, error: Error): Promise<void> {
		if (this.hooks.onError) {
			for (const hook of this.hooks.onError) {
				await hook(input, error);
			}
		}
	}

	/**
	 * Delay utility for retries
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create probe input helper
 */
export function createProbeInput(
	workDir: string,
	options?: Partial<Omit<ProbeInput, "workDir">>,
): ProbeInput {
	return {
		workDir,
		targets: options?.targets ? [...options.targets] : [],
		options: options?.options ? { ...options.options } : {},
		timeout_ms: options?.timeout_ms ?? 30000,
		verbose: options?.verbose ?? false,
	};
}

/**
 * Check if a probe supports execution in a directory
 */
export function isProbeSupported(probeType: ProbeType, workDir: string): boolean {
	// This is a simple check - specific probes can implement more sophisticated checks
	return workDir.trim().length > 0;
}

/**
 * Merge multiple probe results into metrics
 */
export function mergeProbeMetrics(results: ProbeResult[]): ProbeMetrics {
	if (results.length === 0) {
		return createEmptyProbeMetrics();
	}

	let totalDuration = 0;
	let totalRetries = 0;
	let totalFindings = 0;
	const findingsBySeverity = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	for (const result of results) {
		const metrics = createMetricsFromProbeResult(result);
		totalDuration += metrics.duration_ms;
		totalRetries += metrics.retries;
		totalFindings += metrics.findings_count;
		findingsBySeverity.CRITICAL += metrics.findings_by_severity.CRITICAL;
		findingsBySeverity.HIGH += metrics.findings_by_severity.HIGH;
		findingsBySeverity.MEDIUM += metrics.findings_by_severity.MEDIUM;
		findingsBySeverity.LOW += metrics.findings_by_severity.LOW;
		findingsBySeverity.INFO += metrics.findings_by_severity.INFO;
	}

	return {
		duration_ms: totalDuration,
		retries: totalRetries,
		findings_count: totalFindings,
		findings_by_severity: findingsBySeverity,
	};
}

/**
 * Execute multiple probes in parallel with a concurrency limit
 */
export async function executeProbesInParallel<TOutput>(
	probes: IProbe<TOutput>[],
	inputs: ProbeInput[],
	maxConcurrent = 4,
): Promise<ProbeResult[]> {
	if (probes.length !== inputs.length) {
		throw new Error("Number of probes must match number of inputs");
	}

	const results: ProbeResult[] = [];
	const queue = probes.map((probe, index) => ({ probe, input: inputs[index], index }));

	// Process in batches
	for (let i = 0; i < queue.length; i += maxConcurrent) {
		const batch = queue.slice(i, i + maxConcurrent);
		const batchPromises = batch.map(async (item) => {
			const result = await item.probe.execute(item.input);
			return { result, index: item.index };
		});

		const batchResults = await Promise.allSettled(batchPromises);

		for (const settled of batchResults) {
			if (settled.status === "fulfilled") {
				results[settled.value.index] = settled.value.result;
			} else {
				// Create error result for rejected promises
				const index = batch[batchResults.indexOf(settled)]?.index ?? 0;
				const probe = queue[index].probe;
				results[index] = createProbeResult(
					generateProbeId(probe.probeType),
					probe.probeType,
					false,
					{ error: settled.reason?.message ?? "Probe execution failed" },
				);
			}
		}
	}

	return results;
}

/**
 * Check if all probes completed successfully
 */
export function allProbesSucceeded(results: ProbeResult[]): boolean {
	return results.every((result) => result.success);
}

/**
 * Get failed probe results
 */
export function getFailedProbes(results: ProbeResult[]): ProbeResult[] {
	return results.filter((result) => !result.success);
}

/**
 * Get successful probe results
 */
export function getSuccessfulProbes(results: ProbeResult[]): ProbeResult[] {
	return results.filter((result) => result.success);
}
