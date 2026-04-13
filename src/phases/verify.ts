/**
 * Verify phase — verify each completed task.
 */

import { VERIFY_SCHEMA, buildVerifyPrompt } from "../prompts/verify.ts";
import type { PhaseConfig, Task } from "../types.ts";
import { extractJson } from "../util.ts";

interface VerifyResult {
	task_id: string;
	overall_pass: boolean;
	gates: Array<{ gate: string; passed: boolean; message?: string }>;
	recommendations: string[];
	regressions_found: boolean;
	summary: string;
}

export const verifyPhase: PhaseConfig<Task, VerifyResult> = {
	name: "verify",
	schema: VERIFY_SCHEMA as Record<string, unknown>,
	maxTurns: 15,
	timeout: 5 * 60 * 1000, // 5 min per task

	loadItems(store) {
		return store.loadTasks().filter((t: Task) => t.status === "done");
	},

	buildPrompt(task) {
		return buildVerifyPrompt(task);
	},

	parseResponse(response, task) {
		const jsonStr = extractJson(response);
		if (!jsonStr) {
			return {
				task_id: task.id,
				overall_pass: false,
				gates: [{ gate: "parsing", passed: false, message: "No JSON" }],
				recommendations: [],
				regressions_found: false,
				summary: "Failed to parse verification response",
			};
		}
		const parsed = JSON.parse(jsonStr);
		return {
			task_id: task.id,
			overall_pass: typeof parsed.overall_pass === "boolean" ? parsed.overall_pass : false,
			gates: Array.isArray(parsed.gates) ? parsed.gates : [],
			recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
			regressions_found:
				typeof parsed.regressions_found === "boolean" ? parsed.regressions_found : false,
			summary: parsed.summary ?? "",
		};
	},

	saveResults(results, store) {
		const verification = {
			run_id: store.runId,
			created_at: new Date().toISOString(),
			overall_pass: results.every((r) => r.success && r.result.overall_pass),
			tasks: results.map((r) =>
				r.success
					? r.result
					: {
							task_id: (r.item as Task).id,
							overall_pass: false,
							gates: [{ gate: "execution", passed: false, message: r.error }],
							recommendations: [],
							regressions_found: false,
							summary: r.error ?? "Failed",
						},
			),
		};
		store.saveVerification(verification);
	},
};
