/**
 * JSON Schemas for Claude --json-schema flag.
 * Forces structured JSON output after Claude's agent workflow completes.
 * Without these, Claude in agent mode tends to return prose summaries.
 */

/** Schema for scan phase (LI agent) */
export const SCAN_JSON_SCHEMA = {
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
};

/** Schema for validate phase (IV agent) */
export const VALIDATE_JSON_SCHEMA = {
	type: "object",
	properties: {
		issue_id: { type: "string" },
		status: { type: "string", enum: ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"] },
		confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
		summary: { type: "string" },
		investigation: {
			type: "object",
			properties: {
				files_examined: { type: "array", items: { type: "string" } },
				commands_run: { type: "array", items: { type: "string" } },
				patterns_found: { type: "array", items: { type: "string" } },
				related_code: { type: "array", items: { type: "object" } },
			},
		},
		analysis: {
			type: "object",
			properties: {
				confirmed_finding: { type: "string" },
				alternative_considerations: { type: "array", items: { type: "string" } },
				validity_assessment: { type: "string" },
			},
		},
		impact_assessment: {
			type: "object",
			properties: {
				severity_confirmed: { type: "boolean" },
				actual_severity: { type: "string" },
				affected_components: { type: "array", items: { type: "string" } },
				user_impact: { type: "string" },
			},
		},
		recommendations: {
			type: "object",
			properties: {
				implementation_approach: { type: "string" },
				estimated_complexity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
				test_strategy: { type: "string" },
			},
		},
		evidence: { type: "array", items: { type: "object" } },
		corrected_description: { type: "string" },
	},
	required: ["issue_id", "status", "confidence", "summary"],
};

/** Schema for plan phase (PL agent) */
export const PLAN_JSON_SCHEMA = {
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
};

/** Schema for consolidate phase (CDM agent) */
export const CONSOLIDATE_JSON_SCHEMA = {
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
};

/** Schema for verify phase (TV agent) */
export const VERIFY_JSON_SCHEMA = {
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
};
