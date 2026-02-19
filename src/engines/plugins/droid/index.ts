import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
	ExecutionStep,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Factory Droid output formats for headless mode.
 * @see https://docs.factory.ai/cli/droid-exec/overview#output-formats-and-artifacts
 */
export const DROID_OUTPUT_FORMATS = {
	/** Human-readable text output (default) */
	TEXT: "text",
	/** Structured JSON output for parsing */
	JSON: "json",
	/** Streaming JSONL for real-time monitoring */
	STREAM_JSON: "stream-json",
	/** JSON-RPC for multi-turn conversations */
	STREAM_JSONRPC: "stream-jsonrpc",
} as const;

export type DroidOutputFormat = (typeof DROID_OUTPUT_FORMATS)[keyof typeof DROID_OUTPUT_FORMATS];

/**
 * Factory Droid autonomy levels.
 * @see https://docs.factory.ai/cli/droid-exec/overview#autonomy-levels
 */
export const DROID_AUTONOMY_LEVELS = {
	/** Read-only mode - no modifications (default) */
	READONLY: "readonly",
	/** Low-risk operations - file creation/editing */
	LOW: "low",
	/** Development operations - package installs, git commits */
	MEDIUM: "medium",
	/** Production operations - git push, deployments */
	HIGH: "high",
} as const;

export type DroidAutonomyLevel = (typeof DROID_AUTONOMY_LEVELS)[keyof typeof DROID_AUTONOMY_LEVELS];

/**
 * Factory Droid reasoning effort levels.
 */
export const DROID_REASONING_EFFORT = {
	LOW: "low",
	MEDIUM: "medium",
	HIGH: "high",
} as const;

export type DroidReasoningEffort =
	(typeof DROID_REASONING_EFFORT)[keyof typeof DROID_REASONING_EFFORT];

/**
 * Factory Droid CLI plugin for the Factory AI coding assistant.
 * Uses the `droid exec` command for headless execution.
 *
 * @see https://docs.factory.ai/cli/droid-exec/overview
 * @see https://docs.factory.ai/reference/cli-reference
 *
 * @example
 * ```typescript
 * const plugin = new DroidPlugin();
 *
 * // Basic execution
 * const args = plugin.buildArgs({
 *   prompt: "analyze code quality",
 *   workDir: "/path/to/project"
 * });
 * // Result: ["exec", "--output-format", "stream-json", "--cwd", "/path/to/project", "analyze code quality"]
 *
 * // With autonomy level and model
 * const args = plugin.buildArgs({
 *   prompt: "fix the bug",
 *   autoApprove: true,
 *   modelOverride: "claude-sonnet-4-5-20250929"
 * });
 * // Result: ["exec", "--output-format", "stream-json", "--auto", "low", "-m", "claude-sonnet-4-5-20250929", "fix the bug"]
 * ```
 */
export class DroidPlugin implements IEnginePlugin {
	readonly name = "droid";

	readonly config: EngineConfig = {
		name: "droid",
		command: "droid",
		args: ["exec"], // Use exec subcommand for headless mode
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 30,
			maxPerHour: 500,
			minTime: 200,
		},
	};

	/**
	 * Check if the Droid CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Use 'where' on Windows, 'which' on Unix
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";
			const proc = Bun.spawn([checkCommand, "droid"], {
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
	 * Droid CLI uses positional argument for prompt, not stdin.
	 * @returns false - prompt is passed as CLI argument
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}

	/**
	 * Build command line arguments for Droid exec execution.
	 *
	 * Command structure:
	 * ```
	 * droid exec [options] [prompt]
	 * ```
	 *
	 * @see https://docs.factory.ai/cli/droid-exec/overview
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args: string[] = [...this.config.args];

		// Output format for structured output
		// -o/--output-format: text | json | stream-json | stream-jsonrpc
		const outputFormat = request.outputFormat || "stream-json";
		args.push("--output-format", outputFormat);

		// Autonomy level for auto-approval
		// --auto: low | medium | high
		if (request.autoApprove) {
			const autonomyLevel = this.mapAutonomyLevel(request.mode);
			args.push("--auto", autonomyLevel);
		}

		// Skip all permission checks (dangerous!)
		// --skip-permissions-unsafe
		if (request.metadata?.skipPermissions) {
			args.push("--skip-permissions-unsafe");
		}

		// Model override
		// -m/--model: Model ID to use
		if (request.modelOverride) {
			args.push("-m", request.modelOverride);
		}

		// Reasoning effort
		// -r/--reasoning-effort: low | medium | high
		if (request.metadata?.reasoningEffort) {
			args.push("-r", String(request.metadata.reasoningEffort));
		}

		// Session continuation
		// -s/--session-id: Existing session to continue
		if (request.sessionId) {
			args.push("-s", request.sessionId);
		} else if (request.resumeSession) {
			args.push("-s", request.resumeSession);
		}

		// Working directory
		// --cwd: Working directory path
		if (request.workDir) {
			args.push("--cwd", request.workDir);
		}

		// Spec mode
		// --use-spec: Start in specification mode
		if (request.metadata?.useSpec) {
			args.push("--use-spec");
		}

		// Spec model
		// --spec-model: Model ID for spec mode
		if (request.metadata?.specModel) {
			args.push("--spec-model", String(request.metadata.specModel));
		}

		// Tool controls
		// --enabled-tools: Enable specific tools
		if (request.allowedTools && request.allowedTools.length > 0) {
			args.push("--enabled-tools", request.allowedTools.join(","));
		}

		// --disabled-tools: Disable specific tools
		if (request.disallowedTools && request.disallowedTools.length > 0) {
			args.push("--disabled-tools", request.disallowedTools.join(","));
		}

		// Add the prompt as positional argument (must be last)
		args.push(request.prompt);

		return args;
	}

	/**
	 * Map generic mode to Droid autonomy level.
	 */
	private mapAutonomyLevel(mode?: string): DroidAutonomyLevel {
		if (!mode) return DROID_AUTONOMY_LEVELS.LOW;

		const modeMap: Record<string, DroidAutonomyLevel> = {
			readonly: DROID_AUTONOMY_LEVELS.READONLY,
			low: DROID_AUTONOMY_LEVELS.LOW,
			medium: DROID_AUTONOMY_LEVELS.MEDIUM,
			high: DROID_AUTONOMY_LEVELS.HIGH,
			// Map common aliases
			safe: DROID_AUTONOMY_LEVELS.LOW,
			dev: DROID_AUTONOMY_LEVELS.MEDIUM,
			development: DROID_AUTONOMY_LEVELS.MEDIUM,
			prod: DROID_AUTONOMY_LEVELS.HIGH,
			production: DROID_AUTONOMY_LEVELS.HIGH,
		};
		return modeMap[mode.toLowerCase()] || DROID_AUTONOMY_LEVELS.LOW;
	}

	/**
	 * Parse Droid's output based on format.
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
	 * @see https://docs.factory.ai/cli/droid-exec/overview#json
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
							numTurns: data.num_turns,
						},
					},
				];

				return {
					success: !data.is_error,
					output: data.result || "",
					steps,
					duration: data.duration_ms || 0,
					error: data.is_error ? "Droid execution failed" : undefined,
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
	 * @see https://docs.factory.ai/cli/droid-exec/overview#stream-json--debug
	 */
	private parseStreamJsonOutput(output: string): ExecutionResult {
		const lines = output.trim().split("\n");
		const messages: string[] = [];
		const steps: ExecutionStep[] = [];
		let sessionId: string | undefined;
		let durationMs = 0;
		const isError = false;
		let model: string | undefined;

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const event = JSON.parse(line);
				const timestamp = event.timestamp
					? new Date(event.timestamp).toISOString()
					: new Date().toISOString();

				switch (event.type) {
					case "system":
						if (event.subtype === "init") {
							sessionId = event.session_id;
							model = event.model;
							steps.push({
								type: "thinking",
								content: `Session initialized with model: ${event.model || "unknown"}`,
								timestamp,
								metadata: {
									sessionId: event.session_id,
									model: event.model,
									tools: event.tools,
								},
							});
						}
						break;

					case "message":
						if (event.role === "assistant" && event.text) {
							messages.push(event.text);
							steps.push({
								type: "result",
								content: event.text,
								timestamp,
							});
						}
						break;

					case "tool_call":
						steps.push({
							type: "tool_use",
							content: `Tool call: ${event.toolName || event.toolId}`,
							timestamp,
							metadata: {
								callId: event.id,
								toolId: event.toolId,
								toolName: event.toolName,
								parameters: event.parameters,
							},
						});
						break;

					case "tool_result":
						steps.push({
							type: "tool_use",
							content: `Tool result: ${event.toolId}`,
							timestamp,
							metadata: {
								callId: event.id,
								toolId: event.toolId,
								isError: event.isError,
								value: event.value,
							},
						});
						break;

					case "completion":
						sessionId = event.session_id;
						durationMs = event.durationMs || 0;
						if (event.finalText) {
							messages.push(event.finalText);
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
				error: "Droid execution failed",
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
	 * Get environment variables for Droid execution.
	 */
	getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			CI: "true",
			NO_COLOR: "1",
		};

		// Pass through Factory API key if set
		if (process.env.FACTORY_API_KEY) {
			env.FACTORY_API_KEY = process.env.FACTORY_API_KEY;
		}

		return env;
	}
}

/**
 * Droid plugin configuration options.
 */
export interface DroidPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Factory API key */
	apiKey?: string;
	/** Default output format */
	outputFormat?: DroidOutputFormat;
	/** Default autonomy level */
	autonomyLevel?: DroidAutonomyLevel;
	/** Default model */
	model?: string;
}

/**
 * Create a Droid plugin with custom configuration.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const plugin = createDroidPlugin();
 *
 * // With custom options
 * const plugin = createDroidPlugin({
 *   timeout: 300000,
 *   outputFormat: DROID_OUTPUT_FORMATS.JSON,
 *   autonomyLevel: DROID_AUTONOMY_LEVELS.MEDIUM,
 *   model: "claude-sonnet-4-5-20250929",
 *   apiKey: process.env.MY_FACTORY_KEY
 * });
 * ```
 */
export function createDroidPlugin(options: DroidPluginOptions = {}): DroidPlugin {
	const plugin = new DroidPlugin();

	if (options.timeout) {
		(plugin.config as { timeout: number }).timeout = options.timeout;
	}

	if (options.maxConcurrent) {
		(plugin.config as { maxConcurrent: number }).maxConcurrent = options.maxConcurrent;
	}

	if (options.extraArgs) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...options.extraArgs];
	}

	// Handle API key and custom env
	const originalGetEnv = plugin.getEnv.bind(plugin);
	plugin.getEnv = () => {
		const env = originalGetEnv();
		if (options.apiKey) {
			env.FACTORY_API_KEY = options.apiKey;
		}
		if (options.env) {
			Object.assign(env, options.env);
		}
		return env;
	};

	return plugin;
}

/**
 * Helper to create a Droid request with proper typing.
 *
 * @example
 * ```typescript
 * const request = createDroidRequest({
 *   prompt: "analyze code quality",
 *   autoApprove: true,
 *   mode: DROID_AUTONOMY_LEVELS.MEDIUM,
 *   modelOverride: "claude-sonnet-4-5-20250929"
 * });
 * ```
 */
export function createDroidRequest(
	options: Partial<Omit<ExecutionRequest, "prompt">> & { prompt: string },
): ExecutionRequest {
	return {
		workDir: options.workDir || process.cwd(),
		timeout: options.timeout || 4000000,
		maxRetries: options.maxRetries || 3,
		streamOutput: options.streamOutput ?? true,
		outputFormat: options.outputFormat || DROID_OUTPUT_FORMATS.STREAM_JSON,
		...options,
	} as ExecutionRequest;
}
