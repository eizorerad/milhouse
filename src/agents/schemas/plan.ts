/**
 * JSON Schema for plan phase (PL agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 */
export const PLAN_SCHEMA = {
	type: "object",
	properties: {
		issue_id: { type: "string" },
		summary: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					files: { type: "array", items: { type: "string" } },
					depends_on: { type: "array", items: { type: "string" } },
					checks: { type: "array", items: { type: "string" } },
					acceptance: {
						type: "array",
						items: {
							type: "object",
							properties: {
								description: { type: "string" },
								check_command: { type: "string" },
							},
							required: ["description", "check_command"],
							additionalProperties: false,
						},
					},
					risk: { type: "string" },
					rollback: { type: "string" },
					parallel_group: { type: "number" },
				},
				required: [
					"title",
					"description",
					"files",
					"depends_on",
					"checks",
					"acceptance",
					"risk",
					"rollback",
					"parallel_group",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["issue_id", "summary", "tasks"],
	additionalProperties: false,
} as const;
