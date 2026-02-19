/**
 * JSON Schema for verify phase (TV agent)
 * Forces structured JSON output from the AI engine.
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
				required: ["gate", "passed"],
			},
		},
		recommendations: { type: "array", items: { type: "string" } },
		regressions_found: { type: "boolean" },
		summary: { type: "string" },
	},
	required: ["overall_pass", "gates", "recommendations"],
} as const;
