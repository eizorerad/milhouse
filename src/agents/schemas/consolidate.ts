/**
 * JSON Schema for consolidate phase (CDM agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 *
 * Only includes fields consumed by parseResponse in consolidate phase config.
 */
export const CONSOLIDATE_SCHEMA = {
	type: "object",
	properties: {
		duplicates: {
			type: "array",
			items: {
				type: "object",
				properties: {
					keep: { type: "string" },
					remove: { type: "array", items: { type: "string" } },
					reason: { type: "string" },
				},
				required: ["keep", "remove", "reason"],
				additionalProperties: false,
			},
		},
		cross_dependencies: {
			type: "array",
			items: {
				type: "object",
				properties: {
					task_id: { type: "string" },
					depends_on: { type: "array", items: { type: "string" } },
					reason: { type: "string" },
				},
				required: ["task_id", "depends_on", "reason"],
				additionalProperties: false,
			},
		},
		parallel_groups: {
			type: "array",
			items: {
				type: "object",
				properties: {
					group: { type: "number" },
					task_ids: { type: "array", items: { type: "string" } },
				},
				required: ["group", "task_ids"],
				additionalProperties: false,
			},
		},
		execution_order: { type: "array", items: { type: "string" } },
	},
	required: ["duplicates", "cross_dependencies", "parallel_groups", "execution_order"],
	additionalProperties: false,
} as const;
