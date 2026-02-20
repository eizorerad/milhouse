/**
 * JSON Schema for validate phase (IV agent)
 * Forces structured JSON output from the AI engine.
 *
 * Compliant with Anthropic Structured Outputs requirements:
 * - additionalProperties: false on all objects
 * - All properties listed in required
 */
export const VALIDATE_SCHEMA = {
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
				related_code: {
					type: "array",
					items: {
						type: "object",
						properties: {
							file: { type: "string" },
							line: { type: "number" },
							snippet: { type: "string" },
						},
						required: ["file", "line", "snippet"],
						additionalProperties: false,
					},
				},
			},
			required: ["files_examined", "commands_run", "patterns_found", "related_code"],
			additionalProperties: false,
		},
		analysis: {
			type: "object",
			properties: {
				confirmed_finding: { type: "string" },
				alternative_considerations: { type: "array", items: { type: "string" } },
				validity_assessment: { type: "string" },
			},
			required: ["confirmed_finding", "alternative_considerations", "validity_assessment"],
			additionalProperties: false,
		},
		impact_assessment: {
			type: "object",
			properties: {
				severity_confirmed: { type: "boolean" },
				actual_severity: { type: "string" },
				affected_components: { type: "array", items: { type: "string" } },
				user_impact: { type: "string" },
			},
			required: ["severity_confirmed", "actual_severity", "affected_components", "user_impact"],
			additionalProperties: false,
		},
		recommendations: {
			type: "object",
			properties: {
				implementation_approach: { type: "string" },
				estimated_complexity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
				test_strategy: { type: "string" },
			},
			required: ["implementation_approach", "estimated_complexity", "test_strategy"],
			additionalProperties: false,
		},
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
				required: ["type"],
				additionalProperties: false,
			},
		},
		corrected_description: { type: "string" },
	},
	required: [
		"issue_id",
		"status",
		"confidence",
		"summary",
		"investigation",
		"analysis",
		"impact_assessment",
		"recommendations",
		"evidence",
		"corrected_description",
	],
	additionalProperties: false,
} as const;
