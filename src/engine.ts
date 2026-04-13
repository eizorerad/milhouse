/**
 * Engine — spawn AI CLI tool, parse output. No middleware. No adapters.
 *
 * One function: execute(prompt, workDir, config, opts)
 */

import type { Config, EngineResult, ExecuteResult } from "./types.ts";

// Inline debug log to avoid circular dependency
const debugLog = (msg: string) => {
	if (process.env.VERBOSE === "1") console.log(`… ${msg}`);
};

/** Max prompt length for CLI arg (avoid OS limits on Windows) */
const MAX_ARG_PROMPT = 12_000;

interface ExecuteOpts {
	model?: string;
	jsonSchema?: Record<string, unknown>;
	maxTurns?: number;
	/** Timeout in milliseconds. Default: 10 minutes. */
	timeout?: number;
}

interface EngineSpec {
	command: string;
	buildArgs(prompt: string, opts?: ExecuteOpts): string[];
	parseOutput(raw: string): EngineResult;
	usesStdin(prompt: string): boolean;
}

/**
 * Parse Claude stream-json format to extract response and tokens.
 *
 * When --json-schema is used, Claude puts the validated JSON in the
 * `structured_output` field of the result message. The `result` field
 * contains narrative text. We prefer structured_output.
 */
function parseClaudeStreamJson(raw: string): EngineResult {
	let response = "";
	let structuredOutput = "";
	let inputTokens = 0;
	let outputTokens = 0;

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const obj = JSON.parse(trimmed);

			// Collect text from assistant messages
			if (obj.type === "assistant" && obj.message?.content) {
				for (const block of obj.message.content) {
					if (block.type === "text") response += block.text;
				}
			}

			// Collect text from content_block_delta
			if (obj.type === "content_block_delta" && obj.delta?.text) {
				response += obj.delta.text;
			}

			// Result message
			if (obj.type === "result") {
				// Prefer structured_output (from --json-schema)
				if (obj.structured_output !== undefined && obj.structured_output !== null) {
					structuredOutput =
						typeof obj.structured_output === "string"
							? obj.structured_output
							: JSON.stringify(obj.structured_output);
				}

				// Also capture result text as fallback
				if (obj.result) {
					response = typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result);
				}
			}

			// Token usage
			if (obj.type === "result" && obj.usage) {
				inputTokens = obj.usage.input_tokens ?? 0;
				outputTokens = obj.usage.output_tokens ?? 0;
			}
			if (obj.usage) {
				inputTokens = Math.max(inputTokens, obj.usage.input_tokens ?? 0);
				outputTokens = Math.max(outputTokens, obj.usage.output_tokens ?? 0);
			}
		} catch {
			// Not JSON, might be plain text output
			if (!response && trimmed.length > 0) {
				response += `${trimmed}\n`;
			}
		}
	}

	// Prefer structured output (from --json-schema) over narrative text
	const finalResponse = structuredOutput || response;

	return { response: finalResponse.trim(), inputTokens, outputTokens };
}

/**
 * Parse Gemini CLI output for token usage metadata.
 * Gemini CLI may output lines like: prompt_token_count: 123, candidates_token_count: 456
 * Falls back to character-based estimation (chars/4) if not found.
 */
export function parseGeminiOutput(raw: string): EngineResult {
	const response = raw.trim();
	let inputTokens = 0;
	let outputTokens = 0;
	let foundUsage = false;

	for (const line of raw.split("\n")) {
		const promptMatch = line.match(/prompt_token_count\s*[:=]\s*(\d+)/);
		if (promptMatch) {
			inputTokens = Number.parseInt(promptMatch[1], 10);
			foundUsage = true;
		}
		const candidatesMatch = line.match(/candidates_token_count\s*[:=]\s*(\d+)/);
		if (candidatesMatch) {
			outputTokens = Number.parseInt(candidatesMatch[1], 10);
			foundUsage = true;
		}
	}

	if (!foundUsage && response.length > 0) {
		outputTokens = Math.ceil(response.length / 4);
		debugLog("[engine] Gemini token usage not found in output, using character-based estimation");
	}

	return { response, inputTokens, outputTokens };
}

/**
 * Estimate token usage from Aider text output.
 * Aider does not report tokens — uses character-length heuristic.
 */
export function parseAiderOutput(raw: string): EngineResult {
	const response = raw.trim();
	const outputTokens = response.length > 0 ? Math.ceil(response.length / 4) : 0;
	debugLog("[engine] Aider token counts are estimated from response length");
	return { response, inputTokens: 0, outputTokens };
}

const engines: Record<string, EngineSpec> = {
	claude: {
		command: "claude",
		usesStdin: (prompt) => prompt.length > MAX_ARG_PROMPT,
		buildArgs(prompt, opts) {
			const args = [
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
			];
			if (opts?.model) args.push("--model", opts.model);
			if (opts?.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
			if (opts?.maxTurns) args.push("--max-turns", String(opts.maxTurns));

			if (prompt.length <= MAX_ARG_PROMPT) {
				args.push("-p", prompt);
			} else {
				args.push(
					"-p",
					"Process the instructions provided via standard input exactly as described.",
				);
			}
			return args;
		},
		parseOutput: parseClaudeStreamJson,
	},

	gemini: {
		command: "gemini",
		usesStdin: () => false,
		buildArgs(prompt, opts) {
			const args: string[] = [];
			if (opts?.model) args.push("--model", opts.model);
			args.push(prompt);
			return args;
		},
		parseOutput: parseGeminiOutput,
	},

	aider: {
		command: "aider",
		usesStdin: () => false,
		buildArgs(prompt, opts) {
			const args = ["--message", prompt, "--yes-always", "--no-git"];
			if (opts?.model) args.push("--model", opts.model);
			return args;
		},
		parseOutput: parseAiderOutput,
	},
};

/**
 * Execute a prompt against the configured AI engine.
 */
export async function execute(
	prompt: string,
	workDir: string,
	config: Config,
	opts?: ExecuteOpts,
): Promise<ExecuteResult> {
	const spec = engines[config.engine];
	if (!spec) {
		throw new Error(
			`Unknown engine: ${config.engine}. Available: ${Object.keys(engines).join(", ")}`,
		);
	}

	const model = opts?.model ?? config.model;
	const args = spec.buildArgs(prompt, { ...opts, model });
	const pipeStdin = spec.usesStdin(prompt);

	const timeout = opts?.timeout ?? 10 * 60 * 1000; // Default: 10 minutes

	debugLog(
		`[engine] ${spec.command} ${args.slice(0, 3).join(" ")}... (timeout: ${Math.round(timeout / 1000)}s)`,
	);

	const proc = Bun.spawn([spec.command, ...args], {
		cwd: workDir,
		env: { ...process.env, CI: "true", NO_COLOR: "1" },
		stdin: pipeStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Write prompt to stdin if needed
	if (pipeStdin && proc.stdin) {
		proc.stdin.write(prompt);
		proc.stdin.end();
	}

	// Race: output vs timeout
	let timerId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timerId = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
			reject(new Error(`Engine ${spec.command} timed out after ${Math.round(timeout / 1000)}s`));
		}, timeout);
	});

	const outputPromise = (async () => {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			debugLog(`[engine] full stderr:\n${stderr}`);
			throw new Error(`Engine ${spec.command} failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
		}

		return spec.parseOutput(stdout);
	})();

	const result = await Promise.race([outputPromise, timeoutPromise]).finally(() => {
		if (timerId !== undefined) clearTimeout(timerId);
	});

	return { result, proc };
}
