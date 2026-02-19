/**
 * @fileoverview Verification Types Module
 *
 * Type definitions and Zod schemas for the verification system including:
 * - VerificationReportSchema: Schema for verification report persistence
 * - VerificationReport: TypeScript type for verification reports
 * - VerificationIndexEntry: Index entry for verification reports
 * - VerificationIndex: Index structure for all verification reports in a run
 *
 * @module cli/commands/utils/verification-types
 */

import { z } from "zod";
import { EvidenceSchema } from "../../../state/types.ts";

/**
 * Schema for individual verification issues found during gate checks
 */
export const VerificationIssueSchema = z.object({
	/** Gate that detected the issue */
	gate: z.string(),
	/** Severity level of the issue */
	severity: z.enum(["ERROR", "WARNING"]),
	/** File where the issue was found (if applicable) */
	file: z.string().optional(),
	/** Line number in the file (if applicable) */
	line: z.number().optional(),
	/** Description of the issue */
	message: z.string(),
	/** Evidence supporting the issue */
	evidence: EvidenceSchema.optional(),
});

export type VerificationIssue = z.infer<typeof VerificationIssueSchema>;

/**
 * Schema for individual gate results in the verification report
 */
export const GateResultEntrySchema = z.object({
	/** Gate identifier */
	gate: z.string(),
	/** Whether the gate passed */
	passed: z.boolean(),
	/** Human-readable message about the gate result */
	message: z.string().optional(),
	/** Evidence collected during gate execution */
	evidence: z.array(EvidenceSchema).default([]),
});

export type GateResultEntry = z.infer<typeof GateResultEntrySchema>;

/**
 * Schema for AI verification results
 */
export const AIVerificationResultSchema = z.object({
	/** Overall pass/fail from AI verification */
	overall_pass: z.boolean(),
	/** Recommendations from the AI verifier */
	recommendations: z.array(z.string()).default([]),
	/** Whether regressions were found */
	regressions_found: z.boolean().default(false),
	/** Summary of verification results */
	summary: z.string().optional(),
});

export type AIVerificationResult = z.infer<typeof AIVerificationResultSchema>;

/**
 * Schema for the complete verification report
 *
 * This schema captures all data produced during the verify stage:
 * - Gate execution results
 * - Issues found during verification
 * - AI verification analysis
 * - Token usage and timing metrics
 * - Task completion status
 */
export const VerificationReportSchema = z.object({
	/** Unique run identifier */
	run_id: z.string(),
	/** ISO timestamp when the report was created */
	created_at: z.string(),
	/** Duration of verification in milliseconds */
	duration_ms: z.number(),
	/** Overall success status of verification */
	overall_success: z.boolean(),
	/** Gate execution summary and results */
	gates: z.object({
		/** Total number of gates executed */
		total: z.number(),
		/** Number of gates that passed */
		passed: z.number(),
		/** Number of gates that failed */
		failed: z.number(),
		/** Individual gate results */
		results: z.array(GateResultEntrySchema),
	}),
	/** Issues found during verification */
	issues: z.array(VerificationIssueSchema),
	/** AI verification results (optional, may not be available if AI fails) */
	ai_verification: AIVerificationResultSchema.optional(),
	/** Token usage during verification */
	tokens: z.object({
		/** Input tokens consumed */
		input: z.number(),
		/** Output tokens generated */
		output: z.number(),
	}),
	/** Task completion status at time of verification */
	tasks: z.object({
		/** Number of tasks completed successfully */
		completed: z.number(),
		/** Number of tasks that failed */
		failed: z.number(),
		/** Total number of tasks */
		total: z.number(),
	}),
});

export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/**
 * Verification index entry - reference to a verification report
 */
export interface VerificationIndexEntry {
	/** Unique run identifier */
	run_id: string;
	/** Path to the report file (relative to run directory) */
	report_path: string;
	/** ISO timestamp when report was created */
	created_at: string;
	/** Overall success status */
	overall_success: boolean;
	/** Number of gates that passed */
	gates_passed: number;
	/** Number of gates that failed */
	gates_failed: number;
}

/**
 * Verification index - tracks all verification reports for a run
 *
 * Stored in .milhouse/runs/<run-id>/verification-index.json
 */
export interface VerificationIndex {
	/** Run ID this index belongs to */
	run_id: string;
	/** Array of verification report references */
	reports: VerificationIndexEntry[];
}
