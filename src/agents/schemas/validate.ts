/**
 * JSON Schema for validate phase (IV agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 *
 * Only includes fields consumed by parseResponse in validate phase config.
 */
export const VALIDATE_SCHEMA = {
	type: "object",
	properties: {
		issue_id: { type: "string" },
		status: { type: "string", enum: ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] },
		confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
		summary: { type: "string" },
		corrected_description: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["file", "probe", "log", "command"] },
					file: { type: "string" },
					line_start: { type: "number" },
					line_end: { type: "number" },
					output: { type: "string" },
					timestamp: { type: "string" },
				},
				required: ["type", "file", "line_start", "line_end", "output", "timestamp"],
				additionalProperties: false,
			},
		},
	},
	required: ["issue_id", "status", "confidence", "summary", "corrected_description", "evidence"],
	additionalProperties: false,
} as const;
