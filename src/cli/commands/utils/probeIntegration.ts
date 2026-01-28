/**
 * Probe Integration Utility Module
 *
 * Encapsulates probe execution logic for use in validate.ts and plan.ts.
 * Provides functions to detect, run, and convert probes to evidence.
 */

import {
	type InspectorProbeType,
	type ProbeDispatchResult,
	detectApplicableProbes,
	dispatchProbes,
} from "../../../probes/index.ts";
import {
	type ProbeResult as FullProbeResult,
	convertProbeResultToEvidence,
} from "../../../probes/types.ts";
import { loadProbeResults, saveProbeResult } from "../../../state/probes.ts";
import type { Evidence, Issue } from "../../../state/types.ts";
import { logDebug, logInfo, logWarn } from "../../../ui/logger.ts";

// Use full probe result type (from probes/types.ts) for dispatch results
type ProbeResult = FullProbeResult;

/**
 * Result of running applicable probes
 */
export interface ProbeExecutionResult {
	/** Whether probes executed successfully */
	success: boolean;
	/** Applicable probes that were detected */
	applicableProbes: InspectorProbeType[];
	/** Results from dispatch (null if no probes ran) */
	dispatchResult: ProbeDispatchResult | null;
	/** Error message if execution failed */
	error?: string;
}

/**
 * Options for running probes
 */
export interface RunProbesOptions {
	/** Force read-only mode for all probes */
	forceReadOnly?: boolean;
	/** Timeout per probe in milliseconds */
	timeoutMs?: number;
	/** Maximum concurrent probes */
	maxConcurrent?: number;
	/** Continue if individual probes fail */
	continueOnFailure?: boolean;
}

/**
 * Run applicable probes for a working directory
 *
 * Detects which probes are relevant for the project and executes them.
 * Errors are handled gracefully - probe failures log warnings but don't throw.
 *
 * @param workDir - Working directory to probe
 * @param options - Optional execution options
 * @returns Probe execution result with all probe data
 */
export async function runApplicableProbes(
	workDir: string,
	options: RunProbesOptions = {},
): Promise<ProbeExecutionResult> {
	try {
		// Detect applicable probes for this project
		const applicableProbes = detectApplicableProbes(workDir);

		if (applicableProbes.length === 0) {
			logDebug("No applicable probes detected for this project");
			return {
				success: true,
				applicableProbes: [],
				dispatchResult: null,
			};
		}

		logInfo(
			`Detected ${applicableProbes.length} applicable probes: ${applicableProbes.join(", ")}`,
		);

		// Dispatch probes with configured options
		const dispatchResult = await dispatchProbes(workDir, {
			probeTypes: applicableProbes,
			forceReadOnly: options.forceReadOnly ?? true,
			timeoutMs: options.timeoutMs,
			maxConcurrent: options.maxConcurrent ?? 4,
			continueOnFailure: options.continueOnFailure ?? true,
		});

		// Save each probe result
		for (const result of dispatchResult.results) {
			try {
				saveProbeResult(result, workDir);
			} catch (saveError) {
				logWarn(`Failed to save probe result for ${result.probe_type}: ${saveError}`);
			}
		}

		// Log summary
		const { summary } = dispatchResult;
		logInfo(
			`Probes completed: ${summary.succeeded}/${summary.total} succeeded, ` +
				`${summary.totalFindings} findings (${summary.findingsBySeverity.CRITICAL || 0} critical, ` +
				`${summary.findingsBySeverity.HIGH || 0} high)`,
		);

		return {
			success: true,
			applicableProbes,
			dispatchResult,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logWarn(`Probe execution failed (non-blocking): ${errorMessage}`);
		return {
			success: false,
			applicableProbes: [],
			dispatchResult: null,
			error: errorMessage,
		};
	}
}

/**
 * Convert probe results to evidence array
 *
 * @param probeResults - Array of probe results to convert
 * @returns Array of evidence objects
 */
export function convertProbeResultsToEvidence(probeResults: ProbeResult[]): Evidence[] {
	const evidence: Evidence[] = [];

	for (const result of probeResults) {
		try {
			const converted = convertProbeResultToEvidence(result);
			evidence.push(converted);
		} catch (error) {
			logWarn(`Failed to convert probe result to evidence: ${error}`);
		}
	}

	return evidence;
}

/**
 * Attach probe evidence to an issue
 *
 * Converts probe results to evidence and appends them to the issue's evidence array.
 * Returns a new issue object (immutable update).
 *
 * @param issue - The issue to attach evidence to
 * @param probeResults - Probe results to convert and attach
 * @returns New issue with probe evidence attached
 */
export function attachProbeEvidenceToIssue(issue: Issue, probeResults: ProbeResult[]): Issue {
	const probeEvidence = convertProbeResultsToEvidence(probeResults);

	if (probeEvidence.length === 0) {
		return issue;
	}

	return {
		...issue,
		evidence: [...(issue.evidence || []), ...probeEvidence],
	};
}

/**
 * Load existing probe results for an issue
 *
 * Checks if probe results already exist from a previous validation run.
 * Converts simple probe results (from state/types.ts) to full results.
 *
 * @param workDir - Working directory
 * @param probeTypes - Types of probes to load results for
 * @returns Array of existing probe results
 */
export function loadExistingProbeResults(
	workDir: string,
	probeTypes: InspectorProbeType[],
): ProbeResult[] {
	const results: ProbeResult[] = [];

	for (const probeType of probeTypes) {
		try {
			const typeResults = loadProbeResults(probeType, workDir);
			// Convert simple probe results to full format
			for (const simpleResult of typeResults) {
				const fullResult: ProbeResult = {
					probe_id: simpleResult.probe_id,
					probe_type: simpleResult.probe_type as ProbeResult["probe_type"],
					success: simpleResult.success,
					timestamp: simpleResult.timestamp,
					read_only: simpleResult.read_only,
					output: simpleResult.output,
					error: simpleResult.error,
					duration_ms: simpleResult.duration_ms,
					findings: [], // Simple results don't have findings
				};
				results.push(fullResult);
			}
		} catch (error) {
			logDebug(`Failed to load probe results for ${probeType}: ${error}`);
		}
	}

	return results;
}

/**
 * Check if probe results exist for a working directory
 *
 * @param workDir - Working directory to check
 * @returns True if any probe results exist
 */
export function hasExistingProbeResults(workDir: string): boolean {
	const probeTypes: InspectorProbeType[] = [
		"compose",
		"postgres",
		"redis",
		"storage",
		"deps",
		"repro",
	];

	for (const probeType of probeTypes) {
		try {
			const results = loadProbeResults(probeType, workDir);
			if (results.length > 0) {
				return true;
			}
		} catch {
			// Ignore errors
		}
	}

	return false;
}

/**
 * Format probe results as a string for inclusion in prompts
 *
 * @param dispatchResult - Result from dispatchProbes
 * @returns Formatted string summarizing probe findings
 */
export function formatProbeResultsForPrompt(dispatchResult: ProbeDispatchResult): string {
	const lines: string[] = [];
	const { results, summary } = dispatchResult;

	lines.push("## Infrastructure Probe Results");
	lines.push("");
	lines.push(
		`**Summary**: ${summary.succeeded}/${summary.total} probes passed, ${summary.totalFindings} total findings`,
	);
	lines.push("");

	if (summary.findingsBySeverity.CRITICAL > 0) {
		lines.push(`- **CRITICAL**: ${summary.findingsBySeverity.CRITICAL}`);
	}
	if (summary.findingsBySeverity.HIGH > 0) {
		lines.push(`- **HIGH**: ${summary.findingsBySeverity.HIGH}`);
	}
	if (summary.findingsBySeverity.MEDIUM > 0) {
		lines.push(`- **MEDIUM**: ${summary.findingsBySeverity.MEDIUM}`);
	}
	if (summary.findingsBySeverity.LOW > 0) {
		lines.push(`- **LOW**: ${summary.findingsBySeverity.LOW}`);
	}
	lines.push("");

	// Include key findings from each probe
	for (const result of results) {
		if (result.findings.length > 0) {
			lines.push(`### ${result.probe_type.toUpperCase()} Probe`);
			lines.push(`Status: ${result.success ? "PASS" : "FAIL"}`);
			lines.push("");

			// Show top findings (limit to avoid overwhelming the prompt)
			const topFindings = result.findings.slice(0, 5);
			for (const finding of topFindings) {
				lines.push(`- **[${finding.severity}]** ${finding.title}: ${finding.description}`);
				if (finding.file) {
					lines.push(`  Location: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
				}
				if (finding.suggestion) {
					lines.push(`  Suggestion: ${finding.suggestion}`);
				}
			}

			if (result.findings.length > 5) {
				lines.push(`... and ${result.findings.length - 5} more findings`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}
