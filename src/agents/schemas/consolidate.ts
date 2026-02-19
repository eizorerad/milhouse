/**
 * JSON Schema for consolidate phase (CDM agent)
 * Forces structured JSON output from the AI engine.
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
			},
		},
		execution_order: { type: "array", items: { type: "string" } },
	},
	required: ["duplicates", "cross_dependencies", "parallel_groups", "execution_order"],
} as const;
