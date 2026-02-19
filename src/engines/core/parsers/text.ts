import type { ExecutionResult, ExecutionStep } from "../../../schemas/engine.schema";

/**
 * Patterns for detecting step types in plain text output.
 */
const STEP_PATTERNS = {
	thinking: [/^(?:thinking|reasoning|analyzing|considering):/i, /^<thinking>/i, /^\[thinking\]/i],
	toolUse: [
		/^(?:running|executing|calling|using):\s*(.+)/i,
		/^tool:\s*(.+)/i,
		/^\[tool\]\s*(.+)/i,
		/^```(?:bash|shell|sh)\n/,
	],
	error: [/^error:/i, /^(?:failed|failure):/i, /^\[error\]/i, /^exception:/i],
	result: [/^(?:result|output|done|complete):/i, /^\[result\]/i],
};

/**
 * Parse plain text output into execution steps.
 * This parser attempts to detect structure in unstructured text output.
 *
 * @param output - Raw text output from engine
 * @returns Parsed execution result with detected steps
 */
export function parseTextOutput(output: string): ExecutionResult {
	const steps: ExecutionStep[] = [];
	const lines = output.split("\n");
	let hasError = false;
	let currentStep: Partial<ExecutionStep> | null = null;
	let currentContent: string[] = [];

	const flushCurrentStep = () => {
		if (currentStep && currentContent.length > 0) {
			steps.push({
				type: currentStep.type || "result",
				content: currentContent.join("\n").trim(),
				timestamp: currentStep.timestamp || new Date().toISOString(),
				metadata: currentStep.metadata,
			});
		}
		currentStep = null;
		currentContent = [];
	};

	for (const line of lines) {
		const stepType = detectStepType(line);

		if (stepType) {
			// Flush previous step
			flushCurrentStep();

			// Start new step
			currentStep = {
				type: stepType,
				timestamp: new Date().toISOString(),
			};

			if (stepType === "error") {
				hasError = true;
			}

			// Extract content after the marker
			const content = extractContentAfterMarker(line, stepType);
			if (content) {
				currentContent.push(content);
			}
		} else if (line.trim()) {
			// Add to current step or create new result step
			if (!currentStep) {
				currentStep = {
					type: "result",
					timestamp: new Date().toISOString(),
				};
			}
			currentContent.push(line);
		}
	}

	// Flush final step
	flushCurrentStep();

	// If no steps were detected, treat entire output as single result
	if (steps.length === 0 && output.trim()) {
		steps.push({
			type: "result",
			content: output.trim(),
			timestamp: new Date().toISOString(),
		});
	}

	return {
		success: !hasError,
		output,
		steps,
		duration: 0, // Will be set by executor
		error: hasError ? "Error detected in output" : undefined,
	};
}

/**
 * Detect the step type from a line of text.
 */
function detectStepType(line: string): ExecutionStep["type"] | null {
	const trimmed = line.trim();

	for (const pattern of STEP_PATTERNS.thinking) {
		if (pattern.test(trimmed)) return "thinking";
	}

	for (const pattern of STEP_PATTERNS.toolUse) {
		if (pattern.test(trimmed)) return "tool_use";
	}

	for (const pattern of STEP_PATTERNS.error) {
		if (pattern.test(trimmed)) return "error";
	}

	for (const pattern of STEP_PATTERNS.result) {
		if (pattern.test(trimmed)) return "result";
	}

	return null;
}

/**
 * Extract content after a step marker.
 */
function extractContentAfterMarker(line: string, stepType: ExecutionStep["type"]): string | null {
	const trimmed = line.trim();

	// Try to extract content after colon
	const colonMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
	if (colonMatch) {
		return colonMatch[1];
	}

	// Try to extract content after bracket marker
	const bracketMatch = trimmed.match(/^\[[^\]]+\]\s*(.+)$/);
	if (bracketMatch) {
		return bracketMatch[1];
	}

	return null;
}

/**
 * Parse output with custom step detection patterns.
 *
 * @param output - Raw text output
 * @param patterns - Custom patterns for step detection
 * @returns Parsed execution result
 */
export function parseTextWithPatterns(
	output: string,
	patterns: {
		thinking?: RegExp[];
		toolUse?: RegExp[];
		error?: RegExp[];
		result?: RegExp[];
	},
): ExecutionResult {
	const mergedPatterns = {
		thinking: [...STEP_PATTERNS.thinking, ...(patterns.thinking || [])],
		toolUse: [...STEP_PATTERNS.toolUse, ...(patterns.toolUse || [])],
		error: [...STEP_PATTERNS.error, ...(patterns.error || [])],
		result: [...STEP_PATTERNS.result, ...(patterns.result || [])],
	};

	// Use the merged patterns for detection
	const steps: ExecutionStep[] = [];
	const lines = output.split("\n");
	let hasError = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let stepType: ExecutionStep["type"] = "result";

		for (const pattern of mergedPatterns.thinking) {
			if (pattern.test(trimmed)) {
				stepType = "thinking";
				break;
			}
		}

		for (const pattern of mergedPatterns.toolUse) {
			if (pattern.test(trimmed)) {
				stepType = "tool_use";
				break;
			}
		}

		for (const pattern of mergedPatterns.error) {
			if (pattern.test(trimmed)) {
				stepType = "error";
				hasError = true;
				break;
			}
		}

		steps.push({
			type: stepType,
			content: trimmed,
			timestamp: new Date().toISOString(),
		});
	}

	return {
		success: !hasError,
		output,
		steps,
		duration: 0,
		error: hasError ? "Error detected in output" : undefined,
	};
}

/**
 * Parse ANSI-colored output, stripping color codes.
 */
export function parseAnsiOutput(output: string): ExecutionResult {
	// Strip ANSI escape codes
	const stripped = output.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		"",
	);

	return parseTextOutput(stripped);
}

/**
 * Parse markdown-formatted output.
 */
export function parseMarkdownOutput(output: string): ExecutionResult {
	const steps: ExecutionStep[] = [];
	let hasError = false;

	// Split by markdown headers
	const sections = output.split(/^#{1,3}\s+/m);

	for (const section of sections) {
		if (!section.trim()) continue;

		const lines = section.split("\n");
		const header = lines[0]?.trim().toLowerCase() || "";
		const content = lines.slice(1).join("\n").trim();

		let stepType: ExecutionStep["type"] = "result";

		if (header.includes("thinking") || header.includes("analysis")) {
			stepType = "thinking";
		} else if (header.includes("tool") || header.includes("command")) {
			stepType = "tool_use";
		} else if (header.includes("error") || header.includes("failed")) {
			stepType = "error";
			hasError = true;
		}

		if (content) {
			steps.push({
				type: stepType,
				content,
				timestamp: new Date().toISOString(),
				metadata: { header },
			});
		}
	}

	// If no sections found, treat as plain text
	if (steps.length === 0) {
		return parseTextOutput(output);
	}

	return {
		success: !hasError,
		output,
		steps,
		duration: 0,
		error: hasError ? "Error detected in output" : undefined,
	};
}

/**
 * Auto-detect output format and parse accordingly.
 */
export function parseAutoDetect(output: string): ExecutionResult {
	// Check for JSON lines (stream-json format)
	const firstLine = output.split("\n")[0]?.trim();
	if (firstLine?.startsWith("{") && firstLine.includes('"type"')) {
		// Likely stream-json, but we'll use text parser as fallback
		// The stream-json parser should be used directly for that format
	}

	// Check for markdown headers
	if (/^#{1,3}\s+/m.test(output)) {
		return parseMarkdownOutput(output);
	}

	// Check for ANSI codes
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
	if (/[\u001b\u009b]/.test(output)) {
		return parseAnsiOutput(output);
	}

	// Default to plain text
	return parseTextOutput(output);
}
