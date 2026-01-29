import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStep,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Cursor Agent modes.
 * @see https://cursor.com/docs/cli/overview#modes
 */
export const CURSOR_MODES = {
	/** Full access to all tools for complex coding tasks (default) */
	AGENT: "agent",
	/** Design your approach before coding with clarifying questions */
	PLAN: "plan",
	/** Read-only exploration without making changes */
	ASK: "ask",
} as const;

export type CursorMode = (typeof CURSOR_MODES)[keyof typeof CURSOR_MODES];

/**
 * Cursor output formats for non-interactive mode.
 * @see https://cursor.com/docs/cli/reference/output-format
 */
export const CURSOR_OUTPUT_FORMATS = {
	/** Human-readable text output (default) */
	TEXT: "text",
	/** Single JSON object on completion */
	JSON: "json",
	/** Newline-delimited JSON (NDJSON) for streaming */
	STREAM_JSON: "stream-json",
} as const;

export type CursorOutputFormat = (typeof CURSOR_OUTPUT_FORMATS)[keyof typeof CURSOR_OUTPUT_FORMATS];

/**
 * Cursor CLI plugin for the Cursor AI coding assistant.
 * Uses the `agent` CLI tool (Cursor Agent CLI).
 *
 * @see https://cursor.com/docs/cli/overview
 * @see https://cursor.com/docs/cli/reference/parameters
 *
 * @example
 * ```typescript
 * const plugin = new CursorPlugin();
 *
 * // Basic execution
 * const args = plugin.buildArgs({
 *   prompt: "refactor the auth module",
 *   workDir: "/path/to/project"
 * });
 * // Result: ["-p", "--output-format", "stream-json", "-f", "refactor the auth module"]
 *
 * // With mode and model
 * const args = plugin.buildArgs({
 *   prompt: "analyze this code",
 *   mode: "ask",
 *   modelOverride: "gpt-5"
 * });
 * // Result: ["-p", "--output-format", "stream-json", "-f", "--mode", "ask", "-m", "gpt-5", "analyze this code"]
 * ```
 */
export class CursorPlugin implements IEnginePlugin {
	readonly name = "cursor";

	readonly config: EngineConfig = {
		name: "cursor",
		command: "agent", // Cursor CLI uses `agent` command
		args: [], // Base args, will be built dynamically
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 1, // Cursor typically runs single instance
		rateLimit: {
			maxPerMinute: 20,
			maxPerHour: 300,
			minTime: 500,
		},
	};

	/**
	 * Check if the Cursor Agent CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Use 'where' on Windows, 'which' on Unix
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";
			const proc = Bun.spawn([checkCommand, "agent"], {
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
	 * Cursor CLI uses positional argument for prompt, not stdin.
	 * @returns false - prompt is passed as CLI argument
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}

	/**
	 * Build command line arguments for Cursor Agent execution.
	 *
	 * Command structure:
	 * ```
	 * agent [options] [prompt]
	 * ```
	 *
	 * @see https://cursor.com/docs/cli/reference/parameters
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args: string[] = [];

		// Print mode for non-interactive execution (required for automation)
		// -p/--print: Print responses to console
		args.push("-p");

		// Output format for structured output
		// --output-format: text | json | stream-json
		const outputFormat = request.outputFormat || "stream-json";
		args.push("--output-format", outputFormat);

		// Stream partial output for real-time streaming
		// --stream-partial-output: Stream text deltas (only with stream-json)
		if (request.includePartialMessages && outputFormat === CURSOR_OUTPUT_FORMATS.STREAM_JSON) {
			args.push("--stream-partial-output");
		}

		// Force mode to auto-approve commands
		// -f/--force: Force allow commands unless explicitly denied
		if (request.autoApprove !== false) {
			args.push("-f");
		}

		// Agent mode
		// --mode: agent | plan | ask
		if (request.mode) {
			const mode = this.mapMode(request.mode);
			if (mode) {
				args.push("--mode", mode);
			}
		}

		// Model override
		// -m/--model: Model to use
		if (request.modelOverride) {
			args.push("-m", request.modelOverride);
		}

		// Session management
		// --resume: Resume a chat session
		if (request.resumeSession) {
			args.push("--resume", request.resumeSession);
		} else if (request.sessionId) {
			args.push("--resume", request.sessionId);
		}

		// API key (prefer environment variable, but support flag)
		// -a/--api-key: API key for authentication
		if (request.apiKey) {
			args.push("-a", request.apiKey);
		}

		// Background mode
		// -b/--background: Start in background mode
		if (request.background) {
			args.push("-b");
		}

		// Fullscreen mode
		// --fullscreen: Enable fullscreen mode
		if (request.fullscreen) {
			args.push("--fullscreen");
		}

		// Add the prompt as positional argument (must be last)
		args.push(request.prompt);

		return args;
	}

	/**
	 * Map generic mode to Cursor-specific mode.
	 */
	private mapMode(mode: string): CursorMode | null {
		const modeMap: Record<string, CursorMode> = {
			agent: CURSOR_MODES.AGENT,
			plan: CURSOR_MODES.PLAN,
			ask: CURSOR_MODES.ASK,
			// Map common aliases
			execute: CURSOR_MODES.AGENT,
			code: CURSOR_MODES.AGENT,
			implement: CURSOR_MODES.AGENT,
			design: CURSOR_MODES.PLAN,
			analyze: CURSOR_MODES.ASK,
			review: CURSOR_MODES.ASK,
			question: CURSOR_MODES.ASK,
		};
		return modeMap[mode.toLowerCase()] || null;
	}

	/**
	 * Parse Cursor's output based on format.
	 * Supports text, json, and stream-json formats.
	 */
	parseOutput(output: string): ExecutionResult {
		// Try to parse as JSON first (for json and stream-json formats)
		const trimmed = output.trim();

		// Handle stream-json format (NDJSON)
		if (trimmed.includes("\n") && trimmed.startsWith("{")) {
			return this.parseStreamJsonOutput(trimmed);
		}

		// Handle single JSON object
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			return this.parseJsonOutput(trimmed);
		}

		// Fall back to text parsing
		return parseTextOutput(output);
	}

	/**
	 * Parse JSON output format.
	 * @see https://cursor.com/docs/cli/reference/output-format#json-format
	 */
	private parseJsonOutput(output: string): ExecutionResult {
		try {
			const data = JSON.parse(output);
			const now = new Date().toISOString();

			if (data.type === "result" && data.subtype === "success") {
				const steps: ExecutionStep[] = [
					{
						type: "result",
						content: data.result || "",
						timestamp: now,
						metadata: {
							sessionId: data.session_id,
							requestId: data.request_id,
						},
					},
				];

				return {
					success: true,
					output: data.result || "",
					steps,
					duration: data.duration_ms || 0,
				};
			}

			// Handle error case
			if (data.is_error) {
				const steps: ExecutionStep[] = [
					{
						type: "error",
						content: data.error || "Cursor execution failed",
						timestamp: now,
					},
				];

				return {
					success: false,
					output: data.result || output,
					steps,
					duration: data.duration_ms || 0,
					error: data.error || "Cursor execution failed",
				};
			}

			return {
				success: true,
				output: data.result || output,
				steps: [
					{
						type: "result",
						content: data.result || output,
						timestamp: now,
					},
				],
				duration: data.duration_ms || 0,
			};
		} catch {
			return parseTextOutput(output);
		}
	}

	/**
	 * Parse stream-json (NDJSON) output format.
	 * @see https://cursor.com/docs/cli/reference/output-format#stream-json-format
	 */
	private parseStreamJsonOutput(output: string): ExecutionResult {
		const lines = output.trim().split("\n");
		const messages: string[] = [];
		const steps: ExecutionStep[] = [];
		let sessionId: string | undefined;
		let durationMs = 0;
		let isError = false;
		let errorMessage: string | undefined;

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const event = JSON.parse(line);
				const now = new Date().toISOString();

				switch (event.type) {
					case "system":
						if (event.subtype === "init") {
							sessionId = event.session_id;
							steps.push({
								type: "thinking",
								content: `Session initialized with model: ${event.model || "unknown"}`,
								timestamp: now,
								metadata: {
									sessionId: event.session_id,
									model: event.model,
									permissionMode: event.permissionMode,
								},
							});
						}
						break;

					case "assistant":
						if (event.message?.content) {
							for (const content of event.message.content) {
								if (content.type === "text" && content.text) {
									messages.push(content.text);
									steps.push({
										type: "result",
										content: content.text,
										timestamp: now,
									});
								}
							}
						}
						break;

					case "result":
						sessionId = event.session_id;
						durationMs = event.duration_ms || 0;
						isError = event.is_error || false;
						if (event.result && !messages.length) {
							messages.push(event.result);
						}
						break;

					case "tool_call":
						if (event.subtype === "started") {
							const toolName = this.extractToolName(event.tool_call);
							steps.push({
								type: "tool_use",
								content: `Tool call started: ${toolName}`,
								timestamp: now,
								metadata: {
									callId: event.call_id,
									toolCall: event.tool_call,
								},
							});
						} else if (event.subtype === "completed") {
							const toolName = this.extractToolName(event.tool_call);
							steps.push({
								type: "tool_use",
								content: `Tool call completed: ${toolName}`,
								timestamp: now,
								metadata: {
									callId: event.call_id,
									toolCall: event.tool_call,
								},
							});
						}
						break;
				}
			} catch {
				// Skip malformed lines
			}
		}

		const result = messages.join("\n");

		if (isError) {
			return {
				success: false,
				output: result,
				steps,
				duration: durationMs,
				error: errorMessage || "Cursor execution failed",
			};
		}

		return {
			success: true,
			output: result,
			steps,
			duration: durationMs,
		};
	}

	/**
	 * Extract tool name from tool_call event.
	 */
	private extractToolName(toolCall: Record<string, unknown>): string {
		if (toolCall.readToolCall) return "read";
		if (toolCall.writeToolCall) return "write";
		if (toolCall.function) {
			const fn = toolCall.function as { name?: string };
			return fn.name || "unknown";
		}
		return Object.keys(toolCall)[0] || "unknown";
	}

	/**
	 * Get environment variables for Cursor execution.
	 */
	getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			CI: "true",
			NO_COLOR: "1",
		};

		// Pass through CURSOR_API_KEY if set
		if (process.env.CURSOR_API_KEY) {
			env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
		}

		return env;
	}
}

/**
 * Cursor plugin configuration options.
 */
export interface CursorPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Default output format */
	outputFormat?: CursorOutputFormat;
	/** Default mode */
	mode?: CursorMode;
	/** API key for authentication */
	apiKey?: string;
}

/**
 * Create a Cursor plugin with custom configuration.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const plugin = createCursorPlugin();
 *
 * // With custom options
 * const plugin = createCursorPlugin({
 *   timeout: 300000,
 *   mode: CURSOR_MODES.PLAN,
 *   outputFormat: CURSOR_OUTPUT_FORMATS.JSON,
 *   apiKey: process.env.MY_CURSOR_KEY
 * });
 * ```
 */
export function createCursorPlugin(options: CursorPluginOptions = {}): CursorPlugin {
	const plugin = new CursorPlugin();

	if (options.timeout) {
		(plugin.config as { timeout: number }).timeout = options.timeout;
	}

	if (options.maxConcurrent) {
		(plugin.config as { maxConcurrent: number }).maxConcurrent = options.maxConcurrent;
	}

	if (options.extraArgs) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...options.extraArgs];
	}

	if (options.env || options.apiKey) {
		const originalGetEnv = plugin.getEnv.bind(plugin);
		plugin.getEnv = () => ({
			...originalGetEnv(),
			...(options.apiKey ? { CURSOR_API_KEY: options.apiKey } : {}),
			...options.env,
		});
	}

	return plugin;
}

/**
 * Helper to create a Cursor request with proper typing.
 *
 * @example
 * ```typescript
 * const request = createCursorRequest({
 *   prompt: "implement user authentication",
 *   mode: CURSOR_MODES.AGENT,
 *   modelOverride: "gpt-5"
 * });
 * ```
 */
export function createCursorRequest(
	options: Partial<Omit<ExecutionRequest, "prompt">> & { prompt: string },
): ExecutionRequest {
	return {
		workDir: options.workDir || process.cwd(),
		timeout: options.timeout || 4000000,
		maxRetries: options.maxRetries || 3,
		streamOutput: options.streamOutput ?? true,
		outputFormat: options.outputFormat || CURSOR_OUTPUT_FORMATS.STREAM_JSON,
		...options,
	} as ExecutionRequest;
}
