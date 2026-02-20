/**
 * JSON Schema for scan phase (LI agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 */
export const SCAN_SCHEMA = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["bug", "feature", "refactor", "improvement", "task"] },
					title: { type: "string" },
					rationale: { type: "string" },
					severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
					scope_impact: { type: "string" },
					strategy: { type: "string" },
				},
				required: ["type", "title", "rationale", "severity", "scope_impact", "strategy"],
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
} as const;
