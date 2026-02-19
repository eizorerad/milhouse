/**
 * JSON Schema for validate phase (IV agent)
 * Forces structured JSON output from the AI engine.
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
} as const;
