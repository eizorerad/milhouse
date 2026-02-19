/**
 * JSON Schema for scan phase (LI agent)
 * Forces structured JSON output from the AI engine.
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
				required: ["type", "title", "rationale", "severity"],
			},
		},
	},
	required: ["items"],
} as const;
