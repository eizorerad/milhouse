import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStep,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Qwen Code output formats for headless mode.
 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/headless#output-formats
 */
export const QWEN_OUTPUT_FORMATS = {
	/** Human-readable text output (default) */
	TEXT: "text",
	/** JSON array of messages on completion */
	JSON: "json",
	/** Newline-delimited JSON (NDJSON) for streaming */
	STREAM_JSON: "stream-json",
} as const;

export type QwenOutputFormat = (typeof QWEN_OUTPUT_FORMATS)[keyof typeof QWEN_OUTPUT_FORMATS];

/**
 * Qwen Code approval modes.
 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode
 */
export const QWEN_APPROVAL_MODES = {
	/** Default approval mode - prompts for confirmation */
	DEFAULT: "default",
	/** Auto-approve file edits */
	AUTO_EDIT: "auto_edit",
	/** Auto-approve all actions (same as --yolo) */
	FULL_AUTO: "full_auto",
} as const;

export type QwenApprovalMode = (typeof QWEN_APPROVAL_MODES)[keyof typeof QWEN_APPROVAL_MODES];

/**
 * Qwen CLI plugin for the Alibaba Qwen Code AI coding assistant.
 * Uses the `qwen` CLI tool.
 *
 * @see https://github.com/QwenLM/qwen-code
 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/headless
 *
 * @example
 * ```typescript
 * const plugin = new QwenPlugin();
 *
 * // Basic execution
 * const args = plugin.buildArgs({
 *   prompt: "refactor the auth module",
 *   workDir: "/path/to/project"
 * });
 * // Result: ["-p", "refactor the auth module", "--output-format", "stream-json", "--yolo"]
 *
 * // With session resume
 * const args = plugin.buildArgs({
 *   prompt: "continue the refactoring",
 *   continueSession: true
 * });
 * // Result: ["-p", "continue the refactoring", "--output-format", "stream-json", "--yolo", "--continue"]
 * ```
 */
export class QwenPlugin implements IEnginePlugin {
	readonly name = "qwen";

	readonly config: EngineConfig = {
		name: "qwen",
		command: "qwen",
		args: [], // Base args, will be built dynamically
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 40,
			maxPerHour: 600,
			minTime: 150,
		},
	};

	/**
	 * Check if the Qwen CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["which", "qwen"], {
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
	 * Qwen CLI uses -p flag for prompt, not stdin.
	 * @returns false - prompt is passed as CLI argument
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}

	/**
	 * Build command line arguments for Qwen execution.
	 *
	 * Command structure:
	 * ```
	 * qwen [options] -p "prompt"
	 * ```
	 *
	 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/headless#configuration-options
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args: string[] = [];

		// Prompt flag for headless mode (required)
		// -p/--prompt: Run in headless mode
		args.push("-p", request.prompt);

		// Output format for structured output
		// --output-format: text | json | stream-json
		const outputFormat = request.outputFormat || "stream-json";
		args.push("--output-format", outputFormat);

		// Stream partial messages for real-time streaming
		// --include-partial-messages: Include partial messages in stream-json output
		if (request.includePartialMessages && outputFormat === QWEN_OUTPUT_FORMATS.STREAM_JSON) {
			args.push("--include-partial-messages");
		}

		// Auto-approve mode
		// -y/--yolo: Auto-approve all actions
		// --approval-mode: Set approval mode
		if (request.autoApprove !== false) {
			args.push("--yolo");
		} else if (request.mode) {
			const approvalMode = this.mapApprovalMode(request.mode);
			if (approvalMode) {
				args.push("--approval-mode", approvalMode);
			}
		}

		// Session management
		// --continue: Resume the most recent session for this project
		// --resume [sessionId]: Resume a specific session
		if (request.continueSession) {
			args.push("--continue");
		} else if (request.resumeSession) {
			args.push("--resume", request.resumeSession);
		} else if (request.sessionId) {
			args.push("--resume", request.sessionId);
		}

		// Debug mode
		// -d/--debug: Enable debug mode
		if (request.metadata?.debug) {
			args.push("--debug");
		}

		// Include all files in context
		// -a/--all-files: Include all files in context
		if (request.metadata?.allFiles) {
			args.push("--all-files");
		}

		// Include additional directories
		// --include-directories: Include additional directories
		if (request.additionalDirs && request.additionalDirs.length > 0) {
			args.push("--include-directories", request.additionalDirs.join(","));
		}

		// Experimental skills
		// --experimental-skills: Enable experimental Skills
		if (request.metadata?.experimentalSkills) {
			args.push("--experimental-skills");
		}

		return args;
	}

	/**
	 * Map generic mode to Qwen approval mode.
	 */
	private mapApprovalMode(mode: string): QwenApprovalMode | null {
		const modeMap: Record<string, QwenApprovalMode> = {
			default: QWEN_APPROVAL_MODES.DEFAULT,
			auto_edit: QWEN_APPROVAL_MODES.AUTO_EDIT,
			full_auto: QWEN_APPROVAL_MODES.FULL_AUTO,
			// Map common aliases
			auto: QWEN_APPROVAL_MODES.AUTO_EDIT,
			yolo: QWEN_APPROVAL_MODES.FULL_AUTO,
		};
		return modeMap[mode.toLowerCase()] || null;
	}

	/**
	 * Parse Qwen's output based on format.
	 * Supports text, json, and stream-json formats.
	 */
	parseOutput(output: string): ExecutionResult {
		// Try to parse as JSON first (for json and stream-json formats)
		const trimmed = output.trim();

		// Handle stream-json format (NDJSON)
		if (trimmed.includes("\n") && trimmed.startsWith("{")) {
			return this.parseStreamJsonOutput(trimmed);
		}

		// Handle JSON array format
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			return this.parseJsonArrayOutput(trimmed);
		}

		// Handle single JSON object
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			return this.parseJsonOutput(trimmed);
		}

		// Fall back to text parsing
		return parseTextOutput(output);
	}

	/**
	 * Parse JSON array output format.
	 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/headless#json-output
	 */
	private parseJsonArrayOutput(output: string): ExecutionResult {
		try {
			const messages = JSON.parse(output);
			const steps: ExecutionStep[] = [];
			const assistantMessages: string[] = [];
			let sessionId: string | undefined;
			let durationMs = 0;
			let isError = false;

			for (const msg of messages) {
				const now = new Date().toISOString();

				switch (msg.type) {
					case "system":
						if (msg.subtype === "session_start") {
							sessionId = msg.session_id;
							steps.push({
								type: "thinking",
								content: `Session started with model: ${msg.model || "unknown"}`,
								timestamp: now,
								metadata: {
									sessionId: msg.session_id,
									model: msg.model,
								},
							});
						}
						break;

					case "assistant":
						if (msg.message?.content) {
							for (const content of msg.message.content) {
								if (content.type === "text" && content.text) {
									assistantMessages.push(content.text);
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
						sessionId = msg.session_id;
						durationMs = msg.duration_ms || 0;
						isError = msg.is_error || false;
						if (msg.result && !assistantMessages.length) {
							assistantMessages.push(msg.result);
						}
						break;
				}
			}

			const result = assistantMessages.join("\n");

			if (isError) {
				return {
					success: false,
					output: result,
					steps,
					duration: durationMs,
					error: "Qwen execution failed",
				};
			}

			return {
				success: true,
				output: result,
				steps,
				duration: durationMs,
			};
		} catch {
			return parseTextOutput(output);
		}
	}

	/**
	 * Parse single JSON object output format.
	 */
	private parseJsonOutput(output: string): ExecutionResult {
		try {
			const data = JSON.parse(output);
			const now = new Date().toISOString();

			if (data.type === "result") {
				const steps: ExecutionStep[] = [
					{
						type: data.is_error ? "error" : "result",
						content: data.result || "",
						timestamp: now,
						metadata: {
							sessionId: data.session_id,
						},
					},
				];

				return {
					success: !data.is_error,
					output: data.result || "",
					steps,
					duration: data.duration_ms || 0,
					error: data.is_error ? "Qwen execution failed" : undefined,
				};
			}

			return {
				success: true,
				output: data.result || data.response || output,
				steps: [
					{
						type: "result",
						content: data.result || data.response || output,
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
	 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/headless#stream-json-output
	 */
	private parseStreamJsonOutput(output: string): ExecutionResult {
		const lines = output.trim().split("\n");
		const messages: string[] = [];
		const steps: ExecutionStep[] = [];
		let sessionId: string | undefined;
		let durationMs = 0;
		let isError = false;

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const event = JSON.parse(line);
				const now = new Date().toISOString();

				switch (event.type) {
					case "system":
						if (event.subtype === "session_start") {
							sessionId = event.session_id;
							steps.push({
								type: "thinking",
								content: `Session started with model: ${event.model || "unknown"}`,
								timestamp: now,
								metadata: {
									sessionId: event.session_id,
									model: event.model,
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

					case "tool_use":
						steps.push({
							type: "tool_use",
							content: `Tool: ${event.tool || "unknown"}`,
							timestamp: now,
							metadata: event,
						});
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
				error: "Qwen execution failed",
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
	 * Get environment variables for Qwen execution.
	 */
	getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			CI: "true",
			NO_COLOR: "1",
		};

		// Pass through Qwen API key if set
		if (process.env.QWEN_API_KEY) {
			env.QWEN_API_KEY = process.env.QWEN_API_KEY;
		}

		// Pass through OpenAI-compatible API settings
		if (process.env.OPENAI_API_KEY) {
			env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
		}
		if (process.env.OPENAI_BASE_URL) {
			env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
		}
		if (process.env.OPENAI_MODEL) {
			env.OPENAI_MODEL = process.env.OPENAI_MODEL;
		}

		return env;
	}
}

/**
 * Qwen plugin configuration options.
 */
export interface QwenPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Qwen API key */
	apiKey?: string;
	/** OpenAI-compatible API key */
	openaiApiKey?: string;
	/** OpenAI-compatible base URL */
	openaiBaseUrl?: string;
	/** Default output format */
	outputFormat?: QwenOutputFormat;
	/** Default approval mode */
	approvalMode?: QwenApprovalMode;
}

/**
 * Create a Qwen plugin with custom configuration.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const plugin = createQwenPlugin();
 *
 * // With custom options
 * const plugin = createQwenPlugin({
 *   timeout: 300000,
 *   outputFormat: QWEN_OUTPUT_FORMATS.JSON,
 *   approvalMode: QWEN_APPROVAL_MODES.AUTO_EDIT,
 *   apiKey: process.env.MY_QWEN_KEY
 * });
 * ```
 */
export function createQwenPlugin(options: QwenPluginOptions = {}): QwenPlugin {
	const plugin = new QwenPlugin();

	if (options.timeout) {
		(plugin.config as { timeout: number }).timeout = options.timeout;
	}

	if (options.maxConcurrent) {
		(plugin.config as { maxConcurrent: number }).maxConcurrent = options.maxConcurrent;
	}

	if (options.extraArgs) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...options.extraArgs];
	}

	// Handle API keys and custom env
	const originalGetEnv = plugin.getEnv.bind(plugin);
	plugin.getEnv = () => {
		const env = originalGetEnv();
		if (options.apiKey) {
			env.QWEN_API_KEY = options.apiKey;
		}
		if (options.openaiApiKey) {
			env.OPENAI_API_KEY = options.openaiApiKey;
		}
		if (options.openaiBaseUrl) {
			env.OPENAI_BASE_URL = options.openaiBaseUrl;
		}
		if (options.env) {
			Object.assign(env, options.env);
		}
		return env;
	};

	return plugin;
}

/**
 * Helper to create a Qwen request with proper typing.
 *
 * @example
 * ```typescript
 * const request = createQwenRequest({
 *   prompt: "implement user authentication",
 *   continueSession: true,
 *   additionalDirs: ["src", "docs"]
 * });
 * ```
 */
export function createQwenRequest(
	options: Partial<Omit<ExecutionRequest, "prompt">> & { prompt: string },
): ExecutionRequest {
	return {
		workDir: options.workDir || process.cwd(),
		timeout: options.timeout || 4000000,
		maxRetries: options.maxRetries || 3,
		streamOutput: options.streamOutput ?? true,
		outputFormat: options.outputFormat || QWEN_OUTPUT_FORMATS.STREAM_JSON,
		...options,
	} as ExecutionRequest;
}
