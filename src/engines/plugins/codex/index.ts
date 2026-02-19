import type {
	EngineConfig,
	ExecutionRequest,
	ExecutionResult,
} from "../../../schemas/engine.schema";
import { parseTextOutput } from "../../core/parsers/text";
import type { IEnginePlugin } from "../../core/types";

/**
 * Codex CLI plugin for the OpenAI Codex coding assistant.
 * Uses the `codex exec` command for non-interactive mode.
 *
 * Supports Codex CLI features:
 * - Model selection
 * - JSON output format (JSONL events)
 * - Output schema validation
 * - Sandbox policies
 * - Session management
 * - Additional directories
 * - Full auto mode
 *
 * @see https://developers.openai.com/codex/cli/reference/
 */
export class CodexPlugin implements IEnginePlugin {
	readonly name = "codex";

	readonly config: EngineConfig = {
		name: "codex",
		command: "codex",
		args: ["exec"],
		timeout: 4000000, // ~66 minutes
		maxConcurrent: 5,
		rateLimit: {
			maxPerMinute: 30,
			maxPerHour: 500,
			minTime: 200,
		},
	};

	/**
	 * Check if the Codex CLI is available on the system.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Use 'where' on Windows, 'which' on Unix
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";
			const proc = Bun.spawn([checkCommand, "codex"], {
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
	 * Build command line arguments for Codex execution.
	 *
	 * Uses the `codex exec` command for non-interactive mode.
	 * Supports model selection, JSON output, sandbox policies, and more.
	 */
	buildArgs(request: ExecutionRequest): string[] {
		const args = [...this.config.args];

		// Model override
		if (request.modelOverride) {
			args.push("--model", request.modelOverride);
		}

		// Working directory
		if (request.workDir) {
			args.push("--cd", request.workDir);
		}

		// JSON output format for structured responses (JSONL events)
		if (request.jsonSchema) {
			args.push("--json");
		}

		// Additional directories
		if (request.additionalDirs && request.additionalDirs.length > 0) {
			for (const dir of request.additionalDirs) {
				args.push("--add-dir", dir);
			}
		}

		// Sandbox policy based on tool restrictions
		if (request.disallowedTools && request.disallowedTools.length > 0) {
			// If tools are restricted, use read-only sandbox
			args.push("--sandbox", "read-only");
		} else if (request.allowedTools && request.allowedTools.length > 0) {
			// If specific tools are allowed, use workspace-write
			args.push("--sandbox", "workspace-write");
		}

		// Session management
		if (request.continueSession) {
			args.push("--last");
		}

		if (request.resumeSession) {
			// Use resume subcommand for session continuation
			args.splice(1, 0, "resume");
			args.push(request.resumeSession);
		}

		// Add the prompt
		args.push(request.prompt);

		return args;
	}

	/**
	 * Parse Codex's text output format.
	 */
	parseOutput(output: string): ExecutionResult {
		return parseTextOutput(output);
	}

	/**
	 * Get environment variables for Codex execution.
	 */
	getEnv(): Record<string, string> {
		return {
			CI: "true",
			NO_COLOR: "1",
		};
	}

	/**
	 * Indicates whether this plugin uses stdin for prompt input.
	 * Codex uses the prompt as a command line argument.
	 */
	usesStdinForPrompt(): boolean {
		return false;
	}
}

/**
 * Codex sandbox policy options.
 */
export type CodexSandboxPolicy = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Codex plugin configuration options.
 */
export interface CodexPluginOptions {
	/** Custom timeout in ms */
	timeout?: number;
	/** Maximum concurrent executions */
	maxConcurrent?: number;
	/** Additional CLI arguments */
	extraArgs?: string[];
	/** Custom environment variables */
	env?: Record<string, string>;
	/** OpenAI API key */
	apiKey?: string;
	/** Default model to use */
	defaultModel?: string;
	/** Default sandbox policy */
	defaultSandbox?: CodexSandboxPolicy;
	/** Enable full auto mode (workspace-write sandbox + on-request approvals) */
	fullAuto?: boolean;
	/** Enable JSON output format */
	jsonOutput?: boolean;
	/** Configuration profile name */
	profile?: string;
}

/**
 * Create a Codex plugin with custom configuration.
 */
export function createCodexPlugin(options: CodexPluginOptions = {}): CodexPlugin {
	const plugin = new CodexPlugin();

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

	// Add default sandbox policy
	if (options.defaultSandbox) {
		extraArgs.push("--sandbox", options.defaultSandbox);
	}

	// Enable full auto mode
	if (options.fullAuto) {
		extraArgs.push("--full-auto");
	}

	// Enable JSON output
	if (options.jsonOutput) {
		extraArgs.push("--json");
	}

	// Configuration profile
	if (options.profile) {
		extraArgs.push("--profile", options.profile);
	}

	// Merge extra args
	if (options.extraArgs) {
		extraArgs.push(...options.extraArgs);
	}

	if (extraArgs.length > 0) {
		(plugin.config as { args: string[] }).args = [...plugin.config.args, ...extraArgs];
	}

	// Handle API key and custom env
	const originalGetEnv = plugin.getEnv.bind(plugin);
	plugin.getEnv = () => {
		const env = originalGetEnv();
		if (options.apiKey) {
			env.OPENAI_API_KEY = options.apiKey;
		}
		if (options.env) {
			Object.assign(env, options.env);
		}
		return env;
	};

	return plugin;
}

/**
 * Codex sandbox policy constants.
 */
export const CODEX_SANDBOX = {
	/** Read-only access - safest option */
	READ_ONLY: "read-only" as CodexSandboxPolicy,
	/** Write access to workspace only */
	WORKSPACE_WRITE: "workspace-write" as CodexSandboxPolicy,
	/** Full access - dangerous, use only in isolated environments */
	FULL_ACCESS: "danger-full-access" as CodexSandboxPolicy,
};
