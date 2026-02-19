/**
 * @fileoverview Validation Types Module
 *
 * Type definitions for the validation system including:
 * - ValidateResult: Result of validating issues
 * - ParsedValidation: Parsed validation result from AI response
 * - DeepValidationReport: Deep validation report structure
 * - ValidationRetryConfig: Configuration for validation retry behavior
 * - ValidationRoundResult: Result of a single validation round
 * - ValidationIndexEntry: Validation index entry
 * - ValidationIndex: Validation index structure
 *
 * @module cli/commands/utils/validation-types
 */

import type { Evidence, IssueStatus } from "../../../state/types.ts";

/**
 * Result of validating issues
 */
export interface ValidateResult {
	success: boolean;
	issuesValidated: number;
	issuesConfirmed: number;
	issuesFalse: number;
	issuesPartial: number;
	issuesMisdiagnosed: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}

/**
 * Parsed validation result from AI response
 */
export interface ParsedValidation {
	issue_id: string;
	status: IssueStatus;
	corrected_description?: string;
	evidence: Evidence[];
	probe_results?: string[];
}

/**
 * Deep validation report structure
 */
export interface DeepValidationReport {
	issue_id: string;
	run_id?: string;
	created_at?: string;
	status: IssueStatus;
	confidence: "HIGH" | "MEDIUM" | "LOW";
	summary: string;
	investigation: {
		files_examined: string[];
		commands_run: string[];
		patterns_found: string[];
		related_code: Array<{
			file: string;
			line_start: number;
			line_end: number;
			relevance: string;
			code_snippet?: string;
		}>;
	};
	root_cause_analysis: {
		confirmed_cause?: string;
		alternative_causes?: string[];
		why_not_false_positive?: string;
	};
	impact_assessment: {
		severity_confirmed: boolean;
		actual_severity?: string;
		affected_components: string[];
		user_impact?: string;
		security_implications?: string;
	};
	reproduction: {
		reproducible: boolean;
		steps?: string[];
		conditions?: string;
	};
	recommendations: {
		fix_approach: string;
		estimated_complexity: "LOW" | "MEDIUM" | "HIGH";
		prerequisites?: string[];
		test_strategy?: string;
	};
	evidence: Evidence[];
	corrected_description?: string;
	validation_duration_ms?: number;
}

/**
 * Configuration for validation retry behavior
 */
export interface ValidationRetryConfig {
	/** Maximum number of retry rounds */
	maxRetries: number;
	/** Whether retry is enabled */
	enabled: boolean;
	/** Delay between retry rounds in ms */
	delayMs: number;
}

/**
 * Result of a single validation round
 */
export interface ValidationRoundResult {
	/** Round number - 1 for initial, 2+ for retries */
	round: number;
	/** Issues that were validated in this round */
	validatedCount: number;
	/** Issues that remain UNVALIDATED after this round */
	unvalidatedCount: number;
	/** Issues confirmed in this round */
	confirmedCount: number;
	/** Issues marked as false positives in this round */
	falseCount: number;
	/** Issues marked as partial in this round */
	partialCount: number;
	/** Issues marked as misdiagnosed in this round */
	misdiagnosedCount: number;
	/** Total input tokens used in this round */
	inputTokens: number;
	/** Total output tokens used in this round */
	outputTokens: number;
	/** Errors encountered in this round */
	errors: string[];
	/** Reports generated in this round */
	reports: DeepValidationReport[];
}

/**
 * Validation index entry
 */
export interface ValidationIndexEntry {
	issue_id: string;
	report_path: string;
	created_at: string;
	status: IssueStatus;
}

/**
 * Validation index structure
 */
export interface ValidationIndex {
	run_id: string;
	reports: ValidationIndexEntry[];
}
