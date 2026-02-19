import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { AIEngine, AIResult, EngineOptions, ProgressCallback } from "./types.ts";

/**
 * Detailed step information from AI engine output
 */
export interface DetailedStep {
	/** Category of the action */
	category:
		| "reading"
		| "writing"
		| "testing"
		| "linting"
		| "command"
		| "committing"
		| "staging"
		| "thinking";
	/** Full detail (e.g., full file path or command) */
	detail?: string;
	/** Short detail for compact display (e.g., just filename) */
	shortDetail?: string;
	/** Whether this is a test file */
	isTestFile?: boolean;
}

/**
 * Format a DetailedStep for display in the terminal
 * @param step The detailed step to format
 * @param mode Display mode: "compact" shows short version, "full" shows detail
 */
export function formatStepForDisplay(
	step: DetailedStep,
	mode: "compact" | "full" = "compact",
): string {
	const categoryLabels: Record<DetailedStep["category"], string> = {
		reading: "Reading",
		writing: "Writing",
		testing: "Testing",
		linting: "Linting",
		command: "Running",
		committing: "Committing",
		staging: "Staging",
		thinking: "Thinking",
	};

	const label = categoryLabels[step.category];

	if (mode === "full" && step.detail) {
		return `${label} ${step.detail}`;
	}

	if (step.shortDetail) {
		return `${label} ${step.shortDetail}`;
	}

	return label;
}

/**
 * Get a short version of a file path (just the filename)
 */
function getShortPath(filePath: string): string {
	if (!filePath) return "";
	return basename(filePath);
}

/**
 * Get a short version of a command (first 30 chars)
 */
function getShortCommand(command: string): string {
	if (!command) return "";
	const short = command.slice(0, 30);
	return command.length > 30 ? `${short}...` : short;
}

// Check if running in Bun
const isBun = typeof Bun !== "undefined";
const isWindows = process.platform === "win32";

/**
 * Resolve a command to its full executable path (needed for Windows)
 */
function resolveCommand(command: string): string {
	if (!isWindows || isBun) return command;
	try {
		const result = spawnSync("where", [command], { encoding: "utf8", stdio: "pipe" });
		if (result.status !== 0) return command;
		const paths = result.stdout.trim().split(/\r?\n/);
		// Return first path (the one that would be executed)
		return paths[0] || command;
	} catch {
		return command;
	}
}

/**
 * Check if a command is available in PATH
 */
export async function commandExists(command: string): Promise<boolean> {
	try {
		const checkCommand = isWindows ? "where" : "which";
		if (isBun) {
			const proc = Bun.spawn([checkCommand, command], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		}
		// Node.js fallback - where/which don't need shell
		const result = spawnSync(checkCommand, [command], { stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Execute a command and return stdout
 */
export async function execCommand(
	command: string,
	args: string[],
	workDir: string,
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (isBun) {
		const proc = Bun.spawn([command, ...args], {
			cwd: workDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { stdout, stderr, exitCode };
	}

	// Node.js fallback - resolve full path on Windows to avoid shell
	const resolvedCommand = resolveCommand(command);
	return new Promise((resolve) => {
		const proc = spawn(resolvedCommand, args, {
			cwd: workDir,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"], // Close stdin, pipe stdout/stderr
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
		});

		proc.on("error", () => {
			resolve({ stdout, stderr, exitCode: 1 });
		});
	});
}

/**
 * Parse token counts from stream-json output (Claude/Qwen format)
 */
export function parseStreamJsonResult(output: string): {
	response: string;
	inputTokens: number;
	outputTokens: number;
} {
	const lines = output.split("\n").filter(Boolean);
	let response = "";
	let inputTokens = 0;
	let outputTokens = 0;

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "result") {
				response = parsed.result || "Task completed";
				inputTokens = parsed.usage?.input_tokens || 0;
				outputTokens = parsed.usage?.output_tokens || 0;
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return { response: response || "Task completed", inputTokens, outputTokens };
}

/**
 * Check for errors in stream-json output
 */
export function checkForErrors(output: string): string | null {
	const lines = output.split("\n").filter(Boolean);

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "error") {
				return parsed.error?.message || parsed.message || "Unknown error";
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return null;
}

/**
 * Read a stream line by line, calling onLine for each non-empty line
 */
async function readStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line);
			}
		}
		if (buffer.trim()) onLine(buffer);
	} finally {
		reader.releaseLock();
	}
}

/**
 * Execute a command with streaming output, calling onLine for each line
 */
export async function execCommandStreaming(
	command: string,
	args: string[],
	workDir: string,
	onLine: (line: string) => void,
	env?: Record<string, string>,
): Promise<{ exitCode: number }> {
	if (isBun) {
		const proc = Bun.spawn([command, ...args], {
			cwd: workDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		// Process both stdout and stderr in parallel
		await Promise.all([readStream(proc.stdout, onLine), readStream(proc.stderr, onLine)]);

		const exitCode = await proc.exited;
		return { exitCode };
	}

	// Node.js fallback - resolve full path on Windows to avoid shell
	const resolvedCommand = resolveCommand(command);
	return new Promise((resolve) => {
		const proc = spawn(resolvedCommand, args, {
			cwd: workDir,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"], // Close stdin, pipe stdout/stderr
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";

		const processBuffer = (buffer: string, isStderr = false) => {
			const lines = buffer.split("\n");
			const remaining = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line);
			}
			return remaining;
		};

		proc.stdout?.on("data", (data) => {
			stdoutBuffer += data.toString();
			stdoutBuffer = processBuffer(stdoutBuffer);
		});

		proc.stderr?.on("data", (data) => {
			stderrBuffer += data.toString();
			stderrBuffer = processBuffer(stderrBuffer, true);
		});

		proc.on("close", (exitCode) => {
			// Process any remaining data
			if (stdoutBuffer.trim()) onLine(stdoutBuffer);
			if (stderrBuffer.trim()) onLine(stderrBuffer);
			resolve({ exitCode: exitCode ?? 1 });
		});

		proc.on("error", () => {
			resolve({ exitCode: 1 });
		});
	});
}

/**
 * Base implementation for AI engines
 */
export abstract class BaseAIEngine implements AIEngine {
	abstract name: string;
	abstract cliCommand: string;

	async isAvailable(): Promise<boolean> {
		return commandExists(this.cliCommand);
	}

	abstract execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult>;

	/**
	 * Execute with streaming progress updates (optional implementation)
	 */
	executeStreaming?(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult>;
}
