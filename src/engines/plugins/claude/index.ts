import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
} from "../../../schemas/engine.schema";
import { parseStreamJson } from "../../core/parsers/stream-json";
import type { IEnginePlugin } from "../../core/types";

/**
 * Claude CLI plugin for the Anthropic Claude Code assistant.
 * Uses the `claude` CLI tool with stream-json output format.
 *
 * Supports advanced Claude CLI features:
 * - JSON Schema for structured output validation
 * - System prompt customization
 * - Tool access control
 * - Session management
 * - MCP server configuration
 * - Custom subagents
 *
 * @see https://code.claude.com/docs/en/cli-reference
 */
export class ClaudePlugin implements IEnginePlugin {
	readonly name = "claude";

	readonly config: EngineConfig = {
		name: "claude",
		command: "claude",
		// Default args for non-interactive SDK mode:
		// --output-format stream-json: Structured output for parsing
		// --verbose: Full turn-by-turn output for debugging
		// --dangerously-skip-permissions: Skip all permission prompts to prevent hanging
		args: ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 30,
			maxPerHour: 500,
			minTime: 200,
		},
	};

	/**
	 * Check if the Claude CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["which", "claude"], {
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
	 * Build command line arguments for Claude execution.
	 *
	 * Supports all major Claude CLI flags for enhanced functionality:
	 * - Model selection
	 * - JSON Schema validation for structured output
	 * - System prompt customization
	 * - Tool access control
	 * - Session management
	 * - MCP configuration
	 * - Custom subagents
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args = [...this.config.args];

		// Model override
		if (request.modelOverride) {
			args.push("--model", request.modelOverride);
		}

		// JSON Schema for structured output validation
		// This ensures the AI returns valid JSON matching the schema
		if (request.jsonSchema) {
			args.push("--json-schema", JSON.stringify(request.jsonSchema));
		}

		// System prompt customization
		// Appends to the default system prompt without replacing it
		if (request.systemPromptAppend) {
			args.push("--append-system-prompt", request.systemPromptAppend);
		}

		// Include partial streaming events for real-time output
		if (request.includePartialMessages) {
			args.push("--include-partial-messages");
		}

		// Tool access control
		// allowedTools: Tools that execute without prompting for permission
		if (request.allowedTools && request.allowedTools.length > 0) {
			args.push("--allowedTools", ...request.allowedTools);
		}

		// disallowedTools: Tools that are removed from the model's context
		if (request.disallowedTools && request.disallowedTools.length > 0) {
			args.push("--disallowedTools", ...request.disallowedTools);
		}

		// tools: Restrict which built-in tools Claude can use
		if (request.tools && request.tools.length > 0) {
			args.push("--tools", request.tools.join(","));
		}

		// MCP server configuration
		if (request.mcpConfig) {
			args.push("--mcp-config", request.mcpConfig);
		}

		// Custom subagents
		if (request.agents && Object.keys(request.agents).length > 0) {
			args.push("--agents", JSON.stringify(request.agents));
		}

		// Additional working directories
		if (request.additionalDirs && request.additionalDirs.length > 0) {
			args.push("--add-dir", ...request.additionalDirs);
		}

		// Session management
		if (request.sessionId) {
			args.push("--session-id", request.sessionId);
		}

		if (request.continueSession) {
			args.push("--continue");
		}

		if (request.resumeSession) {
			args.push("--resume", request.resumeSession);
		}

		// Debug mode with optional category filtering
		// --debug: Enable debug mode (e.g., "api,hooks" or "!statsig,!file")
		if (request.metadata?.debug) {
			if (typeof request.metadata.debug === "string") {
				args.push("--debug", request.metadata.debug);
			} else {
				args.push("--debug");
			}
		}

		// Max turns limit (print mode only)
		// --max-turns: Limit the number of agentic turns
		if (request.metadata?.maxTurns && typeof request.metadata.maxTurns === "number") {
			args.push("--max-turns", String(request.metadata.maxTurns));
		}

		// Max budget limit (print mode only)
		// --max-budget-usd: Maximum dollar amount to spend
		if (request.metadata?.maxBudgetUsd) {
			args.push("--max-budget-usd", String(request.metadata.maxBudgetUsd));
		}

		// Add the prompt using -p flag (print mode for SDK usage)
		args.push("-p", request.prompt);

		// Note: Working directory is handled by the executor via Bun.spawn's cwd option
		// Claude CLI does not have a --cwd flag

		return args;
	}

	/**
	 * Parse Claude's stream-json output format.
	 */
	parseOutput(output: string): ExecutionResult {
		return parseStreamJson(output);
	}

	/**
	 * Get environment variables for Claude execution.
	 */
	getEnv(): Record<string, string> {
		return {
			// Ensure non-interactive mode
			CI: "true",
			// Disable color output for cleaner parsing
			NO_COLOR: "1",
		};
	}

	/**
	 * Indicates whether this plugin uses stdin for prompt input.
	 * Claude CLI uses the -p flag for prompts, not stdin.
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}
}

/**
 * Claude plugin configuration options.
 */
export interface ClaudePluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Default model to use (sonnet, opus, or full model name) */
	defaultModel?: string;
	/** Default system prompt to append to all requests */
	defaultSystemPromptAppend?: string;
	/** Default MCP config path */
	defaultMcpConfig?: string;
	/** Enable debug mode with optional category filtering */
	debug?: boolean | string;
}

/**
 * Subagent definition for Claude --agents flag
 */
export interface ClaudeSubagent {
	/** Natural language description of when the subagent should be invoked */
	description: string;
	/** The system prompt that guides the subagent's behavior */
	prompt: string;
	/** Array of specific tools the subagent can use */
	tools?: string[];
	/** Model alias to use: sonnet, opus, haiku, or inherit */
	model?: "sonnet" | "opus" | "haiku" | "inherit";
}

/**
 * Create a Claude plugin with custom configuration.
 */
export function createClaudePlugin(options: ClaudePluginOptions = {}): ClaudePlugin {
	const plugin = new ClaudePlugin();

	// Apply custom configuration
	if (options.timeout) {
		(plugin.config as { timeout: number }).timeout = options.timeout;
	}

	if (options.maxConcurrent) {
		(plugin.config as { maxConcurrent: number }).maxConcurrent = options.maxConcurrent;
	}

	const extraArgs: string[] = [];

	// Add default model if specified
	if (options.defaultModel) {
		extraArgs.push("--model", options.defaultModel);
	}

	// Add debug mode if enabled
	if (options.debug) {
		if (typeof options.debug === "string") {
			extraArgs.push("--debug", options.debug);
		} else {
			extraArgs.push("--debug");
		}
	}

	// Merge extra args
	if (options.extraArgs) {
		extraArgs.push(...options.extraArgs);
	}

	if (extraArgs.length > 0) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...extraArgs];
	}

	// Override getEnv if custom env provided
	if (options.env) {
		const originalGetEnv = plugin.getEnv.bind(plugin);
		plugin.getEnv = () => ({
			...originalGetEnv(),
			...options.env,
		});
	}

	return plugin;
}

/**
 * Helper to create a JSON schema for structured output.
 * Use with request.jsonSchema to ensure Claude returns valid JSON.
 *
 * @example
 * ```typescript
 * const schema = createJsonSchema({
 *   success: { type: "boolean" },
 *   files: { type: "array", items: { type: "string" } },
 *   summary: { type: "string" }
 * }, ["success", "summary"]);
 *
 * executor.execute(plugin, {
 *   prompt: "...",
 *   workDir: "...",
 *   jsonSchema: schema
 * });
 * ```
 */
export function createJsonSchema(
	properties: Record<string, unknown>,
	required?: string[],
): Record<string, unknown> {
	return {
		type: "object",
		properties,
		required: required ?? Object.keys(properties),
	};
}

/**
 * Helper to create subagent definitions for Claude --agents flag.
 *
 * @example
 * ```typescript
 * const agents = createSubagents({
 *   reviewer: {
 *     description: "Expert code reviewer",
 *     prompt: "You are a senior code reviewer...",
 *     tools: ["Read", "Grep", "Glob"],
 *     model: "sonnet"
 *   }
 * });
 *
 * executor.execute(plugin, {
 *   prompt: "...",
 *   workDir: "...",
 *   agents
 * });
 * ```
 */
export function createSubagents(
	agents: Record<string, ClaudeSubagent>,
): Record<string, ClaudeSubagent> {
	return agents;
}

/**
 * Common tool patterns for allowedTools/disallowedTools.
 * Use with request.allowedTools or request.disallowedTools.
 *
 * @example
 * ```typescript
 * executor.execute(plugin, {
 *   prompt: "...",
 *   workDir: "...",
 *   allowedTools: [
 *     CLAUDE_TOOLS.READ,
 *     CLAUDE_TOOLS.bashPattern("npm test"),
 *     CLAUDE_TOOLS.bashPattern("git *")
 *   ]
 * });
 * ```
 */
export const CLAUDE_TOOLS = {
	/** Read file tool */
	READ: "Read",
	/** Edit file tool */
	EDIT: "Edit",
	/** Write file tool */
	WRITE: "Write",
	/** Grep search tool */
	GREP: "Grep",
	/** Glob file matching tool */
	GLOB: "Glob",
	/** Bash command tool (all commands) */
	BASH: "Bash",
	/** All default tools */
	DEFAULT: "default",
	/** No tools */
	NONE: "",

	/**
	 * Create a Bash tool pattern for specific commands.
	 * @param pattern - Command pattern (e.g., "npm test:*", "git *")
	 */
	bashPattern: (pattern: string): string => `Bash(${pattern})`,

	/**
	 * Create a pattern for read-only tools.
	 */
	readOnly: (): string[] => ["Read", "Grep", "Glob"],

	/**
	 * Create a pattern for safe git operations.
	 */
	safeGit: (): string[] => [
		"Bash(git status:*)",
		"Bash(git log:*)",
		"Bash(git diff:*)",
		"Bash(git show:*)",
	],

	/**
	 * Create a pattern for npm/pnpm/yarn operations.
	 */
	packageManager: (manager: "npm" | "pnpm" | "yarn" = "npm"): string[] => [
		`Bash(${manager} test:*)`,
		`Bash(${manager} run:*)`,
		`Bash(${manager} install:*)`,
	],
};
