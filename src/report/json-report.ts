/**
 * JSON report generator -- machine-readable run report
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunCost } from "../runner/cost.ts";
import { loadIssuesForRun } from "../state/issues.ts";
import { getRunDir, getRunStateDir, loadRunMeta } from "../state/runs.ts";
import { loadTasksForRun } from "../state/tasks.ts";
import { STATE_FILES } from "../state/types.ts";

/** JSON report schema */
export interface JsonRunReport {
	version: string;
	run_id: string;
	scope?: string;
	status: string;
	created_at: string;
	duration_ms: number;
	cost: {
		total: number;
		currency: string;
		by_phase: Record<
			string,
			{
				input_tokens: number;
				output_tokens: number;
				cost: number;
			}
		>;
	};
	results: {
		items_found: number;
		items_confirmed: number;
		items_false: number;
		items_partial: number;
		tasks_created: number;
		tasks_completed: number;
		tasks_failed: number;
	};
	items: Array<{
		id: string;
		type?: string;
		title: string;
		severity: string;
		status: string;
		tasks: string[];
	}>;
	errors: string[];
	verification?: {
		overall_pass: boolean;
		tasks_verified: number;
		tasks_passed: number;
		tasks_failed: number;
		regressions_found: boolean;
		tasks: Array<{
			task_id: string;
			overall_pass: boolean;
			gates: Array<{ gate: string; passed: boolean; message?: string }>;
			recommendations: string[];
			regressions_found: boolean;
			summary: string;
		}>;
		recommendations: string[];
	};
}

/**
 * Generate JSON report data
 */
export function generateJsonReport(
	runId: string,
	cost: RunCost,
	duration: number,
	workDir: string,
): JsonRunReport {
	const meta = loadRunMeta(runId, workDir);

	const issues = loadIssuesForRun(runId, workDir);
	const tasks = loadTasksForRun(runId, workDir);

	const confirmed = issues.filter((i) => i.status === "CONFIRMED").length;
	const falsePosCount = issues.filter((i) => i.status === "FALSE").length;
	const partial = issues.filter((i) => i.status === "PARTIAL").length;
	const completed = tasks.filter((t) => t.status === "done").length;
	const failed = tasks.filter((t) => t.status === "failed").length;

	// Load verification data (gracefully handle missing file)
	let verification: JsonRunReport["verification"];
	const verificationPath = join(getRunStateDir(runId, workDir), STATE_FILES.verification);
	if (existsSync(verificationPath)) {
		try {
			const raw = JSON.parse(readFileSync(verificationPath, "utf-8"));
			verification = {
				overall_pass: raw.overall_pass,
				tasks_verified: raw.tasks_verified,
				tasks_passed: raw.tasks_passed,
				tasks_failed: raw.tasks_failed,
				regressions_found: raw.regressions_found,
				tasks: raw.tasks,
				recommendations: raw.recommendations,
			};
		} catch {
			// Corrupted or invalid verification.json — skip
		}
	}

	return {
		version: "0.2.0",
		run_id: runId,
		scope: meta?.scope,
		status: meta?.phase ?? "unknown",
		created_at: meta?.created_at ?? new Date().toISOString(),
		duration_ms: duration,
		cost: {
			total: cost.totalCost,
			currency: "USD",
			by_phase: Object.fromEntries(
				Object.entries(cost.byPhase).map(([phase, pc]) => [
					phase,
					{ input_tokens: pc.inputTokens, output_tokens: pc.outputTokens, cost: pc.cost },
				]),
			),
		},
		results: {
			items_found: issues.length,
			items_confirmed: confirmed,
			items_false: falsePosCount,
			items_partial: partial,
			tasks_created: tasks.length,
			tasks_completed: completed,
			tasks_failed: failed,
		},
		items: issues.map((issue) => ({
			id: issue.id,
			type: issue.type,
			title: issue.title ?? issue.symptom,
			severity: issue.severity,
			status: issue.status,
			tasks: issue.related_task_ids,
		})),
		errors: [],
		verification,
	};
}

/**
 * Write JSON report to disk
 */
export function writeJsonReport(report: JsonRunReport, runId: string, workDir: string): string {
	const reportDir = join(getRunDir(runId, workDir), "reports");
	if (!existsSync(reportDir)) {
		mkdirSync(reportDir, { recursive: true });
	}
	const path = join(reportDir, "report.json");
	writeFileSync(path, JSON.stringify(report, null, 2));
	return path;
}
