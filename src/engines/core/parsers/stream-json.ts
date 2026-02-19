import type { ExecutionResult, ExecutionStep, TokenUsage } from "../../../schemas/engine.schema";

/**
 * Content block types from Claude's stream-json format.
 */
interface ContentBlock {
	type: "thinking" | "tool_use" | "text" | "tool_result";
	thinking?: string;
	text?: string;
	name?: string;
	id?: string;
	input?: unknown;
	content?: string;
}

/**
 * Usage information from stream-json format.
 */
interface UsageInfo {
	input_tokens?: number;
	output_tokens?: number;
}

/**
 * Message structure from stream-json format.
 */
interface StreamMessage {
	type: "assistant" | "user" | "result" | "system" | "error";
	message?: {
		content?: ContentBlock[];
		role?: string;
	};
	subtype?: string;
	result?: unknown;
	error?: string;
	usage?: UsageInfo;
}

/**
 * Parse stream-json format output from Claude and similar engines.
 * This format outputs one JSON object per line, with various message types.
 *
 * @param output - Raw output string containing newline-delimited JSON
 * @returns Parsed execution result with structured steps
 *
 * @example
 * ```typescript
 * const result = parseStreamJson(rawOutput);
 * console.log(result.steps); // Array of parsed steps
 * console.log(result.tokens); // { input: number, output: number } or undefined
 * ```
 */
export function parseStreamJson(output: string): ExecutionResult {
	const steps: ExecutionStep[] = [];
	const lines = output.split("\n");
	let hasError = false;
	let errorMessage: string | undefined;

	// Accumulate token usage from stream messages
	let inputTokens = 0;
	let outputTokens = 0;
	let hasTokens = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		try {
			const parsed = JSON.parse(trimmed) as StreamMessage;
			const parsedSteps = parseStreamMessage(parsed);
			steps.push(...parsedSteps);

			// Check for errors
			if (parsed.type === "error" || parsed.error) {
				hasError = true;
				errorMessage = parsed.error || "Unknown error";
			}

			// Extract token usage from result messages (following legacy parseStreamJsonResult pattern)
			if (parsed.type === "result" && parsed.usage) {
				inputTokens += parsed.usage.input_tokens || 0;
				outputTokens += parsed.usage.output_tokens || 0;
				hasTokens = true;
			}
		} catch {
			// Not valid JSON - treat as plain text output
			if (trimmed) {
				steps.push({
					type: "result",
					content: trimmed,
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	// Build token usage object only if we found token data
	const tokens: TokenUsage | undefined = hasTokens
		? { input: inputTokens, output: outputTokens }
		: undefined;

	return {
		success: !hasError,
		output,
		steps,
		duration: 0, // Will be set by executor
		error: errorMessage,
		tokens,
	};
}

/**
 * Parse a single stream message into execution steps.
 */
function parseStreamMessage(message: StreamMessage): ExecutionStep[] {
	const steps: ExecutionStep[] = [];
	const timestamp = new Date().toISOString();

	switch (message.type) {
		case "assistant":
			if (message.message?.content) {
				for (const block of message.message.content) {
					const step = parseContentBlock(block, timestamp);
					if (step) {
						steps.push(step);
					}
				}
			}
			break;

		case "user":
			// User messages contain tool results - mark them as such so they get filtered out
			// by extractFinalResult(). These are internal API messages, not AI responses.
			steps.push({
				type: "result",
				content: JSON.stringify(message),
				timestamp,
				metadata: { isToolResult: true, isUserMessage: true },
			});
			break;

		case "result": {
			// Handle result content - avoid double-stringifying if already a string
			let resultContent: string;
			if (typeof message.result === "string") {
				resultContent = message.result;
			} else if (message.result !== undefined) {
				resultContent = JSON.stringify(message.result);
			} else {
				resultContent = JSON.stringify(message);
			}
			steps.push({
				type: "result",
				content: resultContent,
				timestamp,
				metadata: { subtype: message.subtype },
			});
			break;
		}

		case "error":
			steps.push({
				type: "error",
				content: message.error || "Unknown error",
				timestamp,
			});
			break;

		case "system":
			// System messages are typically informational
			steps.push({
				type: "result",
				content: JSON.stringify(message),
				timestamp,
				metadata: { isSystem: true },
			});
			break;

		default:
			// Unknown message type - include as result but mark as internal
			// to avoid being picked up as the final response
			steps.push({
				type: "result",
				content: JSON.stringify(message),
				timestamp,
				metadata: { isInternal: true },
			});
	}

	return steps;
}

/**
 * Parse a content block into an execution step.
 */
function parseContentBlock(block: ContentBlock, timestamp: string): ExecutionStep | null {
	switch (block.type) {
		case "thinking":
			return {
				type: "thinking",
				content: block.thinking || "",
				timestamp,
			};

		case "tool_use":
			return {
				type: "tool_use",
				content: JSON.stringify({
					name: block.name,
					input: block.input,
				}),
				timestamp,
				metadata: {
					tool: block.name,
					id: block.id,
				},
			};

		case "tool_result":
			return {
				type: "result",
				content: block.content || "",
				timestamp,
				metadata: {
					isToolResult: true,
					toolId: block.id,
				},
			};

		case "text":
			return {
				type: "result",
				content: block.text || "",
				timestamp,
			};

		default:
			return null;
	}
}

/**
 * Extract tool calls from parsed steps.
 */
export function extractToolCalls(
	steps: ExecutionStep[],
): Array<{ name: string; input: unknown; id?: string }> {
	return steps
		.filter((step) => step.type === "tool_use")
		.map((step) => {
			try {
				const parsed = JSON.parse(step.content);
				return {
					name: parsed.name,
					input: parsed.input,
					id: step.metadata?.id as string | undefined,
				};
			} catch {
				return { name: "unknown", input: step.content };
			}
		});
}

/**
 * Extract thinking content from parsed steps.
 */
export function extractThinking(steps: ExecutionStep[]): string[] {
	return steps.filter((step) => step.type === "thinking").map((step) => step.content);
}

/**
 * Extract final result from parsed steps.
 *
 * This function looks for the final response from the AI.
 * It returns the last meaningful result step content, which could be:
 * - Text response from the AI
 * - JSON array/object (e.g., for scan results)
 *
 * The function filters out:
 * - Tool results (intermediate outputs)
 * - System messages (metadata)
 * - User messages (tool result confirmations)
 * - Internal/unknown message types
 * - Empty content
 */
export function extractFinalResult(steps: ExecutionStep[]): string | null {
	// Find all result steps that are not tool results, system messages, or internal messages
	const resultSteps = steps.filter(
		(step) =>
			step.type === "result" &&
			!step.metadata?.isToolResult &&
			!step.metadata?.isSystem &&
			!step.metadata?.isUserMessage &&
			!step.metadata?.isInternal &&
			step.content &&
			step.content.trim().length > 0,
	);

	if (resultSteps.length === 0) return null;

	// Return the last result step content
	// This could be text or JSON - the consumer will handle parsing
	return resultSteps[resultSteps.length - 1].content;
}

/**
 * Check if output contains stream-json format.
 */
export function isStreamJsonFormat(output: string): boolean {
	const lines = output.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return false;

	// Check if first non-empty line is valid JSON with expected structure
	try {
		const first = JSON.parse(lines[0]);
		return typeof first === "object" && first !== null && "type" in first;
	} catch {
		return false;
	}
}

/**
 * Stream parser for incremental parsing of stream-json output.
 * Useful for real-time processing of engine output.
 */
export class StreamJsonParser {
	private buffer = "";
	private readonly onStep: (step: ExecutionStep) => void;

	constructor(onStep: (step: ExecutionStep) => void) {
		this.onStep = onStep;
	}

	/**
	 * Feed data to the parser.
	 * @param chunk - New data chunk to parse
	 */
	feed(chunk: string): void {
		this.buffer += chunk;

		// Process complete lines
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const parsed = JSON.parse(trimmed) as StreamMessage;
				const steps = parseStreamMessage(parsed);
				for (const step of steps) {
					this.onStep(step);
				}
			} catch {
				// Not valid JSON - emit as plain text
				if (trimmed) {
					this.onStep({
						type: "result",
						content: trimmed,
						timestamp: new Date().toISOString(),
					});
				}
			}
		}
	}

	/**
	 * Flush any remaining buffered content.
	 */
	flush(): void {
		if (this.buffer.trim()) {
			this.onStep({
				type: "result",
				content: this.buffer.trim(),
				timestamp: new Date().toISOString(),
			});
			this.buffer = "";
		}
	}
}
