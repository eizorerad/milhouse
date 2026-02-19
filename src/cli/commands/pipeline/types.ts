/**
 * @fileoverview Milhouse Pipeline Command Types
 *
 * Type definitions for pipeline CLI commands (scan, validate, plan, consolidate, exec, verify).
 * These commands handle the Milhouse pipeline phases.
 *
 * @module cli/commands/pipeline/types
 *
 * @since 4.3.0
 */

import type { RuntimeOptions } from "../../runtime-options.ts";
import type {
	ConsolidateCommandResult,
	ExecCommandResult,
	PlanCommandResult,
	ScanCommandResult,
	ValidateCommandResult,
	VerificationIssue,
	VerifyCommandResult,
} from "../../types.ts";

/**
 * Options for the scan command
 */
export interface ScanOptions {
	/** Runtime options */
	options: RuntimeOptions;
	/** Focus area for the scan */
	scanFocus?: string;
}

/**
 * Result of the scan command
 */
export interface ScanResult extends ScanCommandResult {
	/** Run ID created for this scan */
	runId: string;
}

/**
 * Options for the validate command
 */
export interface ValidateOptions {
	/** Runtime options */
	options: RuntimeOptions;
}

/**
 * Result of the validate command
 */
export interface ValidateResult extends ValidateCommandResult {
	/** Path to updated Problem Brief */
	problemBriefPath?: string;
	/** Path to validation reports directory */
	reportsDir?: string;
}

/**
 * Options for the plan command
 */
export interface PlanOptions {
	/** Runtime options */
	options: RuntimeOptions;
}

/**
 * Result of the plan command
 */
export interface PlanResult extends PlanCommandResult {
	/** Paths to generated WBS files */
	wbsPaths: string[];
}

/**
 * Options for the consolidate command
 */
export interface ConsolidateOptions {
	/** Runtime options */
	options: RuntimeOptions;
}

/**
 * Result of the consolidate command
 */
export interface ConsolidateResult extends ConsolidateCommandResult {
	/** Dependency graph */
	graph?: Array<{
		id: string;
		dependsOn: string[];
		parallelGroup: number;
	}>;
}

/**
 * Options for the exec command
 */
export interface ExecOptions {
	/** Runtime options */
	options: RuntimeOptions;
	/** Specific task ID to execute */
	taskId?: string;
}

/**
 * Result of the exec command
 */
export interface ExecResult extends ExecCommandResult {
	/** Errors encountered during execution */
	errors?: string[];
	/** Remaining pending tasks */
	remainingTasks?: number;
}

/**
 * Options for the verify command
 */
export interface VerifyOptions {
	/** Runtime options */
	options: RuntimeOptions;
}

/**
 * Result of the verify command
 */
export interface VerifyResult extends VerifyCommandResult {
	/** Gate results */
	gateResults?: GateResult[];
	/** AI verification result */
	aiVerification?: {
		overallPass: boolean;
		recommendations: string[];
		regressionsFound: boolean;
		summary: string;
	};
}

/**
 * Gate result structure
 */
export interface GateResult {
	gate: string;
	passed: boolean;
	message: string;
	evidence: Array<{
		type: string;
		file?: string;
		lineStart?: number;
		lineEnd?: number;
		output?: string;
	}>;
}

/**
 * Re-export VerificationIssue for convenience
 */
export type { VerificationIssue };
