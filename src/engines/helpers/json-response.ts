/**
 * JSON Response Helper - Execute with automatic parse retry
 *
 * Wraps engine execution with automatic retry when JSON parsing fails.
 * This addresses the issue where the engine execution succeeds but the
 * response format is invalid.
 *
 * The retry middleware only handles execution errors, not response format errors.
 * This helper fills that gap.
 */

import { extractJsonWithMetadata } from "../../utils/json-extractor.ts";
import type { AIEngine, AIResult, EngineOptions } from "../types.ts";

/**
 * Options for executeWithJSONParsing
 */
export interface ExecuteWithJSONOptions<T> {
	/** The AI engine to use for execution */
	engine: AIEngine;

	/** The prompt to send */
	prompt: string;

	/** Working directory for execution */
	workDir: string;

	/** Function to parse and validate the extracted JSON */
	parseResponse: (jsonStr: string) => T | null;

	/** Maximum number of retries on parse failure (default: 2) */
	maxParseRetries?: number;

	/** Engine options like model override */
	executionOptions?: EngineOptions;

	/** Custom suffix to add on retry (default: standard JSON instruction) */
	enhancedPromptSuffix?: string;

	/** Whether to use streaming execution if available */
	useStreaming?: boolean;

	/** Progress callback for streaming execution */
	onProgress?: (step: string | object) => void;
}

/**
 * Result of executeWithJSONParsing
 */
export interface ExecuteWithJSONResult<T> {
	/** Whether parsing succeeded */
	success: boolean;

	/** The parsed result (if success) */
	result?: T;

	/** The raw AI response (for debugging) */
	rawResponse?: string;

	/** The extracted JSON string (for debugging) */
	extractedJson?: string;

	/** Number of retries performed */
	retryCount: number;

	/** Token usage from all attempts */
	totalInputTokens: number;
	totalOutputTokens: number;

	/** Error message if failed */
	error?: string;

	/** Which extraction strategy succeeded */
	extractionStrategy?: string;
}

/**
 * Default prompt suffix for JSON retry
 */
const DEFAULT_JSON_RETRY_SUFFIX = `

⚠️ IMPORTANT: Your previous response could not be parsed as valid JSON.
You MUST respond with ONLY a valid JSON object or array.
Do NOT include any explanation text before or after the JSON.
Do NOT use markdown code blocks - just output raw JSON.`;

/**
 * Execute an AI prompt and parse the response as JSON with automatic retry
 *
 * On parse failure, retries with an enhanced prompt instructing JSON-only output.
 * Tracks all token usage across attempts.
 *
 * @param options - Execution options
 * @returns Result with parsed data or error
 */
export async function executeWithJSONParsing<T>(
	options: ExecuteWithJSONOptions<T>,
): Promise<ExecuteWithJSONResult<T>> {
	const {
		engine,
		prompt,
		workDir,
		parseResponse,
		maxParseRetries = 2,
		executionOptions,
		enhancedPromptSuffix = DEFAULT_JSON_RETRY_SUFFIX,
		useStreaming = false,
		onProgress,
	} = options;

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let retryCount = 0;
	let lastRawResponse: string | undefined;
	let lastExtractedJson: string | undefined;
	let lastError: string | undefined;
	let lastStrategy: string | undefined;

	// Try up to maxParseRetries + 1 times (initial + retries)
	for (let attempt = 0; attempt <= maxParseRetries; attempt++) {
		// Build prompt - add retry suffix on subsequent attempts
		const currentPrompt = attempt === 0 ? prompt : prompt + enhancedPromptSuffix;

		// Execute the prompt
		let result: AIResult;
		try {
			if (useStreaming && engine.executeStreaming && onProgress) {
				result = await engine.executeStreaming(
					currentPrompt,
					workDir,
					onProgress,
					executionOptions,
				);
			} else {
				result = await engine.execute(currentPrompt, workDir, executionOptions);
			}
		} catch (error) {
			// Execution error - don't retry, return error
			const errorMsg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				retryCount,
				totalInputTokens,
				totalOutputTokens,
				error: `Execution failed: ${errorMsg}`,
			};
		}

		// Track tokens
		totalInputTokens += result.inputTokens;
		totalOutputTokens += result.outputTokens;

		// Check if execution itself failed
		if (!result.success) {
			return {
				success: false,
				rawResponse: result.response,
				retryCount,
				totalInputTokens,
				totalOutputTokens,
				error: result.error || "Execution failed with unknown error",
			};
		}

		lastRawResponse = result.response;

		// Try to extract JSON
		const extraction = extractJsonWithMetadata<unknown>(result.response);

		if (!extraction.success || !extraction.rawJson) {
			lastError = extraction.error || "Failed to extract JSON from response";
			retryCount = attempt;
			continue; // Try again with enhanced prompt
		}

		lastExtractedJson = extraction.rawJson;
		lastStrategy = extraction.strategy || undefined;

		// Try to parse with the provided parser
		try {
			const parsed = parseResponse(extraction.rawJson);
			if (parsed !== null) {
				return {
					success: true,
					result: parsed,
					rawResponse: result.response,
					extractedJson: extraction.rawJson,
					retryCount: attempt,
					totalInputTokens,
					totalOutputTokens,
					extractionStrategy: extraction.strategy || undefined,
				};
			}
			// Parser returned null - response didn't match expected schema
			lastError = "Response JSON does not match expected schema";
		} catch (parseError) {
			lastError =
				parseError instanceof Error ? parseError.message : "Parse function threw an error";
		}

		retryCount = attempt;
	}

	// All attempts failed
	return {
		success: false,
		rawResponse: lastRawResponse,
		extractedJson: lastExtractedJson,
		retryCount,
		totalInputTokens,
		totalOutputTokens,
		error: lastError || "Failed to parse JSON after all retry attempts",
		extractionStrategy: lastStrategy,
	};
}

/**
 * Simpler version for when you just want to extract and parse JSON
 * without custom validation (uses extractJsonFromResponse directly)
 */
export async function executeAndExtractJson<T>(
	engine: AIEngine,
	prompt: string,
	workDir: string,
	options?: EngineOptions & { maxRetries?: number },
): Promise<ExecuteWithJSONResult<T>> {
	return executeWithJSONParsing<T>({
		engine,
		prompt,
		workDir,
		parseResponse: (json) => {
			try {
				return JSON.parse(json) as T;
			} catch {
				return null;
			}
		},
		maxParseRetries: options?.maxRetries ?? 2,
		executionOptions: options,
	});
}

/**
 * Type guard to check if a result is successful
 */
export function isJsonResultSuccess<T>(
	result: ExecuteWithJSONResult<T>,
): result is ExecuteWithJSONResult<T> & { success: true; result: T } {
	return result.success && result.result !== undefined;
}
