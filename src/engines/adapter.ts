/**
 * AIEngine Adapter - wraps IEnginePlugin to provide legacy AIEngine interface
 *
 * This adapter bridges the gap between the new plugin-based engine system
 * and the legacy AIEngine interface expected by CLI commands and execution flows.
 *
 * Enhanced with Milhouse-specific context support for:
 * - Run tracking via runId
 * - Agent role identification
 * - Pipeline phase tracking
 * - Evidence collection
 */

import type {
	AgentRole,
	ExecutionResult,
	ExecutionStep,
	PipelinePhase,
} from "../schemas/engine.schema.ts";
import { logDebug, logWarn } from "../ui/logger.ts";
import type { DetailedStep } from "./base.ts";
import { type EngineExecutor, createDefaultExecutor } from "./core/executor.ts";
import { extractFinalResult } from "./core/parsers/stream-json.ts";
import type { IEnginePlugin } from "./core/types.ts";
import { extractRoleFromPrompt, validatePrompt } from "./prompt-validation.ts";
import type { AIEngine, AIResult, EngineOptions, ProgressCallback } from "./types.ts";

/**
 * Translate ExecutionStep (plugin system) to DetailedStep (legacy UI)
 *
 * ExecutionStep has: type ('thinking' | 'tool_use' | 'result' | 'error'), content, timestamp, metadata
 * DetailedStep has: category ('reading' | 'writing' | 'testing' | etc.), detail, shortDetail, isTestFile
 */
export function translateStepToDetailedStep(step: ExecutionStep): DetailedStep {
	// Map ExecutionStep type to DetailedStep category
	switch (step.type) {
		case "thinking":
			return {
				category: "thinking",
				detail: step.content,
				shortDetail: step.content.slice(0, 50),
			};

		case "tool_use": {
			// Try to extract tool information from metadata or content
			const metadata = step.metadata || {};
			const toolName = (metadata.tool as string)?.toLowerCase() || "";
			const filePath = (metadata.file_path as string) || (metadata.path as string) || "";
			const command = (metadata.command as string) || "";

			// Determine category based on tool name
			if (toolName === "read" || toolName === "glob" || toolName === "grep") {
				return {
					category: "reading",
					detail: filePath || step.content,
					shortDetail: filePath ? getShortPath(filePath) : step.content.slice(0, 30),
					isTestFile: isTestFile(filePath),
				};
			}

			if (toolName === "write" || toolName === "edit") {
				const testFile = isTestFile(filePath);
				return {
					category: "writing",
					detail: filePath || step.content,
					shortDetail: filePath ? getShortPath(filePath) : step.content.slice(0, 30),
					isTestFile: testFile,
				};
			}

			// Check for git operations
			if (command.includes("git commit")) {
				return {
					category: "committing",
					detail: command,
					shortDetail: command.slice(0, 30),
				};
			}

			if (command.includes("git add")) {
				return {
					category: "staging",
					detail: command,
					shortDetail: command.slice(0, 30),
				};
			}

			// Check for linting
			if (
				command.includes("lint") ||
				command.includes("eslint") ||
				command.includes("biome") ||
				command.includes("prettier")
			) {
				return {
					category: "linting",
					detail: command,
					shortDetail: command.slice(0, 30),
				};
			}

			// Check for testing
			if (
				command.includes("vitest") ||
				command.includes("jest") ||
				command.includes("bun test") ||
				command.includes("npm test") ||
				command.includes("pytest") ||
				command.includes("go test")
			) {
				return {
					category: "testing",
					detail: command,
					shortDetail: command.slice(0, 30),
				};
			}

			// Default to command category for tool_use
			return {
				category: "command",
				detail: step.content,
				shortDetail: step.content.slice(0, 30),
			};
		}

		case "result":
			return {
				category: "thinking",
				detail: step.content,
				shortDetail: "Completed",
			};

		case "error":
			return {
				category: "command",
				detail: step.content,
				shortDetail: "Error",
			};

		default:
			return {
				category: "thinking",
				detail: step.content,
				shortDetail: step.content.slice(0, 30),
			};
	}
}

/**
 * Context metadata to include in AIResult.
 */
export interface ResultContextMetadata {
	runId?: string;
	agentRole?: AgentRole;
	pipelinePhase?: PipelinePhase;
	evidence?: Record<string, unknown>;
}

/**
 * Translate ExecutionResult (plugin system) to AIResult (legacy)
 *
 * The response field should contain the final text response from the AI,
 * not the raw stream-json output. We extract this from the steps.
 *
 * When context metadata is provided, it is included in the result for
 * Milhouse pipeline tracking and evidence collection.
 *
 * @param result - The execution result from the plugin system
 * @param contextMetadata - Optional Milhouse context metadata to include
 * @returns AIResult with optional context fields
 */
export function translateResultToAIResult(
	result: ExecutionResult,
	contextMetadata?: ResultContextMetadata,
): AIResult {
	// Extract the final text response from steps
	// The raw output contains stream-json format, but we need the actual text response
	const finalResponse = extractFinalResult(result.steps) || result.output;

	return {
		success: result.success,
		response: finalResponse,
		// Use actual token values when available, fallback to 0 when not
		inputTokens: result.tokens?.input ?? 0,
		outputTokens: result.tokens?.output ?? 0,
		// Use duration as cost indicator (in ms)
		cost: `${result.duration}ms`,
		error: result.error,
		// Include Milhouse context metadata when available
		runId: contextMetadata?.runId,
		agentRole: contextMetadata?.agentRole,
		pipelinePhase: contextMetadata?.pipelinePhase,
		evidence: contextMetadata?.evidence,
	};
}

/**
 * Get a short version of a file path (just the filename)
 */
function getShortPath(filePath: string): string {
	if (!filePath) return "";
	const parts = filePath.split("/");
	return parts[parts.length - 1] || filePath;
}

/**
 * Check if a file path looks like a test file
 */
function isTestFile(filePath: string): boolean {
	if (!filePath) return false;
	const lower = filePath.toLowerCase();
	return (
		lower.includes(".test.") ||
		lower.includes(".spec.") ||
		lower.includes("__tests__") ||
		lower.includes("_test.go")
	);
}

/**
 * AIEngine adapter that wraps an IEnginePlugin
 *
 * This class implements the legacy AIEngine interface while internally
 * using the new plugin-based system with EngineExecutor.
 */
export class PluginAdapter implements AIEngine {
	/** Display name of the engine */
	readonly name: string;

	/** CLI command to invoke (derived from plugin config) */
	readonly cliCommand: string;

	/** The wrapped plugin */
	private readonly plugin: IEnginePlugin;

	/** The executor instance */
	private readonly executor: EngineExecutor;

	constructor(plugin: IEnginePlugin, executor?: EngineExecutor) {
		this.plugin = plugin;
		this.name = plugin.name;
		this.cliCommand = plugin.config.command;
		this.executor = executor || createDefaultExecutor();
	}

	/**
	 * Check if the engine CLI is available
	 */
	async isAvailable(): Promise<boolean> {
		return this.plugin.isAvailable();
	}

	/**
	 * Execute a prompt and return the result
	 *
	 * Translates between legacy EngineOptions and ExecutionRequest,
	 * and between ExecutionResult and AIResult.
	 *
	 * When Milhouse context fields (runId, agentRole, pipelinePhase) are provided
	 * in options, they are passed through to the execution request and included
	 * in the result for pipeline tracking.
	 */
	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		// Validate prompt before execution
		const expectedRole = extractRoleFromPrompt(prompt);
		const validation = validatePrompt(prompt, { expectedRole: expectedRole ?? undefined });

		if (!validation.valid) {
			logWarn(`Prompt validation failed: ${validation.errors.join("; ")}`);
		}

		if (validation.warnings.length > 0) {
			for (const warning of validation.warnings) {
				logDebug(`Prompt warning: ${warning}`);
			}
		}

		// Build ExecutionRequest from legacy parameters with Milhouse context
		const request = {
			prompt,
			workDir,
			// Pass modelOverride directly to ExecutionRequest (now supported in schema)
			modelOverride: options?.modelOverride,
			// Pass Milhouse-specific context fields
			runId: options?.runId,
			agentRole: options?.agentRole,
			pipelinePhase: options?.pipelinePhase,
		};

		// Execute using the plugin system
		const result = await this.executor.execute(this.plugin, request);

		// Build context metadata for result
		const contextMetadata: ResultContextMetadata = {
			runId: options?.runId,
			agentRole: options?.agentRole,
			pipelinePhase: options?.pipelinePhase,
		};

		// Translate result to legacy format with context
		return translateResultToAIResult(result, contextMetadata);
	}

	/**
	 * Execute with streaming progress updates
	 *
	 * This implementation uses the executor's streaming API to receive
	 * execution steps in real-time and translates them to DetailedStep
	 * for the progress callback.
	 *
	 * When Milhouse context fields (runId, agentRole, pipelinePhase) are provided
	 * in options, they are passed through to the execution request and included
	 * in the result for pipeline tracking.
	 */
	async executeStreaming(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult> {
		// Validate prompt before execution
		const expectedRole = extractRoleFromPrompt(prompt);
		const validation = validatePrompt(prompt, { expectedRole: expectedRole ?? undefined });

		if (!validation.valid) {
			logWarn(`Prompt validation failed: ${validation.errors.join("; ")}`);
		}

		if (validation.warnings.length > 0) {
			for (const warning of validation.warnings) {
				logDebug(`Prompt warning: ${warning}`);
			}
		}

		// Build ExecutionRequest from legacy parameters with Milhouse context
		const request = {
			prompt,
			workDir,
			streamOutput: true,
			// Pass modelOverride directly to ExecutionRequest (now supported in schema)
			modelOverride: options?.modelOverride,
			// Pass Milhouse-specific context fields
			runId: options?.runId,
			agentRole: options?.agentRole,
			pipelinePhase: options?.pipelinePhase,
		};

		// Create step callback that translates ExecutionStep to DetailedStep
		const onStep = (step: ExecutionStep) => {
			const detailedStep = translateStepToDetailedStep(step);
			onProgress(detailedStep);
		};

		// Execute using the executor's streaming API for real-time progress
		const result = await this.executor.executeStreaming(this.plugin, request, onStep);

		// Build context metadata for result
		const contextMetadata: ResultContextMetadata = {
			runId: options?.runId,
			agentRole: options?.agentRole,
			pipelinePhase: options?.pipelinePhase,
		};

		// Translate result to legacy format with context
		return translateResultToAIResult(result, contextMetadata);
	}
}

/**
 * Create an AIEngine adapter from a plugin name
 *
 * @param engineName - Name of the engine plugin to wrap
 * @returns AIEngine adapter instance
 * @throws Error if the plugin module cannot be loaded or the engine is not found
 */
export async function createEngineAdapter(engineName: string): Promise<AIEngine> {
	try {
		const pluginModule = await import("./plugins/types.ts");

		if (!pluginModule || typeof pluginModule.getPlugin !== "function") {
			throw new Error("Plugin module is invalid or getPlugin is not a function");
		}

		const plugin = pluginModule.getPlugin(engineName);

		if (!plugin) {
			throw new Error(`Engine plugin '${engineName}' not found`);
		}

		return new PluginAdapter(plugin);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to create engine adapter for '${engineName}': ${message}. ` +
				`Ensure the engine is installed and available in your PATH.`,
		);
	}
}

/**
 * Create an AIEngine adapter from an existing plugin instance
 *
 * @param plugin - The plugin instance to wrap
 * @param executor - Optional custom executor (defaults to createDefaultExecutor())
 * @returns AIEngine adapter instance
 */
export function createAdapterFromPlugin(
	plugin: IEnginePlugin,
	executor?: EngineExecutor,
): AIEngine {
	return new PluginAdapter(plugin, executor);
}
