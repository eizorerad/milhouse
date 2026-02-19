import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStep,
} from "../../../schemas/engine.schema";
import type { IEnginePlugin } from "../../core/types";

/**
 * Aider edit formats for different coding styles.
 * @see https://aider.chat/docs/config/options.html#--edit-format-edit_format
 */
export const AIDER_EDIT_FORMATS = {
	/** Default edit format (depends on model) */
	DEFAULT: "default",
	/** Whole file replacement */
	WHOLE: "whole",
	/** Diff-based editing */
	DIFF: "diff",
	/** Unified diff format */
	UDIFF: "udiff",
	/** Architect mode (plan then edit) */
	ARCHITECT: "architect",
} as const;

export type AiderEditFormat = (typeof AIDER_EDIT_FORMATS)[keyof typeof AIDER_EDIT_FORMATS];

/**
 * Aider supported models (common ones).
 * @see https://aider.chat/docs/config/options.html#main-model
 */
export const AIDER_MODELS = {
	/** Claude 3.7 Sonnet (default for Anthropic) */
	CLAUDE_SONNET: "anthropic/claude-3-7-sonnet-20250219",
	/** Claude 3 Opus */
	CLAUDE_OPUS: "claude-3-opus-20240229",
	/** Claude 3.5 Haiku */
	CLAUDE_HAIKU: "claude-3-5-haiku-20241022",
	/** GPT-4o */
	GPT_4O: "gpt-4o",
	/** GPT-4o Mini */
	GPT_4O_MINI: "gpt-4o-mini",
	/** GPT-4 Turbo */
	GPT_4_TURBO: "gpt-4-1106-preview",
	/** DeepSeek Chat */
	DEEPSEEK: "deepseek/deepseek-chat",
	/** o1-mini */
	O1_MINI: "o1-mini",
	/** o1-preview */
	O1_PREVIEW: "o1-preview",
} as const;

export type AiderModel = (typeof AIDER_MODELS)[keyof typeof AIDER_MODELS];

/**
 * Aider CLI plugin for the Aider AI pair programming tool.
 * Uses the `aider` CLI tool.
 *
 * Features:
 * - Supports multiple LLM providers (OpenAI, Anthropic, DeepSeek, etc.)
 * - Git-aware with automatic commits
 * - Repository map for context
 * - Multiple edit formats (whole, diff, udiff, architect)
 * - Linting and testing integration
 * - Voice input support
 *
 * @see https://aider.chat/
 * @see https://aider.chat/docs/scripting.html
 *
 * @example
 * ```typescript
 * const plugin = new AiderPlugin();
 *
 * // Basic execution
 * const args = plugin.buildArgs({
 *   prompt: "add docstrings to all functions",
 *   workDir: "/path/to/project"
 * });
 * // Result: ["--message", "add docstrings to all functions", "--yes", "--no-stream"]
 *
 * // With model override
 * const args = plugin.buildArgs({
 *   prompt: "refactor the auth module",
 *   modelOverride: "gpt-4o"
 * });
 * // Result: ["--message", "refactor the auth module", "--yes", "--no-stream", "--model", "gpt-4o"]
 * ```
 */
export class AiderPlugin implements IEnginePlugin {
	readonly name = "aider";

	readonly config: EngineConfig = {
		name: "aider",
		command: "aider",
		args: [], // Base args, will be built dynamically
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 3,
		rateLimit: {
			maxPerMinute: 30, // Conservative rate limit
			maxPerHour: 500,
			minTime: 200,
		},
	};

	/**
	 * Check if the Aider CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Use 'where' on Windows, 'which' on Unix
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";
			const proc = Bun.spawn([checkCommand, "aider"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Aider uses --message/-m flag for prompt, not stdin.
	 * @returns false - prompt is passed as CLI argument
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}

	/**
	 * Build command line arguments for Aider execution.
	 *
	 * Command structure:
	 * ```
	 * aider [options] --message "prompt" [files...]
	 * ```
	 *
	 * @see https://aider.chat/docs/scripting.html
	 * @see https://aider.chat/docs/config/options.html
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args: string[] = [];

		// Message flag for scripting mode (required)
		// -m/--message: Single message to send, process reply then exit
		args.push("--message", request.prompt);

		// Auto-approve all confirmations for non-interactive mode
		// --yes: Always say yes to every confirmation
		if (request.autoApprove !== false) {
			args.push("--yes");
		}

		// Disable streaming for cleaner output parsing
		// --no-stream: Disable streaming responses
		if (!request.streamOutput) {
			args.push("--no-stream");
		}

		// Model selection
		// --model: Specify the model to use for the main chat
		if (request.modelOverride) {
			args.push("--model", request.modelOverride);
		}

		// Edit format
		// --edit-format: Specify what edit format the LLM should use
		if (request.mode) {
			const editFormat = this.mapEditFormat(request.mode);
			if (editFormat) {
				args.push("--edit-format", editFormat);
			}
		}

		// Dry run mode
		// --dry-run: Perform a dry run without modifying files
		if (request.metadata?.dryRun) {
			args.push("--dry-run");
		}

		// Auto-commits control
		// --no-auto-commits: Disable auto commit of GPT changes
		if (request.metadata?.noAutoCommits) {
			args.push("--no-auto-commits");
		}

		// Dirty commits control
		// --no-dirty-commits: Disable commits when repo is found dirty
		if (request.metadata?.noDirtyCommits) {
			args.push("--no-dirty-commits");
		}

		// Architect mode
		// --architect: Use architect edit format for the main chat
		if (request.metadata?.architect) {
			args.push("--architect");
		}

		// Auto-accept architect changes
		// --auto-accept-architect: Enable automatic acceptance of architect changes
		if (request.metadata?.autoAcceptArchitect) {
			args.push("--auto-accept-architect");
		}

		// Lint command
		// --lint-cmd: Specify lint commands to run
		if (request.metadata?.lintCmd && typeof request.metadata.lintCmd === "string") {
			args.push("--lint-cmd", request.metadata.lintCmd);
		}

		// Auto-lint
		// --auto-lint: Enable automatic linting after changes
		if (request.metadata?.autoLint) {
			args.push("--auto-lint");
		}

		// Test command
		// --test-cmd: Specify command to run tests
		if (request.metadata?.testCmd && typeof request.metadata.testCmd === "string") {
			args.push("--test-cmd", request.metadata.testCmd);
		}

		// Auto-test
		// --auto-test: Enable automatic testing after changes
		if (request.metadata?.autoTest) {
			args.push("--auto-test");
		}

		// Map tokens (repo map size)
		// --map-tokens: Suggested number of tokens to use for repo map
		if (request.metadata?.mapTokens !== undefined) {
			args.push("--map-tokens", String(request.metadata.mapTokens));
		}

		// Verbose mode
		// -v/--verbose: Enable verbose output
		if (request.metadata?.verbose) {
			args.push("--verbose");
		}

		// Thinking tokens for reasoning models
		// --thinking-tokens: Set the thinking token budget
		if (request.metadata?.thinkingTokens) {
			args.push("--thinking-tokens", String(request.metadata.thinkingTokens));
		}

		// Reasoning effort
		// --reasoning-effort: Set the reasoning_effort API parameter
		if (request.metadata?.reasoningEffort && typeof request.metadata.reasoningEffort === "string") {
			args.push("--reasoning-effort", request.metadata.reasoningEffort);
		}

		// Read-only files
		// --read: Specify a read-only file
		if (request.metadata?.readFiles && Array.isArray(request.metadata.readFiles)) {
			for (const file of request.metadata.readFiles) {
				args.push("--read", file);
			}
		}

		// Files to edit (positional arguments at the end)
		// Can be passed as positional args or with --file flag
		// Using positional args as shown in scripting examples: aider --message "..." file.py
		if (request.metadata?.files && Array.isArray(request.metadata.files)) {
			// Add files as positional arguments at the end (most common in scripting)
			for (const file of request.metadata.files) {
				if (typeof file === "string") {
					args.push(file);
				}
			}
		}

		return args;
	}

	/**
	 * Map generic mode to Aider edit format.
	 */
	private mapEditFormat(mode: string): AiderEditFormat | null {
		const modeMap: Record<string, AiderEditFormat> = {
			default: AIDER_EDIT_FORMATS.DEFAULT,
			whole: AIDER_EDIT_FORMATS.WHOLE,
			diff: AIDER_EDIT_FORMATS.DIFF,
			udiff: AIDER_EDIT_FORMATS.UDIFF,
			architect: AIDER_EDIT_FORMATS.ARCHITECT,
			// Map common aliases
			plan: AIDER_EDIT_FORMATS.ARCHITECT,
		};
		return modeMap[mode.toLowerCase()] || null;
	}

	/**
	 * Parse Aider's output.
	 * Aider outputs plain text, so we use the text parser.
	 */
	parseOutput(output: string): ExecutionResult {
		const trimmed = output.trim();
		const steps: ExecutionStep[] = [];
		const now = new Date().toISOString();

		// Check for common error patterns
		if (trimmed.includes("Error:") || trimmed.includes("error:") || trimmed.includes("FAILED")) {
			const errorMatch = trimmed.match(/(?:Error|error|FAILED)[:\s]+(.+?)(?:\n|$)/);
			const errorMessage = errorMatch?.[1] || "Aider execution failed";

			steps.push({
				type: "error",
				content: errorMessage,
				timestamp: now,
			});

			return {
				success: false,
				output: trimmed,
				steps,
				duration: 0,
				error: errorMessage,
			};
		}

		// Check for commit messages (indicates successful changes)
		const commitMatch = trimmed.match(/Commit\s+([a-f0-9]+)\s+(.+)/);
		if (commitMatch) {
			steps.push({
				type: "result",
				content: `Committed: ${commitMatch[1]} - ${commitMatch[2]}`,
				timestamp: now,
				metadata: {
					commitHash: commitMatch[1],
					commitMessage: commitMatch[2],
				},
			});
		}

		// Check for file changes
		const fileChanges = trimmed.match(/(?:Created|Modified|Deleted)\s+(.+)/g);
		if (fileChanges) {
			for (const change of fileChanges) {
				steps.push({
					type: "tool_use",
					content: change,
					timestamp: now,
				});
			}
		}

		// Check for lint/test results
		if (trimmed.includes("Linting")) {
			const lintResult = trimmed.includes("passed") ? "Lint passed" : "Lint completed";
			steps.push({
				type: "result",
				content: lintResult,
				timestamp: now,
			});
		}

		if (trimmed.includes("Testing") || trimmed.includes("test")) {
			const testResult = trimmed.includes("passed") ? "Tests passed" : "Tests completed";
			steps.push({
				type: "result",
				content: testResult,
				timestamp: now,
			});
		}

		// Add the full output as a result step if no specific steps were found
		if (steps.length === 0) {
			steps.push({
				type: "result",
				content: trimmed,
				timestamp: now,
			});
		}

		return {
			success: true,
			output: trimmed,
			steps,
			duration: 0,
		};
	}

	/**
	 * Get environment variables for Aider execution.
	 */
	getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			// Disable interactive features
			AIDER_YES: "true",
			// Disable analytics
			AIDER_ANALYTICS: "false",
			// Disable update checks
			AIDER_CHECK_UPDATE: "false",
		};

		// Pass through API keys
		if (process.env.OPENAI_API_KEY) {
			env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
		}
		if (process.env.ANTHROPIC_API_KEY) {
			env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
		}
		if (process.env.AIDER_OPENAI_API_KEY) {
			env.AIDER_OPENAI_API_KEY = process.env.AIDER_OPENAI_API_KEY;
		}
		if (process.env.AIDER_ANTHROPIC_API_KEY) {
			env.AIDER_ANTHROPIC_API_KEY = process.env.AIDER_ANTHROPIC_API_KEY;
		}

		// OpenAI API settings
		if (process.env.OPENAI_API_BASE) {
			env.OPENAI_API_BASE = process.env.OPENAI_API_BASE;
		}
		if (process.env.AIDER_OPENAI_API_BASE) {
			env.AIDER_OPENAI_API_BASE = process.env.AIDER_OPENAI_API_BASE;
		}

		// Model override
		if (process.env.AIDER_MODEL) {
			env.AIDER_MODEL = process.env.AIDER_MODEL;
		}

		// DeepSeek API key
		if (process.env.DEEPSEEK_API_KEY) {
			env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
		}

		return env;
	}
}

/**
 * Aider plugin configuration options.
 */
export interface AiderPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** OpenAI API key */
	openaiApiKey?: string;
	/** Anthropic API key */
	anthropicApiKey?: string;
	/** Default model */
	model?: AiderModel | string;
	/** Default edit format */
	editFormat?: AiderEditFormat;
	/** Enable auto-commits */
	autoCommits?: boolean;
	/** Enable auto-lint */
	autoLint?: boolean;
	/** Lint command */
	lintCmd?: string;
	/** Enable auto-test */
	autoTest?: boolean;
	/** Test command */
	testCmd?: string;
	/** Map tokens for repo map */
	mapTokens?: number;
}

/**
 * Create an Aider plugin with custom configuration.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const plugin = createAiderPlugin();
 *
 * // With custom options
 * const plugin = createAiderPlugin({
 *   timeout: 300000,
 *   model: AIDER_MODELS.GPT_4O,
 *   editFormat: AIDER_EDIT_FORMATS.ARCHITECT,
 *   autoLint: true,
 *   lintCmd: "npm run lint"
 * });
 *
 * // With API keys
 * const plugin = createAiderPlugin({
 *   openaiApiKey: process.env.MY_OPENAI_KEY,
 *   anthropicApiKey: process.env.MY_ANTHROPIC_KEY
 * });
 * ```
 */
export function createAiderPlugin(options: AiderPluginOptions = {}): AiderPlugin {
	const plugin = new AiderPlugin();

	if (options.timeout) {
		(plugin.config as { timeout: number }).timeout = options.timeout;
	}

	if (options.maxConcurrent) {
		(plugin.config as { maxConcurrent: number }).maxConcurrent = options.maxConcurrent;
	}

	const extraArgs: string[] = [];

	// Add default model if specified
	if (options.model) {
		extraArgs.push("--model", options.model);
	}

	// Add default edit format if specified
	if (options.editFormat) {
		extraArgs.push("--edit-format", options.editFormat);
	}

	// Auto-commits setting
	if (options.autoCommits === false) {
		extraArgs.push("--no-auto-commits");
	}

	// Auto-lint setting
	if (options.autoLint) {
		extraArgs.push("--auto-lint");
	}

	// Lint command
	if (options.lintCmd) {
		extraArgs.push("--lint-cmd", options.lintCmd);
	}

	// Auto-test setting
	if (options.autoTest) {
		extraArgs.push("--auto-test");
	}

	// Test command
	if (options.testCmd) {
		extraArgs.push("--test-cmd", options.testCmd);
	}

	// Map tokens
	if (options.mapTokens !== undefined) {
		extraArgs.push("--map-tokens", String(options.mapTokens));
	}

	// Merge extra args
	if (options.extraArgs) {
		extraArgs.push(...options.extraArgs);
	}

	if (extraArgs.length > 0) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...extraArgs];
	}

	// Handle API keys and custom env
	const originalGetEnv = plugin.getEnv.bind(plugin);
	plugin.getEnv = () => {
		const env = originalGetEnv();
		if (options.openaiApiKey) {
			env.OPENAI_API_KEY = options.openaiApiKey;
		}
		if (options.anthropicApiKey) {
			env.ANTHROPIC_API_KEY = options.anthropicApiKey;
		}
		if (options.env) {
			Object.assign(env, options.env);
		}
		return env;
	};

	return plugin;
}

/**
 * Helper to create an Aider request with proper typing.
 *
 * @example
 * ```typescript
 * const request = createAiderRequest({
 *   prompt: "add unit tests for the auth module",
 *   modelOverride: AIDER_MODELS.GPT_4O,
 *   metadata: {
 *     files: ["src/auth.ts"],
 *     autoTest: true,
 *     testCmd: "npm test"
 *   }
 * });
 * ```
 */
export function createAiderRequest(
	options: Partial<Omit<ExecutionRequest, "prompt">> & { prompt: string },
): ExecutionRequest {
	return {
		workDir: options.workDir || process.cwd(),
		timeout: options.timeout || 4000000,
		maxRetries: options.maxRetries || 3,
		streamOutput: options.streamOutput ?? false, // Aider works better without streaming in scripting mode
		...options,
	} as ExecutionRequest;
}

/**
 * Common Aider command patterns for scripting.
 *
 * @example
 * ```typescript
 * // Add docstrings to all Python files
 * const request = createAiderRequest({
 *   prompt: AIDER_COMMANDS.addDocstrings("python"),
 *   metadata: { files: ["src/*.py"] }
 * });
 *
 * // Refactor with tests
 * const request = createAiderRequest({
 *   prompt: AIDER_COMMANDS.refactorWithTests("auth module"),
 *   metadata: { autoTest: true, testCmd: "pytest" }
 * });
 * ```
 */
export const AIDER_COMMANDS = {
	/** Add docstrings to functions */
	addDocstrings: (language: string): string =>
		`Add descriptive docstrings to all ${language} functions`,

	/** Add type hints */
	addTypeHints: (language: string): string => `Add type hints to all ${language} functions`,

	/** Write unit tests */
	writeTests: (target: string): string => `Write comprehensive unit tests for ${target}`,

	/** Refactor code */
	refactor: (target: string): string =>
		`Refactor ${target} to improve code quality and maintainability`,

	/** Refactor with tests */
	refactorWithTests: (target: string): string => `Refactor ${target} and ensure all tests pass`,

	/** Fix bug */
	fixBug: (description: string): string => `Fix the following bug: ${description}`,

	/** Add error handling */
	addErrorHandling: (target: string): string => `Add comprehensive error handling to ${target}`,

	/** Optimize performance */
	optimize: (target: string): string => `Optimize ${target} for better performance`,

	/** Add logging */
	addLogging: (target: string): string => `Add appropriate logging to ${target}`,

	/** Security review */
	securityReview: (target: string): string =>
		`Review ${target} for security vulnerabilities and fix any issues found`,
};
