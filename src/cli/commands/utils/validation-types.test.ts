/**
 * @fileoverview Tests for validation-types.ts
 *
 * Ensures type definitions compile correctly and interfaces are properly structured.
 */

import { describe, expect, it } from "bun:test";
import type {
	DeepValidationReport,
	ParsedValidation,
	ValidateResult,
	ValidationIndex,
	ValidationIndexEntry,
	ValidationRetryConfig,
	ValidationRoundResult,
} from "./validation-types.ts";

describe("validation-types", () => {
	describe("ValidateResult", () => {
		it("should have all required fields", () => {
			const result: ValidateResult = {
				success: true,
				issuesValidated: 5,
				issuesConfirmed: 3,
				issuesFalse: 1,
				issuesPartial: 1,
				issuesMisdiagnosed: 0,
				inputTokens: 1000,
				outputTokens: 500,
			};

			expect(result.success).toBe(true);
			expect(result.issuesValidated).toBe(5);
			expect(result.issuesConfirmed).toBe(3);
		});

		it("should accept optional error field", () => {
			const result: ValidateResult = {
				success: false,
				issuesValidated: 0,
				issuesConfirmed: 0,
				issuesFalse: 0,
				issuesPartial: 0,
				issuesMisdiagnosed: 0,
				inputTokens: 0,
				outputTokens: 0,
				error: "Test error",
			};

			expect(result.error).toBe("Test error");
		});
	});

	describe("ParsedValidation", () => {
		it("should have all required fields", () => {
			const validation: ParsedValidation = {
				issue_id: "P-test123",
				status: "CONFIRMED",
				evidence: [],
			};

			expect(validation.issue_id).toBe("P-test123");
			expect(validation.status).toBe("CONFIRMED");
		});

		it("should accept optional fields", () => {
			const validation: ParsedValidation = {
				issue_id: "P-test123",
				status: "PARTIAL",
				evidence: [],
				corrected_description: "Updated description",
				probe_results: ["probe1", "probe2"],
			};

			expect(validation.corrected_description).toBe("Updated description");
			expect(validation.probe_results).toHaveLength(2);
		});
	});

	describe("DeepValidationReport", () => {
		it("should have all required fields", () => {
			const report: DeepValidationReport = {
				issue_id: "P-test123",
				status: "CONFIRMED",
				confidence: "HIGH",
				summary: "Test summary",
				investigation: {
					files_examined: ["file1.ts"],
					commands_run: ["npm test"],
					patterns_found: ["pattern1"],
					related_code: [],
				},
				root_cause_analysis: {},
				impact_assessment: {
					severity_confirmed: true,
					affected_components: ["Component1"],
				},
				reproduction: {
					reproducible: true,
				},
				recommendations: {
					fix_approach: "Fix the bug",
					estimated_complexity: "LOW",
				},
				evidence: [],
			};

			expect(report.issue_id).toBe("P-test123");
			expect(report.confidence).toBe("HIGH");
			expect(report.investigation.files_examined).toContain("file1.ts");
		});
	});

	describe("ValidationRetryConfig", () => {
		it("should have all required fields", () => {
			const config: ValidationRetryConfig = {
				maxRetries: 3,
				enabled: true,
				delayMs: 2000,
			};

			expect(config.maxRetries).toBe(3);
			expect(config.enabled).toBe(true);
			expect(config.delayMs).toBe(2000);
		});
	});

	describe("ValidationRoundResult", () => {
		it("should have all required fields", () => {
			const result: ValidationRoundResult = {
				round: 1,
				validatedCount: 5,
				unvalidatedCount: 2,
				confirmedCount: 3,
				falseCount: 1,
				partialCount: 1,
				misdiagnosedCount: 0,
				inputTokens: 1000,
				outputTokens: 500,
				errors: [],
				reports: [],
			};

			expect(result.round).toBe(1);
			expect(result.validatedCount).toBe(5);
		});
	});

	describe("ValidationIndexEntry", () => {
		it("should have all required fields", () => {
			const entry: ValidationIndexEntry = {
				issue_id: "P-test123",
				report_path: "/path/to/report.json",
				created_at: "2024-01-01T00:00:00Z",
				status: "CONFIRMED",
			};

			expect(entry.issue_id).toBe("P-test123");
			expect(entry.status).toBe("CONFIRMED");
		});
	});

	describe("ValidationIndex", () => {
		it("should have all required fields", () => {
			const index: ValidationIndex = {
				run_id: "run-123",
				reports: [],
			};

			expect(index.run_id).toBe("run-123");
			expect(index.reports).toEqual([]);
		});
	});
});
