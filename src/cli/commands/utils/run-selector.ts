/**
 * Run Selector Utility
 *
 * Provides utilities for selecting and resolving run IDs.
 * This module enables explicit run ID specification via --run-id
 * to avoid race conditions when multiple milhouse processes run in parallel.
 *
 * @module cli/commands/utils/run-selector
 * @since 5.1.0
 */

import { select } from "@inquirer/prompts";
import { listRuns, loadRunMeta } from "../../../state/runs.ts";
import type { RunMeta, RunPhase } from "../../../state/types.ts";

/**
 * Result of run selection
 */
export interface RunSelectionResult {
	/** The resolved full run ID */
	runId: string;
	/** The run metadata */
	runMeta: RunMeta;
}

/**
 * Options for run selection
 */
export interface SelectRunOptions {
	/** Allow creating a new run if none exists */
	allowCreate?: boolean;
	/** Scope for new run creation */
	scope?: string;
	/** Require run to be in one of these phases */
	requirePhase?: RunPhase[];
}

/**
 * Resolve a partial run ID to a full run ID
 *
 * Supports matching by:
 * - Full ID: "run-20260128-after-ujb8" → "run-20260128-after-ujb8"
 * - Suffix: "after-ujb8" → "run-20260128-after-ujb8"
 * - Random part: "ujb8" → "run-20260128-after-ujb8"
 *
 * @param partialId - Partial or full run ID to resolve
 * @param workDir - Working directory
 * @returns Full run ID if found
 * @throws Error if no matching run found or multiple matches
 *
 * @example
 * ```typescript
 * // Full ID match
 * resolveRunId("run-20260128-after-ujb8", workDir) // "run-20260128-after-ujb8"
 *
 * // Partial suffix match
 * resolveRunId("after-ujb8", workDir) // "run-20260128-after-ujb8"
 *
 * // Random part match
 * resolveRunId("ujb8", workDir) // "run-20260128-after-ujb8"
 * ```
 */
export function resolveRunId(partialId: string, workDir: string): string {
	const runs = listRuns(workDir);

	if (runs.length === 0) {
		throw new Error(
			`No runs found. Start with: milhouse scan --scope "your scope"`,
		);
	}

	// Try exact match first
	const exactMatch = runs.find((r) => r.id === partialId);
	if (exactMatch) {
		return exactMatch.id;
	}

	// Try suffix match (e.g., "after-ujb8" matches "run-20260128-after-ujb8")
	const suffixMatches = runs.filter((r) => r.id.endsWith(`-${partialId}`));
	if (suffixMatches.length === 1) {
		return suffixMatches[0].id;
	}
	if (suffixMatches.length > 1) {
		const matchIds = suffixMatches.map((r) => r.id).join(", ");
		throw new Error(
			`Ambiguous run ID "${partialId}" matches multiple runs: ${matchIds}. Please be more specific.`,
		);
	}

	// Try contains match (e.g., "ujb8" matches "run-20260128-after-ujb8")
	const containsMatches = runs.filter((r) => r.id.includes(partialId));
	if (containsMatches.length === 1) {
		return containsMatches[0].id;
	}
	if (containsMatches.length > 1) {
		const matchIds = containsMatches.map((r) => r.id).join(", ");
		throw new Error(
			`Ambiguous run ID "${partialId}" matches multiple runs: ${matchIds}. Please be more specific.`,
		);
	}

	// No match found
	const availableRuns = runs.map((r) => `  • ${r.id}`).join("\n");
	throw new Error(
		`Run not found: "${partialId}"\n\nAvailable runs:\n${availableRuns}`,
	);
}

/**
 * Select a run based on explicit ID, interactive prompt, or single active run
 *
 * Selection logic:
 * 1. If explicit run ID provided, resolve and use it
 * 2. If only one eligible run exists, use it automatically
 * 3. If multiple runs exist, prompt for selection (or throw if non-interactive)
 *
 * @param explicitRunId - Explicit run ID from --run-id flag (full or partial)
 * @param workDir - Working directory
 * @param options - Selection options
 * @returns Selected run ID and metadata
 * @throws Error if no eligible runs or selection fails
 *
 * @example
 * ```typescript
 * // With explicit run ID
 * const { runId, runMeta } = await selectOrRequireRun("ujb8", workDir);
 *
 * // Auto-select single run
 * const { runId, runMeta } = await selectOrRequireRun(undefined, workDir);
 *
 * // With phase filter
 * const { runId, runMeta } = await selectOrRequireRun(undefined, workDir, {
 *   requirePhase: ["validate", "plan"],
 * });
 * ```
 */
export async function selectOrRequireRun(
	explicitRunId: string | undefined,
	workDir: string,
	options?: SelectRunOptions,
): Promise<RunSelectionResult> {
	// 1. If explicit run ID provided, resolve and use it
	if (explicitRunId) {
		const runId = resolveRunId(explicitRunId, workDir);
		const runMeta = loadRunMeta(runId, workDir);
		if (!runMeta) {
			throw new Error(`Run metadata not found for: ${runId}`);
		}

		// Validate phase if required
		if (options?.requirePhase && !options.requirePhase.includes(runMeta.phase)) {
			const allowedPhases = options.requirePhase.join(", ");
			throw new Error(
				`Run "${runId}" is in phase "${runMeta.phase}", but this command requires phase: ${allowedPhases}`,
			);
		}

		return { runId, runMeta };
	}

	// 2. Get all runs
	const allRuns = listRuns(workDir);

	if (allRuns.length === 0) {
		throw new Error(
			`No runs found. Start with: milhouse scan --scope "your scope"`,
		);
	}

	// 3. Filter by phase if required
	let eligibleRuns = allRuns;
	if (options?.requirePhase) {
		eligibleRuns = allRuns.filter((r) => options.requirePhase!.includes(r.phase));
	}

	// 4. If no eligible runs, error
	if (eligibleRuns.length === 0) {
		const allowedPhases = options?.requirePhase?.join(", ") || "any";
		throw new Error(
			`No eligible runs found (required phase: ${allowedPhases}). Start with: milhouse scan --scope "your scope"`,
		);
	}

	// 5. If exactly one eligible run, use it automatically
	if (eligibleRuns.length === 1) {
		const runMeta = loadRunMeta(eligibleRuns[0].id, workDir);
		if (!runMeta) {
			throw new Error(`Run metadata not found for: ${eligibleRuns[0].id}`);
		}
		console.log(`Using run: ${runMeta.id}${runMeta.scope ? ` (${runMeta.scope})` : ""}`);
		return { runId: runMeta.id, runMeta };
	}

	// 6. Multiple runs - prompt for selection
	const runMetas = eligibleRuns
		.map((r) => loadRunMeta(r.id, workDir))
		.filter((m): m is RunMeta => m !== null);

	const selectedId = await promptRunSelection(
		runMetas,
		"Multiple runs available. Which one do you want to use?",
	);

	const selectedMeta = loadRunMeta(selectedId, workDir);
	if (!selectedMeta) {
		throw new Error(`Run metadata not found for: ${selectedId}`);
	}

	return { runId: selectedId, runMeta: selectedMeta };
}

/**
 * Interactive run selection with scope and status display
 *
 * Displays a list of available runs with their phase, issue count, scope,
 * and age. User can select a run using arrow keys and Enter.
 *
 * @param runs - Array of run metadata to choose from
 * @param message - Prompt message to display
 * @returns Selected run ID
 *
 * @example
 * ```typescript
 * const runId = await promptRunSelection(runs, "Select a run:");
 * // User sees:
 * // ? Select a run:
 * // ❯ run-20260128-after-ujb8 [VALIDATE] - 3 issues - scope - 2 hours ago
 * //   run-20260127-before-xyz1 [SCAN] - 5 issues - other scope - 1 day ago
 * ```
 */
export async function promptRunSelection(
	runs: RunMeta[],
	message = "Select a run:",
): Promise<string> {
	const choices = runs.map((run) => ({
		name: formatRunChoice(run),
		value: run.id,
		description: run.scope || undefined,
	}));

	return select({
		message,
		choices,
	});
}

/**
 * Format a run choice for display
 *
 * @param run - Run metadata
 * @returns Formatted string for display
 *
 * @internal
 */
export function formatRunChoice(run: RunMeta): string {
	const age = formatRelativeTime(run.created_at);
	const phase = run.phase.toUpperCase();
	const issues = run.issues_found > 0 ? `${run.issues_found} issues` : "no issues";
	const scope = run.scope ? ` - ${run.scope}` : "";

	return `${run.id} [${phase}] - ${issues}${scope} - ${age}`;
}

/**
 * Format an ISO date string as relative time
 *
 * @param isoDate - ISO 8601 date string
 * @returns Human-readable relative time (e.g., "2 hours ago", "3 days ago")
 *
 * @internal
 */
export function formatRelativeTime(isoDate: string): string {
	const date = new Date(isoDate);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	const seconds = Math.floor(diffMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);

	if (weeks > 0) {
		return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
	}
	if (days > 0) {
		return days === 1 ? "1 day ago" : `${days} days ago`;
	}
	if (hours > 0) {
		return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	}
	if (minutes > 0) {
		return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	}
	return "just now";
}
