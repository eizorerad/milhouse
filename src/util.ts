/**
 * Utilities — JSON extraction and helpers.
 */

/**
 * Extract JSON from AI response that may contain markdown code blocks.
 */
export function extractJson(response: string): string | null {
	if (!response) return null;

	// Try: ```json ... ```
	const jsonBlock = response.match(/```json\s*\n?([\s\S]*?)```/);
	if (jsonBlock?.[1]) return jsonBlock[1].trim();

	// Try: ``` ... ```
	const codeBlock = response.match(/```\s*\n?([\s\S]*?)```/);
	if (codeBlock?.[1]) {
		const content = codeBlock[1].trim();
		if (content.startsWith("[") || content.startsWith("{")) return content;
	}

	// Try: raw JSON (starts with [ or {)
	const trimmed = response.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		// Find the matching closing bracket
		const open = trimmed[0];
		const close = open === "[" ? "]" : "}";
		let depth = 0;
		for (let i = 0; i < trimmed.length; i++) {
			if (trimmed[i] === '"') {
				i++;
				while (i < trimmed.length && trimmed[i] !== '"') {
					if (trimmed[i] === "\\") i++;
					i++;
				}
				continue;
			}
			if (trimmed[i] === open) depth++;
			if (trimmed[i] === close) depth--;
			if (depth === 0) return trimmed.slice(0, i + 1);
		}
	}

	return null;
}

/**
 * Generate a unique ID with optional prefix.
 */
export function generateId(prefix = "P"): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).substring(2, 8);
	return `${prefix}-${ts}-${rand}`;
}

/**
 * Current ISO timestamp.
 */
export function now(): string {
	return new Date().toISOString();
}
