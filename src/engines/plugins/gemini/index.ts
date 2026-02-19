import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStep,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Gemini CLI output formats for headless mode.
 * @see https://geminicli.com/docs/cli/headless#output-formats
 */
export const GEMINI_OUTPUT_FORMATS = {
	/** Human-readable text output (default) */
	TEXT: "text",
	/** JSON object with response and stats on completion */
	JSON: "json",
	/** Newline-delimited JSON (NDJSON) for streaming */
	STREAM_JSON: "stream-json",
} as const;

export type GeminiOutputFormat = (typeof GEMINI_OUTPUT_FORMATS)[keyof typeof GEMINI_OUTPUT_FORMATS];

/**
 * Gemini CLI approval modes.
 * @see https://geminicli.com/docs/get-started/configuration#command-line-arguments
 */
export const GEMINI_APPROVAL_MODES = {
	/** Default approval mode - prompts for confirmation */
	DEFAULT: "default",
	/** Auto-approve file edits */
	AUTO_EDIT: "auto_edit",
	/** Auto-approve all actions (same as --yolo) */
	YOLO: "yolo",
	/** Read-only mode for tool calls (requires experimental planning) */
	PLAN: "plan",
} as const;

export type GeminiApprovalMode = (typeof GEMINI_APPROVAL_MODES)[keyof typeof GEMINI_APPROVAL_MODES];

/**
 * Gemini CLI models available.
 * @see https://geminicli.com/docs/get-started/configuration#model
 */
export const GEMINI_MODELS = {
	/** Gemini 3 Pro Preview - Latest reasoning model */
	GEMINI_3_PRO: "gemini-3-pro-preview",
	/** Gemini 3 Flash Preview - Fast model */
	GEMINI_3_FLASH: "gemini-3-flash-preview",
	/** Gemini 2.5 Pro - Stable pro model */
	GEMINI_2_5_PRO: "gemini-2.5-pro",
	/** Gemini 2.5 Flash - Fast stable model */
	GEMINI_2_5_FLASH: "gemini-2.5-flash",
	/** Gemini 2.5 Flash Lite - Lightweight model */
	GEMINI_2_5_FLASH_LITE: "gemini-2.5-flash-lite",
} as const;

export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

/**
 * Gemini CLI plugin for the Google Gemini Code AI coding assistant.
 * Uses the `gemini` CLI tool.
 *
 * Features:
 * - Free tier: 60 requests/min and 1,000 requests/day with personal Google account
 * - Powerful Gemini 3 models with 1M token context window
 * - Built-in tools: Google Search grounding, file operations, shell commands, web fetching
 * - MCP (Model Context Protocol) support for custom integrations
 * - Multiple output formats: text, json, stream-json
 *
 * @see https://github.com/google-gemini/gemini-cli
 * @see https://geminicli.com/docs/cli/headless
 *
 * @example
 * ```typescript
 * const plugin = new GeminiPlugin();
 *
 * // Basic execution
 * const args = plugin.buildArgs({
 *   prompt: "refactor the auth module",
 *   workDir: "/path/to/project"
 * });
 * // Result: ["--prompt", "refactor the auth module", "--output-format", "stream-json", "--yolo"]
 *
 * // With model override
 * const args = plugin.buildArgs({
 *   prompt: "analyze this code",
 *   modelOverride: "gemini-3-pro-preview"
 * });
 * // Result: ["--prompt", "analyze this code", "--output-format", "stream-json", "--yolo", "--model", "gemini-3-pro-preview"]
 * ```
 */
export class GeminiPlugin implements IEnginePlugin {
	readonly name = "gemini";

	readonly config: EngineConfig = {
		name: "gemini",
		command: "gemini",
		args: [], // Base args, will be built dynamically
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 60, // Free tier: 60 requests/min
			maxPerHour: 1000, // Free tier: 1,000 requests/day
			minTime: 100,
		},
	};

	/**
	 * Check if the Gemini CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Use 'where' on Windows, 'which' on Unix
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";
			const proc = Bun.spawn([checkCommand, "gemini"], {
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
	 * Gemini CLI uses --prompt/-p flag for prompt, not stdin.
	 * @returns false - prompt is passed as CLI argument
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}

	/**
	 * Build command line arguments for Gemini execution.
	 *
	 * Command structure:
	 * ```
	 * gemini [options] --prompt "prompt"
	 * ```
	 *
	 * @see https://geminicli.com/docs/cli/headless#configuration-options
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args: string[] = [];

		// Prompt for headless mode (required)
		// Gemini CLI supports a positional prompt (preferred).
		// NOTE: --prompt/-p is deprecated and emits a warning into stdout, which can
		// break stream-json parsing.

		// Output format for structured output
		// --output-format: text | json | stream-json
		const outputFormat = request.outputFormat || "stream-json";
		args.push("--output-format", outputFormat);

		// Model selection
		// -m/--model: Specify the Gemini model
		if (request.modelOverride) {
			args.push("--model", request.modelOverride);
		}

		// Auto-approve mode
		// -y/--yolo: Auto-approve all actions
		// --approval-mode: Set approval mode (default, auto_edit, yolo, plan)
		if (request.autoApprove !== false) {
			args.push("--yolo");
		} else if (request.mode) {
			const approvalMode = this.mapApprovalMode(request.mode);
			if (approvalMode) {
				args.push("--approval-mode", approvalMode);
			}
		}

		// Allowed tools bypass confirmation
		// --allowed-tools: repeated flag OR comma-separated
		if (request.allowedTools && request.allowedTools.length > 0) {
			args.push("--allowed-tools", ...request.allowedTools);
		}

		// Session management
		// --resume [session_id]: Resume a previous session
		if (request.resumeSession) {
			args.push("--resume", request.resumeSession);
		} else if (request.sessionId) {
			args.push("--resume", request.sessionId);
		}

		// Include additional directories
		// --include-directories: Include additional directories in workspace
		if (request.additionalDirs && request.additionalDirs.length > 0) {
			args.push("--include-directories", request.additionalDirs.join(","));
		}

		// Debug mode
		// -d/--debug: Enable debug mode
		if (request.metadata?.debug) {
			args.push("--debug");
		}

		// Sandbox mode
		// -s/--sandbox: Enable sandbox mode
		if (request.metadata?.sandbox) {
			args.push("--sandbox");
		}

		// Screen reader mode
		// --screen-reader: Enable screen reader mode
		if (request.metadata?.screenReader) {
			args.push("--screen-reader");
		}

		// Add the prompt as a positional arg (must be last)
		args.push(request.prompt);

		return args;
	}

	/**
	 * Map generic mode to Gemini approval mode.
	 */
	private mapApprovalMode(mode: string): GeminiApprovalMode | null {
		const modeMap: Record<string, GeminiApprovalMode> = {
			default: GEMINI_APPROVAL_MODES.DEFAULT,
			auto_edit: GEMINI_APPROVAL_MODES.AUTO_EDIT,
			yolo: GEMINI_APPROVAL_MODES.YOLO,
			plan: GEMINI_APPROVAL_MODES.PLAN,
			// Map common aliases
			auto: GEMINI_APPROVAL_MODES.AUTO_EDIT,
			full_auto: GEMINI_APPROVAL_MODES.YOLO,
		};
		return modeMap[mode.toLowerCase()] || null;
	}

	/**
	 * Parse Gemini's output based on format.
	 * Supports text, json, and stream-json formats.
	 */
	parseOutput(output: string): ExecutionResult {
		const trimmed = output.trim();
		if (!trimmed) return parseTextOutput(output);

		// Gemini sometimes prints non-JSON preamble lines (e.g. YOLO mode, cached credentials)
		// BEFORE the NDJSON stream. We therefore detect stream-json by scanning for the first
		// JSON line that contains a top-level `type` field, and parse from there.
		const lines = trimmed.split("\n");
		const firstJsonLineIndex = lines.findIndex((l) => l.trim().startsWith("{"));
		if (firstJsonLineIndex >= 0) {
			// Probe a few lines to decide whether this is Gemini stream-json
			for (let i = firstJsonLineIndex; i < Math.min(lines.length, firstJsonLineIndex + 5); i++) {
				const candidate = lines[i]?.trim();
				if (!candidate?.startsWith("{")) continue;
				try {
					const parsed = JSON.parse(candidate) as unknown;
					if (
						parsed &&
						typeof parsed === "object" &&
						"type" in (parsed as Record<string, unknown>)
					) {
						return this.parseStreamJsonOutput(lines.slice(firstJsonLineIndex).join("\n"));
					}
				} catch {
					// keep probing
				}
			}
		}

		// Handle JSON object format (possibly with extra preamble lines)
		// If the full trimmed output is a JSON object, parse directly.
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			return this.parseJsonOutput(trimmed);
		}

		// Fall back to text parsing
		return parseTextOutput(output);
	}

	/**
	 * Parse JSON output format.
	 * @see https://geminicli.com/docs/cli/headless#json-output
	 *
	 * Response schema:
	 * {
	 *   "response": "string",
	 *   "stats": {
	 *     "models": { ... },
	 *     "tools": { ... },
	 *     "files": { ... }
	 *   },
	 *   "error": { ... } // optional
	 * }
	 */
	private parseJsonOutput(output: string): ExecutionResult {
		try {
			const data = JSON.parse(output);
			const now = new Date().toISOString();
			const steps: ExecutionStep[] = [];

			// Extract response
			const response = data.response || "";

			// Extract stats
			const stats = data.stats || {};
			let durationMs = 0;
			let toolCalls = 0;

			// Calculate duration from model latencies
			if (stats.models) {
				for (const modelStats of Object.values(stats.models) as Array<{
					api?: { totalLatencyMs?: number };
				}>) {
					if (modelStats.api?.totalLatencyMs) {
						durationMs += modelStats.api.totalLatencyMs;
					}
				}
			}

			// Extract tool stats
			if (stats.tools) {
				toolCalls = stats.tools.totalCalls || 0;
				steps.push({
					type: "tool_use",
					content: `Tool calls: ${toolCalls} (${stats.tools.totalSuccess || 0} success, ${stats.tools.totalFail || 0} failed)`,
					timestamp: now,
					metadata: stats.tools,
				});
			}

			// Check for error
			if (data.error) {
				return {
					success: false,
					output: response || data.error.message || "Gemini execution failed",
					steps,
					duration: durationMs,
					error: data.error.message || "Gemini execution failed",
				};
			}

			steps.push({
				type: "result",
				content: response,
				timestamp: now,
				metadata: { stats },
			});

			return {
				success: true,
				output: response,
				steps,
				duration: durationMs,
			};
		} catch {
			return parseTextOutput(output);
		}
	}

	/**
	 * Parse stream-json (NDJSON) output format.
	 * @see https://geminicli.com/docs/cli/headless#streaming-json-output
	 *
	 * Event types:
	 * - init: Session starts
	 * - message: User prompts and assistant responses
	 * - tool_use: Tool call requests
	 * - tool_result: Tool execution results
	 * - error: Non-fatal errors
	 * - result: Final session outcome
	 *
	 * IMPORTANT: Gemini sends assistant messages with delta:true for streaming chunks.
	 * The final complete response is typically the last non-delta message or
	 * the concatenation of all assistant messages.
	 */
	private parseStreamJsonOutput(output: string): ExecutionResult {
		const lines = output.trim().split("\n");
		const assistantMessages: string[] = [];
		const steps: ExecutionStep[] = [];
		let sessionId: string | undefined;
		let durationMs = 0;
		let isError = false;
		let errorMessage: string | undefined;
		let inputTokens = 0;
		let outputTokens = 0;
		let lastNonDeltaMessage: string | undefined;

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const event = JSON.parse(line);
				const timestamp = event.timestamp || new Date().toISOString();

				switch (event.type) {
					case "init":
						sessionId = event.session_id;
						steps.push({
							type: "thinking",
							content: `Session started with model: ${event.model || "unknown"}`,
							timestamp,
							metadata: {
								sessionId: event.session_id,
								model: event.model,
							},
						});
						break;

					case "message":
						if (event.role === "assistant" && event.content) {
							assistantMessages.push(event.content);

							// Track the last non-delta message as it's likely the final response
							if (!event.delta) {
								lastNonDeltaMessage = event.content;
							}

							// For streaming UI, delta messages are "thinking" (intermediate)
							// Non-delta messages are "result" (final)
							steps.push({
								type: event.delta ? "thinking" : "result",
								content: event.content,
								timestamp,
								metadata: {
									isDelta: event.delta || false,
								},
							});
						}
						break;

					case "tool_use":
						steps.push({
							type: "tool_use",
							content: `Tool: ${event.tool_name || "unknown"} (${event.tool_id || "no-id"})`,
							timestamp,
							metadata: {
								toolName: event.tool_name,
								toolId: event.tool_id,
								parameters: event.parameters,
							},
						});
						break;

					case "tool_result":
						steps.push({
							type: event.status === "success" ? "result" : "error",
							content: event.output || `Tool ${event.tool_id} ${event.status}`,
							timestamp,
							metadata: {
								isToolResult: true,
								toolId: event.tool_id,
								status: event.status,
							},
						});
						break;

					case "error":
						isError = true;
						errorMessage = event.message || "Unknown error";
						steps.push({
							type: "error",
							content: errorMessage || "Unknown error",
							timestamp,
							metadata: event,
						});
						break;

					case "result":
						sessionId = event.session_id;
						durationMs = event.stats?.duration_ms || 0;
						isError = event.status !== "success";
						inputTokens = event.stats?.input_tokens || 0;
						outputTokens = event.stats?.output_tokens || 0;
						if (event.stats?.total_tokens) {
							steps.push({
								type: "thinking",
								content: `Tokens: ${event.stats.total_tokens} (input: ${event.stats.input_tokens || 0}, output: ${event.stats.output_tokens || 0})`,
								timestamp,
								metadata: event.stats,
							});
						}
						break;
				}
			} catch {
				// Skip malformed lines
			}
		}

		// Determine the final output:
		// 1. Prefer the last non-delta message (complete response)
		// 2. Fall back to joining all assistant messages
		// 3. For JSON responses, the last message typically contains the full JSON
		let finalOutput = lastNonDeltaMessage || assistantMessages.join("\n");

		// If we have multiple messages and the last one looks like JSON, use it
		// This handles cases where Gemini sends the full JSON in the final message
		if (assistantMessages.length > 0) {
			const lastMessage = assistantMessages[assistantMessages.length - 1];
			if (lastMessage.trim().startsWith("[") || lastMessage.trim().startsWith("{")) {
				finalOutput = lastMessage;
			}
		}

		// Add a final result step with the complete output for extractFinalResult to find
		// This ensures the adapter can extract the final response correctly
		if (finalOutput && finalOutput.trim()) {
			const now = new Date().toISOString();
			steps.push({
				type: "result",
				content: finalOutput,
				timestamp: now,
				metadata: {
					isFinalResponse: true,
				},
			});
		}

		if (isError) {
			return {
				success: false,
				output: finalOutput || errorMessage || "Gemini execution failed",
				steps,
				duration: durationMs,
				error: errorMessage || "Gemini execution failed",
				tokens: { input: inputTokens, output: outputTokens },
			};
		}

		return {
			success: true,
			output: finalOutput,
			steps,
			duration: durationMs,
			tokens: { input: inputTokens, output: outputTokens },
		};
	}

	/**
	 * Get environment variables for Gemini execution.
	 */
	getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			CI: "true",
			NO_COLOR: "1",
		};

		// Pass through Gemini API key if set
		if (process.env.GEMINI_API_KEY) {
			env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
		}

		// Pass through Google Cloud settings
		if (process.env.GOOGLE_API_KEY) {
			env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
		}
		if (process.env.GOOGLE_CLOUD_PROJECT) {
			env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
		}
		if (process.env.GOOGLE_CLOUD_LOCATION) {
			env.GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION;
		}
		if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
			env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		}

		// Vertex AI settings
		if (process.env.GOOGLE_GENAI_USE_VERTEXAI) {
			env.GOOGLE_GENAI_USE_VERTEXAI = process.env.GOOGLE_GENAI_USE_VERTEXAI;
		}

		// Model override
		if (process.env.GEMINI_MODEL) {
			env.GEMINI_MODEL = process.env.GEMINI_MODEL;
		}

		return env;
	}
}

/**
 * Gemini plugin configuration options.
 */
export interface GeminiPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Gemini API key */
	apiKey?: string;
	/** Google Cloud API key */
	googleApiKey?: string;
	/** Google Cloud Project ID */
	googleCloudProject?: string;
	/** Google Cloud Location */
	googleCloudLocation?: string;
	/** Default output format */
	outputFormat?: GeminiOutputFormat;
	/** Default approval mode */
	approvalMode?: GeminiApprovalMode;
	/** Default model */
	model?: GeminiModel | string;
	/** Enable sandbox mode */
	sandbox?: boolean;
}

/**
 * Create a Gemini plugin with custom configuration.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const plugin = createGeminiPlugin();
 *
 * // With custom options
 * const plugin = createGeminiPlugin({
 *   timeout: 300000,
 *   outputFormat: GEMINI_OUTPUT_FORMATS.JSON,
 *   approvalMode: GEMINI_APPROVAL_MODES.AUTO_EDIT,
 *   model: GEMINI_MODELS.GEMINI_3_PRO,
 *   apiKey: process.env.MY_GEMINI_KEY
 * });
 *
 * // With Vertex AI
 * const plugin = createGeminiPlugin({
 *   googleApiKey: process.env.GOOGLE_API_KEY,
 *   googleCloudProject: "my-project",
 *   googleCloudLocation: "us-central1",
 *   env: { GOOGLE_GENAI_USE_VERTEXAI: "true" }
 * });
 * ```
 */
export function createGeminiPlugin(options: GeminiPluginOptions = {}): GeminiPlugin {
	const plugin = new GeminiPlugin();

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

	// Add sandbox mode if enabled
	if (options.sandbox) {
		extraArgs.push("--sandbox");
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
		if (options.apiKey) {
			env.GEMINI_API_KEY = options.apiKey;
		}
		if (options.googleApiKey) {
			env.GOOGLE_API_KEY = options.googleApiKey;
		}
		if (options.googleCloudProject) {
			env.GOOGLE_CLOUD_PROJECT = options.googleCloudProject;
		}
		if (options.googleCloudLocation) {
			env.GOOGLE_CLOUD_LOCATION = options.googleCloudLocation;
		}
		if (options.env) {
			Object.assign(env, options.env);
		}
		return env;
	};

	return plugin;
}

/**
 * Helper to create a Gemini request with proper typing.
 *
 * @example
 * ```typescript
 * const request = createGeminiRequest({
 *   prompt: "implement user authentication",
 *   modelOverride: GEMINI_MODELS.GEMINI_3_PRO,
 *   additionalDirs: ["src", "docs"]
 * });
 * ```
 */
export function createGeminiRequest(
	options: Partial<Omit<ExecutionRequest, "prompt">> & { prompt: string },
): ExecutionRequest {
	return {
		workDir: options.workDir || process.cwd(),
		timeout: options.timeout || 4000000,
		maxRetries: options.maxRetries || 3,
		streamOutput: options.streamOutput ?? true,
		outputFormat: options.outputFormat || GEMINI_OUTPUT_FORMATS.STREAM_JSON,
		...options,
	} as ExecutionRequest;
}

/**
 * Common tool patterns for Gemini --allowed-tools.
 * Use with request.allowedTools.
 *
 * @example
 * ```typescript
 * executor.execute(plugin, {
 *   prompt: "...",
 *   workDir: "...",
 *   allowedTools: [
 *     GEMINI_TOOLS.shellCommand("git status"),
 *     GEMINI_TOOLS.shellCommand("npm test")
 *   ]
 * });
 * ```
 */
export const GEMINI_TOOLS = {
	/** Shell command tool pattern */
	shellCommand: (command: string): string => `run_shell_command(${command})`,

	/** Read file tool */
	READ_FILE: "read_file",

	/** Write file tool */
	WRITE_FILE: "write_file",

	/** Replace in file tool */
	REPLACE: "replace",

	/** Shell command tool (all commands) */
	SHELL: "run_shell_command",

	/** Google web search tool */
	WEB_SEARCH: "google_web_search",

	/** Web fetch tool */
	WEB_FETCH: "web_fetch",

	/**
	 * Create a pattern for read-only tools.
	 */
	readOnly: (): string[] => ["read_file", "glob", "grep"],

	/**
	 * Create a pattern for safe git operations.
	 */
	safeGit: (): string[] => [
		"run_shell_command(git status)",
		"run_shell_command(git log)",
		"run_shell_command(git diff)",
		"run_shell_command(git show)",
	],

	/**
	 * Create a pattern for npm/pnpm/yarn operations.
	 */
	packageManager: (manager: "npm" | "pnpm" | "yarn" = "npm"): string[] => [
		`run_shell_command(${manager} test)`,
		`run_shell_command(${manager} run)`,
		`run_shell_command(${manager} install)`,
	],
};
