/**
 * JSON Schema for plan phase (PL agent)
 * Forces structured JSON output from the AI engine.
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
							required: ["description"],
						},
					},
					risk: { type: "string" },
					rollback: { type: "string" },
					parallel_group: { type: "number" },
				},
				required: ["title", "files"],
			},
		},
	},
	required: ["issue_id", "summary", "tasks"],
} as const;
