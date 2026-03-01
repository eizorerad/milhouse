/**
 * Verify phase config — Truth Verifier (TV)
 *
 * Per-task parallel verification: each completed task is verified by a
 * dedicated AI agent in parallel, making verification 3-5x faster than
 * the old single-agent approach. Each verifier focuses on one task's
 * diff, acceptance criteria, and file hygiene.
 *
 * Results are aggregated: all tasks must pass for the run to pass.
 */

import pc from "picocolors";
import { buildVerifyPromptForTask } from "../../agents/prompts/verify.ts";
import { VERIFY_SCHEMA } from "../../agents/schemas/verify.ts";
import { loadTasksForRun } from "../../state/tasks.ts";
import type { RunPhase, Task } from "../../state/types.ts";
import { logWarn } from "../../ui/logger.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import type { PhaseConfig } from "../types.ts";

/** Parsed verification result per task */
interface VerifyResult {
	task_id: string;
	overall_pass: boolean;
	gates: Array<{ gate: string; passed: boolean; message?: string }>;
	recommendations: string[];
	regressions_found: boolean;
	summary: string;
}

export const verifyPhaseConfig: PhaseConfig<Task, VerifyResult> = {
	name: "verify",
	role: "TV",
	jsonSchema: VERIFY_SCHEMA as Record<string, unknown>,
	engineMetadata: { maxTurns: 15 },
	mode: "per-item",
	defaultParallel: 5,

	loadItems(ctx) {
		const tasks = loadTasksForRun(ctx.runId, ctx.workDir);
		// Only verify completed tasks — failed tasks don't need verification
		const completedTasks = tasks.filter((t) => t.status === "done");

		if (completedTasks.length === 0) {
			logWarn("No completed tasks to verify");
			return [];
		}

		return completedTasks;
	},

	buildPrompt(task, ctx) {
		return buildVerifyPromptForTask(task, ctx);
	},

	parseResponse(response, task) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) {
			return {
				task_id: task.id,
				overall_pass: false,
				gates: [{ gate: "parsing", passed: false, message: "Failed to extract JSON" }],
				recommendations: [],
				regressions_found: false,
				summary: `Failed to parse verification response for ${task.id}`,
			};
		}

		try {
			const parsed = JSON.parse(jsonStr);
			return {
				task_id: task.id,
				overall_pass: typeof parsed.overall_pass === "boolean" ? parsed.overall_pass : false,
				gates: Array.isArray(parsed.gates) ? parsed.gates : [],
				recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
				regressions_found:
					typeof parsed.regressions_found === "boolean" ? parsed.regressions_found : false,
				summary: typeof parsed.summary === "string" ? parsed.summary : "",
			};
		} catch {
			return {
				task_id: task.id,
				overall_pass: false,
				gates: [{ gate: "parsing", passed: false, message: "JSON parse error" }],
				recommendations: [],
				regressions_found: false,
				summary: `Failed to parse verification response for ${task.id}`,
			};
		}
	},

	saveResults() {
		// Verification results are logged/displayed but don't mutate state
		// The phase transition handles marking the run as completed/failed
	},

	formatSummary(results, ctx) {
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}
		const startTime = ctx.startTime;
		displayPhaseSummaryHeader("verify", results, totalInput, totalOutput, ctx.config, startTime);

		// Aggregate gate results across all tasks
		const allGates = new Map<string, { passed: number; failed: number; messages: string[] }>();
		let overallPass = true;
		let anyRegressions = false;
		const allRecommendations: string[] = [];
		const failedTasks: Array<{ taskId: string; summary: string }> = [];

		for (const r of results) {
			if (!r.success) {
				overallPass = false;
				continue;
			}
			const v = r.result;

			if (!v.overall_pass) {
				overallPass = false;
				failedTasks.push({
					taskId: v.task_id,
					summary: v.summary || "No details",
				});
			}
			if (v.regressions_found) anyRegressions = true;

			for (const g of v.gates) {
				const existing = allGates.get(g.gate) ?? { passed: 0, failed: 0, messages: [] };
				if (g.passed) {
					existing.passed++;
				} else {
					existing.failed++;
					if (g.message) existing.messages.push(`${v.task_id}: ${g.message}`);
				}
				allGates.set(g.gate, existing);
			}

			for (const rec of v.recommendations) {
				allRecommendations.push(rec);
			}
		}

		// Overall status
		const statusText = overallPass ? pc.green("PASS") : pc.red("FAIL");
		const regressions = anyRegressions ? pc.red(" (regressions found)") : "";
		console.log("");
		console.log(`  ${pc.bold("Verification:")} ${statusText}${regressions}`);

		// Gate results in a compact line
		if (allGates.size > 0) {
			const gateStrs: string[] = [];
			for (const [gate, stats] of allGates) {
				const icon = stats.failed === 0 ? pc.green("✔") : pc.red("✗");
				gateStrs.push(`${icon} ${gate}`);
			}
			console.log(`    ${gateStrs.join("  ")}`);
		}

		// Failed tasks
		if (failedTasks.length > 0) {
			console.log("");
			console.log(`  ${pc.bold("Failed Verification:")}`);
			for (const ft of failedTasks) {
				console.log(`    ${pc.red("✗")} ${ft.taskId}: ${ft.summary}`);
			}
		}

		// Recommendations (deduplicated)
		const uniqueRecs = [...new Set(allRecommendations)];
		if (uniqueRecs.length > 0) {
			console.log("");
			console.log(`  ${pc.bold("Recommendations:")}`);
			for (const rec of uniqueRecs) {
				console.log(`    ${pc.dim("-")} ${rec}`);
			}
		}

		// Summary line
		const passCount = results.filter((r) => r.success && r.result.overall_pass).length;
		const totalCount = results.length;
		console.log("");
		console.log(
			`  ${pc.dim(`${passCount}/${totalCount} tasks passed verification`)}`,
		);

		console.log(pc.dim("═".repeat(47)));
		console.log("");
	},

	nextPhase(results): RunPhase {
		const passed = results.every((r) => r.success && r.result.overall_pass);
		return passed ? "completed" : "failed";
	},
};
