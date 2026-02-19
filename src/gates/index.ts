/**
 * Gates System - Central export module
 *
 * Provides:
 * - Type definitions and schemas for gate configurations
 * - Specialized gate implementations for quality verification
 * - Gate registry and factory for creating gates by type
 * - Gate runner for executing multiple gates
 *
 * Quality Gates:
 * - Evidence: No claims without file:lines or probe_id proof
 * - Diff Hygiene: Flag silent refactors, extra files, whitespace bombs
 * - Placeholder: Block TODO/mock/return true stubs
 * - Env Consistency: Require probes for db/cache/storage issues
 * - DoD: Definition of Done must be verifiable by commands
 */

// ============================================================================
// Type definitions and schemas
// ============================================================================
export {
	// Gate type schema and type
	GateTypeSchema,
	type GateType,
	// Type descriptions
	GATE_TYPE_DESCRIPTIONS,
	// Status types
	GateStatusSchema,
	type GateStatus,
	// Severity types
	GateSeveritySchema,
	type GateSeverity,
	// Violation types
	GateViolationSchema,
	type GateViolation,
	createGateViolation,
	// Result types
	GateResultSchema,
	type GateResult,
	createGateResult,
	// Input types
	GateInputSchema,
	type GateInput,
	// Config types
	GateConfigSchema,
	type GateConfig,
	DEFAULT_GATE_CONFIGS,
	getGateConfig,
	// Metrics types
	GateMetricsSchema,
	type GateMetrics,
	createEmptyGateMetrics,
	createMetricsFromGateResult,
	// Placeholder-specific types
	PlaceholderPatternSchema,
	type PlaceholderPattern,
	DEFAULT_PLACEHOLDER_PATTERNS,
	// Diff-specific types
	DiffChangeTypeSchema,
	type DiffChangeType,
	DiffAnalysisSchema,
	type DiffAnalysis,
	// Evidence-specific types
	EvidenceRequirementSchema,
	type EvidenceRequirement,
	// DoD-specific types
	DoDCheckResultSchema,
	type DoDCheckResult,
	// Env consistency-specific types
	EnvProbeRequirementSchema,
	type EnvProbeRequirement,
	// Gate run summary types
	GateRunSummarySchema,
	type GateRunSummary,
	createGateRunSummary,
	mergeGateRunSummaries,
	// Helper functions
	isValidGateType,
	getAllGateTypes,
	getEnabledGateTypes,
	countViolationsBySeverity,
	hasBlockingViolations,
	getViolationsBySeverity,
	getCriticalViolations,
	getHighViolations,
	// File helpers
	CODE_FILE_EXTENSIONS,
	isCodeFile,
	DEFAULT_EXCLUDE_PATTERNS,
	shouldExcludeFile,
} from "./types.ts";

// ============================================================================
// Evidence Gate
// ============================================================================
export {
	// Types
	type Claim,
	type ClaimType,
	CLAIM_PATTERNS,
	EVIDENCE_COMMENT_PATTERNS,
	type EvidenceAnalysisResult,
	// Main gate function
	runEvidenceGate,
	// Helper functions
	generateGateId as generateEvidenceGateId,
	extractClaims,
	extractEvidence,
	evidenceSatisfiesClaim,
	analyzeFileForClaims,
	getRequiredEvidenceType,
	getSeverityForClaimType,
	findCodeFiles,
	analyzeCommitMessage,
	analyzePRDescription,
	validateIssueEvidence,
	// Evidence creation helpers
	createFileEvidence,
	createProbeEvidence,
	createCommandEvidence,
	createLogEvidence,
	formatEvidence,
	hasEvidenceType,
	getEvidenceSummary,
} from "./evidence.ts";

// ============================================================================
// Diff Hygiene Gate
// ============================================================================
export {
	// Types
	type DiffHygieneViolationType,
	type DiffHygieneOptions,
	DEFAULT_DIFF_HYGIENE_OPTIONS,
	type DiffStats,
	type LineChange,
	type DiffHunk,
	// Main gate function
	runDiffHygieneGate,
	// Helper functions
	generateGateId as generateDiffHygieneGateId,
	parseDiffStats,
	getStagedDiffStats,
	getUnstagedDiffStats,
	getDiffStatsAgainstRef,
	getFileDiff,
	parseDiffHunks,
	isWhitespaceOnlyChange,
	analyzeHunkForWhitespace,
	detectSilentRename,
	categorizeChange,
	analyzeDiffs,
	getChangeDescription,
	getViolationSeverity as getDiffViolationSeverity,
	checkWhitespaceBomb,
	checkSilentRefactor,
	checkExtraFile,
	checkLargeDiff,
	checkFileDiffHygiene,
	getDiffHygieneSummary,
	formatDiffHygieneSummary,
} from "./diff-hygiene.ts";

// ============================================================================
// Placeholder Gate
// ============================================================================
export {
	// Types
	type PlaceholderMatch,
	type PlaceholderGateOptions,
	DEFAULT_PLACEHOLDER_OPTIONS,
	// Main gate function
	runPlaceholderGate,
	// Helper functions
	generateGateId as generatePlaceholderGateId,
	isTestFile,
	compilePattern,
	findPlaceholdersInContent,
	getPatternForContext,
	getSeverityForMatch,
	getSuggestionForMatch,
	findCodeFilesRecursive,
	checkFileForPlaceholders,
	checkContentForPlaceholders,
	getPlaceholderSummary,
	formatPlaceholderSummary,
	createPlaceholderPattern,
	mergePatterns,
} from "./placeholder.ts";

// ============================================================================
// Environment Consistency Gate
// ============================================================================
export {
	// Types
	type EnvComponentType,
	ENV_COMPONENT_TO_PROBE,
	ENV_COMPONENT_KEYWORDS,
	type EnvConsistencyOptions,
	DEFAULT_ENV_CONSISTENCY_OPTIONS,
	type IssueEnvAnalysis,
	// Main gate function
	runEnvConsistencyGate,
	// Helper functions
	generateGateId as generateEnvConsistencyGateId,
	detectEnvComponents,
	getRequiredProbes,
	loadIssues,
	getProbeResults,
	hasProbeRun,
	analyzeIssue,
	getSeverityForMissingProbe,
	createEnvProbeRequirement,
	checkIssueEnvConsistency,
	getEnvConsistencySummary,
	formatEnvConsistencySummary,
	getProbeRecommendation,
} from "./env-consistency.ts";

// ============================================================================
// Definition of Done (DoD) Gate
// ============================================================================
export {
	// Types
	type DoDGateOptions,
	DEFAULT_DOD_OPTIONS,
	type TaskDoDAnalysis,
	// Main gate function
	runDoDGate,
	// Helper functions
	generateGateId as generateDoDGateId,
	loadTasks,
	isVerifiableCriterion,
	executeCheckCommand,
	truncateOutput,
	analyzeTaskDoD,
	getSeverityForDoDViolation,
	createDoDViolation,
	checkTaskDoD,
	getDoDSummary,
	formatDoDSummary,
	createDoDCriterion,
	validateCheckCommand,
	suggestCheckCommand,
} from "./dod.ts";

// ============================================================================
// Gate Registry and Runner
// ============================================================================

import { runDiffHygieneGate } from "./diff-hygiene.ts";
import { runDoDGate } from "./dod.ts";
import { runEnvConsistencyGate } from "./env-consistency.ts";
import { runEvidenceGate } from "./evidence.ts";
import { runPlaceholderGate } from "./placeholder.ts";
import {
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateRunSummary,
	type GateSeverity,
	type GateType,
	createGateRunSummary,
	getAllGateTypes,
	getGateConfig,
} from "./types.ts";

/**
 * Gate runner function type
 */
export type GateRunner = (
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
) => Promise<GateResult>;

/**
 * Gate runners - map of gate types to their runner functions
 */
export const GATE_RUNNERS: Record<GateType, GateRunner> = {
	evidence: runEvidenceGate,
	"diff-hygiene": runDiffHygieneGate,
	placeholder: runPlaceholderGate,
	"env-consistency": runEnvConsistencyGate,
	dod: runDoDGate,
};

/**
 * Registry entry for a gate
 */
export interface GateRegistryEntry {
	/** Gate type identifier */
	gateType: GateType;
	/** Gate runner function */
	run: GateRunner;
	/** Human-readable name */
	name: string;
	/** Description of what the gate checks */
	description: string;
	/** Default configuration */
	defaultConfig: GateConfig;
}

/**
 * Gate registry - provides metadata and runners for all gates
 */
export const GATE_REGISTRY: Record<GateType, GateRegistryEntry> = {
	evidence: {
		gateType: "evidence",
		run: runEvidenceGate,
		name: "Evidence Gate",
		description: "Verifies all claims have supporting evidence (file:lines or probe_id)",
		defaultConfig: getGateConfig("evidence"),
	},
	"diff-hygiene": {
		gateType: "diff-hygiene",
		run: runDiffHygieneGate,
		name: "Diff Hygiene Gate",
		description: "Flags silent refactors, extra files, and whitespace bombs",
		defaultConfig: getGateConfig("diff-hygiene"),
	},
	placeholder: {
		gateType: "placeholder",
		run: runPlaceholderGate,
		name: "Placeholder Gate",
		description: "Blocks TODO/FIXME comments, mock returns, and stub implementations",
		defaultConfig: getGateConfig("placeholder"),
	},
	"env-consistency": {
		gateType: "env-consistency",
		run: runEnvConsistencyGate,
		name: "Environment Consistency Gate",
		description: "Requires probes for database, cache, and storage issues",
		defaultConfig: getGateConfig("env-consistency"),
	},
	dod: {
		gateType: "dod",
		run: runDoDGate,
		name: "Definition of Done Gate",
		description: "Ensures all acceptance criteria are verifiable by commands",
		defaultConfig: getGateConfig("dod"),
	},
};

/**
 * Get gate registry entry by type
 */
export function getGateRegistryEntry(gateType: GateType): GateRegistryEntry {
	return GATE_REGISTRY[gateType];
}

/**
 * Check if a gate type is registered
 */
export function isGateRegistered(gateType: string): gateType is GateType {
	return gateType in GATE_REGISTRY;
}

/**
 * Run a single gate by type
 *
 * @param gateType - The gate type to run
 * @param input - Gate input configuration
 * @param configOverrides - Optional configuration overrides
 * @returns The gate result
 */
export async function runGate(
	gateType: GateType,
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const runner = GATE_RUNNERS[gateType];
	if (!runner) {
		throw new Error(`Unknown gate type: ${gateType}`);
	}
	return runner(input, configOverrides);
}

/**
 * Gate dispatch configuration - options for running multiple gates
 */
export interface GateDispatchConfig {
	/** Maximum concurrent gates */
	maxConcurrent: number;
	/** Whether to stop on first failure */
	stopOnFailure: boolean;
	/** Whether to stop on blocking violations (CRITICAL/HIGH) */
	stopOnBlocking: boolean;
	/** Gate types to run (empty = all enabled gates) */
	gateTypes?: GateType[];
	/** Custom configurations per gate type */
	gateConfigs?: Partial<Record<GateType, Partial<GateConfig>>>;
	/** Timeout for all gates in milliseconds */
	timeoutMs?: number;
}

/**
 * Default gate dispatch configuration
 */
export const DEFAULT_DISPATCH_CONFIG: GateDispatchConfig = {
	maxConcurrent: 3,
	stopOnFailure: false,
	stopOnBlocking: true,
	gateTypes: undefined, // All enabled gates
};

/**
 * Gate dispatch result
 */
export interface GateDispatchResult {
	/** Run summary with all results */
	summary: GateRunSummary;
	/** Whether all gates passed */
	passed: boolean;
	/** Gate that caused early stop (if any) */
	stoppedBy?: GateType;
	/** Results per gate type */
	resultsByType: Map<GateType, GateResult>;
}

/**
 * Run multiple gates with configuration
 *
 * @param input - Gate input configuration
 * @param config - Dispatch configuration
 * @returns Dispatch result with all gate results and summary
 */
export async function dispatchGates(
	input: GateInput,
	config: Partial<GateDispatchConfig> = {},
): Promise<GateDispatchResult> {
	const startTime = Date.now();
	const runId = `gate-run-${startTime}-${Math.random().toString(36).substring(2, 8)}`;
	const mergedConfig: GateDispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, ...config };

	// Determine which gates to run
	const allTypes = getAllGateTypes();
	const typesToRun = mergedConfig.gateTypes ?? allTypes;

	// Filter to only enabled gates
	const enabledTypes = typesToRun.filter((type) => {
		const gateConfig = mergedConfig.gateConfigs?.[type] ?? getGateConfig(type);
		return gateConfig.enabled;
	});

	const results: GateResult[] = [];
	const resultsByType = new Map<GateType, GateResult>();
	let stoppedBy: GateType | undefined;

	// Run gates in batches
	for (let i = 0; i < enabledTypes.length; i += mergedConfig.maxConcurrent) {
		// Check if we should stop
		if (stoppedBy) break;

		const batch = enabledTypes.slice(i, i + mergedConfig.maxConcurrent);

		const batchPromises = batch.map(async (gateType) => {
			const gateConfig = mergedConfig.gateConfigs?.[gateType];
			try {
				return await runGate(gateType, input, gateConfig);
			} catch (error) {
				// Return error result
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					gate_id: `${gateType}-error-${Date.now()}`,
					gate_type: gateType,
					passed: false,
					message: `Gate execution error: ${errorMessage}`,
					violations: [
						{
							id: "gate-error",
							title: "Gate execution error",
							description: errorMessage,
							severity: "CRITICAL" as GateSeverity,
							metadata: {},
						},
					],
					evidence: [],
					timestamp: new Date().toISOString(),
					files_checked: 0,
					items_checked: 0,
				} as GateResult;
			}
		});

		const batchResults = await Promise.all(batchPromises);

		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j];
			const gateType = batch[j];

			results.push(result);
			resultsByType.set(gateType, result);

			// Check stop conditions
			if (mergedConfig.stopOnFailure && !result.passed) {
				stoppedBy = gateType;
				break;
			}

			if (mergedConfig.stopOnBlocking) {
				const hasBlocking = result.violations.some(
					(v) => v.severity === "CRITICAL" || v.severity === "HIGH",
				);
				if (hasBlocking) {
					stoppedBy = gateType;
					break;
				}
			}
		}
	}

	// Create summary
	const summary = createGateRunSummary(runId, results, new Date(startTime).toISOString());

	return {
		summary,
		passed: summary.overall_pass,
		stoppedBy,
		resultsByType,
	};
}

/**
 * Run all gates for a task verification
 *
 * Convenience function that runs all gates with sensible defaults for
 * verifying task completion.
 *
 * @param workDir - Working directory
 * @param taskIds - Optional task IDs to scope the checks
 * @param targets - Optional target files to check
 * @returns Gate dispatch result
 */
export async function runAllGates(
	workDir: string,
	taskIds?: string[],
	targets?: string[],
): Promise<GateDispatchResult> {
	const input: GateInput = {
		workDir,
		targets: targets ?? [],
		taskIds: taskIds ?? [],
		options: {},
		strict: false,
		timeout_ms: 120000,
		verbose: false,
	};

	return dispatchGates(input, {
		stopOnBlocking: true,
		stopOnFailure: false,
	});
}

/**
 * Run gates in strict mode
 *
 * All gates must pass with zero violations for the result to pass.
 *
 * @param workDir - Working directory
 * @param taskIds - Optional task IDs to scope the checks
 * @param targets - Optional target files to check
 * @returns Gate dispatch result
 */
export async function runGatesStrict(
	workDir: string,
	taskIds?: string[],
	targets?: string[],
): Promise<GateDispatchResult> {
	const input: GateInput = {
		workDir,
		targets: targets ?? [],
		taskIds: taskIds ?? [],
		options: {},
		strict: true,
		timeout_ms: 120000,
		verbose: false,
	};

	return dispatchGates(input, {
		stopOnFailure: true,
		stopOnBlocking: true,
		gateConfigs: {
			evidence: { strict: true },
			"diff-hygiene": { strict: true },
			placeholder: { strict: true },
			"env-consistency": { strict: true },
			dod: { strict: true },
		},
	});
}

/**
 * Run specific gates only
 *
 * @param workDir - Working directory
 * @param gateTypes - Gate types to run
 * @param taskIds - Optional task IDs to scope the checks
 * @param targets - Optional target files to check
 * @returns Gate dispatch result
 */
export async function runSpecificGates(
	workDir: string,
	gateTypes: GateType[],
	taskIds?: string[],
	targets?: string[],
): Promise<GateDispatchResult> {
	const input: GateInput = {
		workDir,
		targets: targets ?? [],
		taskIds: taskIds ?? [],
		options: {},
		strict: false,
		timeout_ms: 120000,
		verbose: false,
	};

	return dispatchGates(input, {
		gateTypes,
		stopOnBlocking: true,
	});
}

/**
 * Format gate dispatch result as markdown
 *
 * @param result - Gate dispatch result
 * @returns Markdown summary
 */
export function formatGateResultsAsMarkdown(result: GateDispatchResult): string {
	const lines: string[] = [];
	const { summary } = result;

	lines.push("# Gate Results Summary");
	lines.push("");

	// Overall status
	const statusEmoji = result.passed ? "PASS" : "FAIL";
	lines.push(`**Overall Status:** ${statusEmoji}`);
	lines.push("");

	if (result.stoppedBy) {
		lines.push(`**Stopped by:** ${result.stoppedBy}`);
		lines.push("");
	}

	// Overview table
	lines.push("## Results");
	lines.push("| Gate | Status | Violations | Duration |");
	lines.push("|------|--------|------------|----------|");

	for (const gateResult of summary.results) {
		const status = gateResult.passed ? "PASS" : "FAIL";
		const violations = gateResult.violations.length;
		const duration = gateResult.duration_ms ? `${gateResult.duration_ms}ms` : "-";
		lines.push(`| ${gateResult.gate_type} | ${status} | ${violations} | ${duration} |`);
	}
	lines.push("");

	// Summary statistics
	lines.push("## Summary");
	lines.push(`- Total gates: ${summary.gates_run}`);
	lines.push(`- Passed: ${summary.gates_passed}`);
	lines.push(`- Failed: ${summary.gates_failed}`);
	lines.push(`- With warnings: ${summary.gates_warned}`);
	lines.push(`- Total violations: ${summary.total_violations}`);
	if (summary.duration_ms) {
		lines.push(`- Total duration: ${summary.duration_ms}ms`);
	}
	lines.push("");

	// Violations by severity
	if (summary.total_violations > 0) {
		lines.push("### Violations by Severity");
		lines.push(`- CRITICAL: ${summary.violations_by_severity.CRITICAL}`);
		lines.push(`- HIGH: ${summary.violations_by_severity.HIGH}`);
		lines.push(`- MEDIUM: ${summary.violations_by_severity.MEDIUM}`);
		lines.push(`- LOW: ${summary.violations_by_severity.LOW}`);
		lines.push(`- WARNING: ${summary.violations_by_severity.WARNING}`);
		lines.push(`- INFO: ${summary.violations_by_severity.INFO}`);
		lines.push("");
	}

	// Critical and high violations
	const criticalHighViolations = summary.results.flatMap((r) =>
		r.violations.filter((v) => v.severity === "CRITICAL" || v.severity === "HIGH"),
	);

	if (criticalHighViolations.length > 0) {
		lines.push("## Critical and High Severity Violations");
		for (const violation of criticalHighViolations) {
			lines.push(`### [${violation.severity}] ${violation.title}`);
			lines.push(violation.description);
			if (violation.suggestion) {
				lines.push(`**Suggestion:** ${violation.suggestion}`);
			}
			if (violation.file) {
				lines.push(`**File:** ${violation.file}${violation.line ? `:${violation.line}` : ""}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Get quick summary of gate results
 *
 * @param result - Gate dispatch result
 * @returns Short summary string
 */
export function getGateResultSummary(result: GateDispatchResult): string {
	const { summary } = result;
	const status = result.passed ? "PASSED" : "FAILED";

	return (
		`Gates ${status}: ${summary.gates_passed}/${summary.gates_run} passed, ` +
		`${summary.total_violations} violations ` +
		`(${summary.violations_by_severity.CRITICAL} critical, ${summary.violations_by_severity.HIGH} high)`
	);
}
