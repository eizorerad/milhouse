/**
 * Resume output validation — ensures phase outputs exist before skipping phases.
 *
 * When resuming a pipeline run, the orchestrator determines which phase to
 * resume from based on run metadata. This module validates that all prior
 * phases' outputs actually exist and contain valid data. If not, it identifies
 * the earliest phase with missing outputs so the pipeline can fall back.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraphForRun } from "../state/graph.ts";
import { loadIssuesForRun } from "../state/issues.ts";
import { getRunStateDir } from "../state/runs.ts";
import { loadTasksForRun } from "../state/tasks.ts";
import { STATE_FILES } from "../state/types.ts";

/** Default phase order (must match orchestrator) */
export const PHASE_ORDER: string[] = ["scan", "validate", "plan", "consolidate", "exec", "verify"];

/** Validation result returned by validateResumeOutputs */
export interface ResumeValidationResult {
	valid: boolean;
	firstInvalidPhase?: string;
	errors: string[];
}

/**
 * Phase output requirement checker.
 * Each function returns an error message if the requirement is NOT met, or null if OK.
 */
type PhaseOutputCheck = (runId: string, workDir: string) => string | null;

/** Map of phase names to the checks that must pass after that phase completes */
export const PHASE_OUTPUT_REQUIREMENTS: Record<string, PhaseOutputCheck[]> = {
	scan: [
		(runId, workDir) => {
			const issues = loadIssuesForRun(runId, workDir);
			if (issues.length === 0) return "issues.json is missing or empty after scan phase";
			return null;
		},
	],
	validate: [
		(runId, workDir) => {
			const issues = loadIssuesForRun(runId, workDir);
			if (issues.length === 0) return "issues.json is missing or empty after validate phase";
			return null;
		},
		(runId, workDir) => {
			const issues = loadIssuesForRun(runId, workDir);
			const hasValidated = issues.some((i) => i.status !== "UNVALIDATED");
			if (!hasValidated) return "issues.json contains only UNVALIDATED issues after validate phase";
			return null;
		},
	],
	plan: [
		(runId, workDir) => {
			const tasks = loadTasksForRun(runId, workDir);
			if (tasks.length === 0) return "tasks.json is missing or empty after plan phase";
			return null;
		},
	],
	consolidate: [
		(runId, workDir) => {
			const tasks = loadTasksForRun(runId, workDir);
			if (tasks.length === 0) return "tasks.json is missing or empty after consolidate phase";
			return null;
		},
		(runId, workDir) => {
			const graph = loadGraphForRun(runId, workDir);
			if (graph.length === 0) return "graph.json is missing or empty after consolidate phase";
			return null;
		},
	],
	exec: [
		(runId, workDir) => {
			const tasks = loadTasksForRun(runId, workDir);
			const hasDone = tasks.some((t) => t.status === "done");
			if (!hasDone) return "tasks.json contains no completed tasks after exec phase";
			return null;
		},
	],
	verify: [
		(runId, workDir) => {
			const stateDir = getRunStateDir(runId, workDir);
			const filePath = join(stateDir, STATE_FILES.verification);
			if (!existsSync(filePath)) {
				return "verification.json is missing after verify phase";
			}
			try {
				const data = JSON.parse(readFileSync(filePath, "utf-8"));
				if (typeof data.overall_pass !== "boolean") {
					return "verification.json is missing overall_pass boolean after verify phase";
				}
			} catch {
				return "verification.json contains invalid JSON after verify phase";
			}
			return null;
		},
	],
};

/**
 * Validate that all prior phase outputs exist and are valid for a resume.
 *
 * Given a `resumePhase`, checks all phases that come BEFORE it in PHASE_ORDER.
 * Returns { valid: true } if all prior outputs exist, or { valid: false }
 * with the earliest invalid phase and accumulated error messages.
 *
 * @param runId - The run ID to validate
 * @param resumePhase - The phase we intend to resume from
 * @param workDir - Working directory
 */
export function validateResumeOutputs(
	runId: string,
	resumePhase: string,
	workDir: string,
): ResumeValidationResult {
	const resumeIndex = PHASE_ORDER.indexOf(resumePhase);

	// If resuming from the first phase or an unknown phase, nothing to validate
	if (resumeIndex <= 0) {
		return { valid: true, errors: [] };
	}

	const errors: string[] = [];
	let firstInvalidPhase: string | undefined;

	// Check all phases before the resume phase
	for (let i = 0; i < resumeIndex; i++) {
		const phase = PHASE_ORDER[i];
		const checks = PHASE_OUTPUT_REQUIREMENTS[phase];
		if (!checks) continue;

		for (const check of checks) {
			const error = check(runId, workDir);
			if (error) {
				errors.push(error);
				if (!firstInvalidPhase) {
					firstInvalidPhase = phase;
				}
			}
		}
	}

	if (errors.length > 0) {
		return { valid: false, firstInvalidPhase, errors };
	}

	return { valid: true, errors: [] };
}
