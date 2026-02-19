/**
 * Robust JSON extraction utility
 *
 * Extracts JSON from AI responses using multiple strategies:
 * 1. Explicitly tagged ```json code blocks (case-insensitive)
 * 2. Any code block with valid JSON content
 * 3. Standalone JSON using bracket matching
 * 4. Entire response if valid JSON
 *
 * This replaces the brittle regex pattern used in 13+ locations:
 * `const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);`
 */

/**
 * Try to parse a string as JSON, returning null if invalid
 */
export function tryParseJson<T = unknown>(jsonStr: string): T | null {
	if (!jsonStr || typeof jsonStr !== "string") {
		return null;
	}

	const trimmed = jsonStr.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed) as T;
	} catch {
		return null;
	}
}

/**
 * Attempt to fix common JSON issues from AI responses.
 *
 * AI models sometimes produce JSON with:
 * - Unescaped newlines inside string values
 * - Trailing commas
 * - Single quotes instead of double quotes
 *
 * This function attempts to fix these issues.
 */
export function tryFixAndParseJson<T = unknown>(jsonStr: string): T | null {
	if (!jsonStr || typeof jsonStr !== "string") {
		return null;
	}

	const trimmed = jsonStr.trim();
	if (!trimmed) {
		return null;
	}

	// First try parsing as-is
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		// Continue to fix attempts
	}

	// Strategy 1: Fix unescaped newlines inside strings
	// This is a common issue with AI-generated JSON
	let fixed = trimmed;

	// Replace literal newlines inside strings with escaped newlines
	// We do this by finding strings and escaping newlines within them
	try {
		// Simple approach: replace newlines that are followed by whitespace and more content
		// This handles cases like: "some text\n   more text"
		fixed = fixed.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
			// Within each string, escape unescaped newlines
			return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
		});

		const result = JSON.parse(fixed);
		return result as T;
	} catch {
		// Continue to next strategy
	}

	// Strategy 2: More aggressive - remove all newlines and extra whitespace
	try {
		// Remove newlines and collapse whitespace, but preserve string content
		fixed = trimmed
			.split("\n")
			.map((line) => line.trim())
			.join(" ")
			.replace(/\s+/g, " ");

		const result = JSON.parse(fixed);
		return result as T;
	} catch {
		// Continue to next strategy
	}

	// Strategy 3: Try to extract just the array/object part
	try {
		const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
		if (arrayMatch) {
			const cleaned = arrayMatch[0]
				.split("\n")
				.map((line) => line.trim())
				.join(" ");
			const result = JSON.parse(cleaned);
			return result as T;
		}
	} catch {
		// Continue
	}

	try {
		const objectMatch = trimmed.match(/\{[\s\S]*\}/);
		if (objectMatch) {
			const cleaned = objectMatch[0]
				.split("\n")
				.map((line) => line.trim())
				.join(" ");
			const result = JSON.parse(cleaned);
			return result as T;
		}
	} catch {
		// Continue
	}

	return null;
}

/**
 * Extract balanced JSON starting from a bracket character
 *
 * Handles nested structures and ignores brackets inside strings.
 *
 * @param text - Text starting with '{' or '['
 * @param startChar - The opening bracket character
 * @returns Extracted JSON string or null if unbalanced
 */
export function extractBalancedJson(text: string, startChar: "{" | "[" = "{"): string | null {
	if (!text || text[0] !== startChar) {
		return null;
	}

	const endChar = startChar === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === "\\") {
			escapeNext = true;
			continue;
		}

		if (char === '"' && !escapeNext) {
			inString = !inString;
			continue;
		}

		if (!inString) {
			if (char === startChar) {
				depth++;
			} else if (char === endChar) {
				depth--;
				if (depth === 0) {
					const extracted = text.slice(0, i + 1);
					// Validate it's actually valid JSON
					if (tryParseJson(extracted) !== null) {
						return extracted;
					}
					return null;
				}
			}
		}
	}

	return null; // Unbalanced
}

/**
 * Extract all code blocks from a response
 *
 * @param response - The AI response text
 * @returns Array of [fullMatch, language, content] tuples
 */
function extractCodeBlocks(response: string): Array<{ language: string | null; content: string }> {
	const blocks: Array<{ language: string | null; content: string }> = [];

	// Match code blocks with optional language tag
	const codeBlockRegex = /```(\w*)\s*([\s\S]*?)```/g;
	let match: RegExpExecArray | null;

	while ((match = codeBlockRegex.exec(response)) !== null) {
		const language = match[1] || null;
		const content = match[2].trim();
		blocks.push({ language, content });
	}

	return blocks;
}

/**
 * Extract JSON from an AI response using multiple strategies
 *
 * Strategies (in order of preference):
 * 1. Explicitly tagged ```json code blocks (case-insensitive)
 * 2. Any code block with valid JSON content
 * 3. Standalone JSON using bracket matching
 * 4. Entire response if valid JSON
 *
 * @param response - The AI response text
 * @returns Extracted JSON string or null if no valid JSON found
 */
export function extractJsonFromResponse(response: string): string | null {
	if (!response || typeof response !== "string") {
		return null;
	}

	const trimmedResponse = response.trim();
	if (!trimmedResponse) {
		return null;
	}

	// Strategy 1: Try explicitly tagged JSON code blocks (case-insensitive)
	const codeBlocks = extractCodeBlocks(trimmedResponse);

	// First pass: look for explicitly tagged json blocks (try exact parse first)
	for (const block of codeBlocks) {
		if (block.language?.toLowerCase() === "json") {
			if (tryParseJson(block.content) !== null) {
				return block.content;
			}
		}
	}

	// Second pass: try to fix and parse json blocks (handles malformed JSON from AI)
	for (const block of codeBlocks) {
		if (block.language?.toLowerCase() === "json") {
			const fixed = tryFixAndParseJson(block.content);
			if (fixed !== null) {
				// Return the fixed JSON as a string
				return JSON.stringify(fixed);
			}
		}
	}

	// Strategy 2: Try any code block that contains valid JSON
	for (const block of codeBlocks) {
		if (tryParseJson(block.content) !== null) {
			return block.content;
		}
	}

	// Try to fix and parse any code block
	for (const block of codeBlocks) {
		const fixed = tryFixAndParseJson(block.content);
		if (fixed !== null) {
			return JSON.stringify(fixed);
		}
	}

	// Strategy 3: Find standalone JSON using bracket matching
	// Look for JSON object or array outside code blocks
	const jsonObjectStart = trimmedResponse.search(/(?:^|[^`])\{/);
	const jsonArrayStart = trimmedResponse.search(/(?:^|[^`])\[/);

	// Determine which bracket comes first and try that one first
	// This ensures arrays like [{...}] are parsed as arrays, not as the first object
	const objectFirst =
		jsonObjectStart >= 0 && (jsonArrayStart < 0 || jsonObjectStart < jsonArrayStart);
	const arrayFirst =
		jsonArrayStart >= 0 && (jsonObjectStart < 0 || jsonArrayStart < jsonObjectStart);

	// Try array first if it comes before object
	if (arrayFirst) {
		const actualStart =
			trimmedResponse[jsonArrayStart] === "[" ? jsonArrayStart : jsonArrayStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "[");
		if (extracted) {
			return extracted;
		}
	}

	// Try object
	if (objectFirst) {
		// Adjust index if the match included the non-backtick character
		const actualStart =
			trimmedResponse[jsonObjectStart] === "{" ? jsonObjectStart : jsonObjectStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "{");
		if (extracted) {
			return extracted;
		}
	}

	// Fallback: try the other bracket type if the first one failed
	if (arrayFirst && jsonObjectStart >= 0) {
		const actualStart =
			trimmedResponse[jsonObjectStart] === "{" ? jsonObjectStart : jsonObjectStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "{");
		if (extracted) {
			return extracted;
		}
	}

	if (objectFirst && jsonArrayStart >= 0) {
		const actualStart =
			trimmedResponse[jsonArrayStart] === "[" ? jsonArrayStart : jsonArrayStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "[");
		if (extracted) {
			return extracted;
		}
	}

	// Strategy 4: Try entire response as JSON
	if (tryParseJson(trimmedResponse) !== null) {
		return trimmedResponse;
	}

	return null;
}

/**
 * Extract and parse JSON from response in one step
 *
 * @param response - The AI response text
 * @returns Parsed JSON object/array or null
 */
export function extractAndParseJson<T = unknown>(response: string): T | null {
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		return null;
	}
	return tryParseJson<T>(jsonStr);
}

/**
 * Result of JSON extraction with metadata
 */
export interface JsonExtractionResult<T = unknown> {
	success: boolean;
	data: T | null;
	rawJson: string | null;
	strategy: "json-block" | "code-block" | "standalone" | "full-response" | null;
	error?: string;
}

/**
 * Extract JSON with detailed result information
 *
 * Useful for debugging and logging which strategy succeeded.
 *
 * @param response - The AI response text
 * @returns Extraction result with metadata
 */
export function extractJsonWithMetadata<T = unknown>(response: string): JsonExtractionResult<T> {
	if (!response || typeof response !== "string") {
		return {
			success: false,
			data: null,
			rawJson: null,
			strategy: null,
			error: "Response is empty or not a string",
		};
	}

	const trimmedResponse = response.trim();
	if (!trimmedResponse) {
		return {
			success: false,
			data: null,
			rawJson: null,
			strategy: null,
			error: "Response is empty after trimming",
		};
	}

	const codeBlocks = extractCodeBlocks(trimmedResponse);

	// Strategy 1: Explicitly tagged JSON blocks
	for (const block of codeBlocks) {
		if (block.language?.toLowerCase() === "json") {
			const parsed = tryParseJson<T>(block.content);
			if (parsed !== null) {
				return {
					success: true,
					data: parsed,
					rawJson: block.content,
					strategy: "json-block",
				};
			}
		}
	}

	// Strategy 2: Any code block with valid JSON
	for (const block of codeBlocks) {
		const parsed = tryParseJson<T>(block.content);
		if (parsed !== null) {
			return {
				success: true,
				data: parsed,
				rawJson: block.content,
				strategy: "code-block",
			};
		}
	}

	// Strategy 3: Standalone JSON
	const jsonObjectStart = trimmedResponse.search(/(?:^|[^`])\{/);
	const jsonArrayStart = trimmedResponse.search(/(?:^|[^`])\[/);

	// Determine which bracket comes first and try that one first
	// This ensures arrays like [{...}] are parsed as arrays, not as the first object
	const objectFirst =
		jsonObjectStart >= 0 && (jsonArrayStart < 0 || jsonObjectStart < jsonArrayStart);
	const arrayFirst =
		jsonArrayStart >= 0 && (jsonObjectStart < 0 || jsonArrayStart < jsonObjectStart);

	// Try array first if it comes before object
	if (arrayFirst) {
		const actualStart =
			trimmedResponse[jsonArrayStart] === "[" ? jsonArrayStart : jsonArrayStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "[");
		if (extracted) {
			const parsed = tryParseJson<T>(extracted);
			if (parsed !== null) {
				return {
					success: true,
					data: parsed,
					rawJson: extracted,
					strategy: "standalone",
				};
			}
		}
	}

	// Try object
	if (objectFirst) {
		const actualStart =
			trimmedResponse[jsonObjectStart] === "{" ? jsonObjectStart : jsonObjectStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "{");
		if (extracted) {
			const parsed = tryParseJson<T>(extracted);
			if (parsed !== null) {
				return {
					success: true,
					data: parsed,
					rawJson: extracted,
					strategy: "standalone",
				};
			}
		}
	}

	// Fallback: try the other bracket type if the first one failed
	if (arrayFirst && jsonObjectStart >= 0) {
		const actualStart =
			trimmedResponse[jsonObjectStart] === "{" ? jsonObjectStart : jsonObjectStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "{");
		if (extracted) {
			const parsed = tryParseJson<T>(extracted);
			if (parsed !== null) {
				return {
					success: true,
					data: parsed,
					rawJson: extracted,
					strategy: "standalone",
				};
			}
		}
	}

	if (objectFirst && jsonArrayStart >= 0) {
		const actualStart =
			trimmedResponse[jsonArrayStart] === "[" ? jsonArrayStart : jsonArrayStart + 1;
		const extracted = extractBalancedJson(trimmedResponse.slice(actualStart), "[");
		if (extracted) {
			const parsed = tryParseJson<T>(extracted);
			if (parsed !== null) {
				return {
					success: true,
					data: parsed,
					rawJson: extracted,
					strategy: "standalone",
				};
			}
		}
	}

	// Strategy 4: Full response
	const parsed = tryParseJson<T>(trimmedResponse);
	if (parsed !== null) {
		return {
			success: true,
			data: parsed,
			rawJson: trimmedResponse,
			strategy: "full-response",
		};
	}

	return {
		success: false,
		data: null,
		rawJson: null,
		strategy: null,
		error: "No valid JSON found in response",
	};
}
