import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Opencode CLI plugin for the open-source coding assistant.
 * Uses the `opencode` CLI tool with the `run` command for non-interactive mode.
 *
 * Supports OpenCode CLI features:
 * - Model selection (provider/model format)
 * - Session management (continue, session ID)
 * - Agent selection
 * - JSON output format
 * - File attachments
 *
 * @see https://opencode.ai/docs/cli/
 */
export class OpencodePlugin implements IEnginePlugin {
	readonly name = "opencode";

	readonly config: EngineConfig = {
		name: "opencode",
		command: "opencode",
		args: ["run"],
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 60,
			maxPerHour: 1000,
			minTime: 100,
		},
	};

	/**
	 * Check if the Opencode CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["which", "opencode"], {
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
	 * Build command line arguments for Opencode execution.
	 *
	 * Uses the `opencode run` command for non-interactive mode.
	 * Supports model selection, session management, and JSON output.
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args = [...this.config.args];

		// Model override (format: provider/model)
		if (request.modelOverride) {
			args.push("--model", request.modelOverride);
		}

		// Session management
		if (request.continueSession) {
			args.push("--continue");
		}

		if (request.sessionId) {
			args.push("--session", request.sessionId);
		}

		if (request.resumeSession) {
			args.push("--session", request.resumeSession);
		}

		// Agent selection (if using custom agents)
		if (request.agents && Object.keys(request.agents).length > 0) {
			// OpenCode uses --agent flag for single agent selection
			const agentName = Object.keys(request.agents)[0];
			args.push("--agent", agentName);
		}

		// JSON output format for structured responses
		// Note: OpenCode supports --format json for raw JSON events
		if (request.jsonSchema) {
			args.push("--format", "json");
		}

		// Add the prompt as the message
		args.push(request.prompt);

		return args;
	}

	/**
	 * Parse Opencode's text output format.
	 */
	parseOutput(output: string): ExecutionResult {
		return parseTextOutput(output);
	}

	/**
	 * Get environment variables for Opencode execution.
	 */
	getEnv(): Record<string, string> {
		return {
			CI: "true",
			NO_COLOR: "1",
		};
	}

	/**
	 * Indicates whether this plugin uses stdin for prompt input.
	 * OpenCode uses the prompt as a command line argument.
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}
}

/**
 * Opencode plugin configuration options.
 */
export interface OpencodePluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** Default model to use (provider/model format) */
	defaultModel?: string;
	/** Default agent to use */
	defaultAgent?: string;
	/** Enable JSON output format */
	jsonFormat?: boolean;
}

/**
 * Create an Opencode plugin with custom configuration.
 */
export function createOpencodePlugin(options: OpencodePluginOptions = {}): OpencodePlugin {
	const plugin = new OpencodePlugin();

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

	// Add default agent if specified
	if (options.defaultAgent) {
		extraArgs.push("--agent", options.defaultAgent);
	}

	// Enable JSON format by default if specified
	if (options.jsonFormat) {
		extraArgs.push("--format", "json");
	}

	// Merge extra args
	if (options.extraArgs) {
		extraArgs.push(...options.extraArgs);
	}

	if (extraArgs.length > 0) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...extraArgs];
	}

	if (options.env) {
		const originalGetEnv = plugin.getEnv.bind(plugin);
		plugin.getEnv = () => ({
			...originalGetEnv(),
			...options.env,
		});
	}

	return plugin;
}
