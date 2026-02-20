/**
 * JSON Schema for verify phase (TV agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 *
 * Only includes fields consumed by parseResponse in verify phase config.
 */
export const VERIFY_SCHEMA = {
	type: "object",
	properties: {
		overall_pass: { type: "boolean" },
		gates: {
			type: "array",
			items: {
				type: "object",
				properties: {
					gate: { type: "string" },
					passed: { type: "boolean" },
					message: { type: "string" },
				},
				required: ["gate", "passed", "message"],
				additionalProperties: false,
			},
		},
		recommendations: { type: "array", items: { type: "string" } },
		regressions_found: { type: "boolean" },
		summary: { type: "string" },
	},
	required: ["overall_pass", "gates", "recommendations", "regressions_found", "summary"],
	additionalProperties: false,
} as const;
