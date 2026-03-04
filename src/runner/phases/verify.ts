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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { buildVerifyPromptForTask } from "../../agents/prompts/verify.ts";
import { VERIFY_SCHEMA } from "../../agents/schemas/verify.ts";
import { saveVerificationReport } from "../../cli/commands/utils/verification-report.ts";
import type { VerificationReport } from "../../cli/commands/utils/verification-types.ts";
import { getRunStateDir } from "../../state/runs.ts";
import { loadTasksForRun } from "../../state/tasks.ts";
import { STATE_FILES, type RunPhase, type Task } from "../../state/types.ts";
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
	engineMetadata: { maxTurns: 15, timeout: 1200000 }, // 20 min per-item timeout
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

	saveResults(results, ctx) {
		const now = new Date().toISOString();

		// Aggregate per-task results
		const taskResults: Array<{
			task_id: string;
			overall_pass: boolean;
			gates: Array<{ gate: string; passed: boolean; message?: string }>;
			recommendations: string[];
			regressions_found: boolean;
			summary: string;
		}> = [];
		let overallPass = true;
		let regressionsFound = false;
		const allRecommendations: string[] = [];

		for (const r of results) {
			if (!r.success) {
				overallPass = false;
				taskResults.push({
					task_id: (r.item as Task).id,
					overall_pass: false,
					gates: [{ gate: "execution", passed: false, message: r.error ?? "Agent failed" }],
					recommendations: [],
					regressions_found: false,
					summary: r.error ?? "Verification agent failed",
				});
				continue;
			}
			const v = r.result;
			if (!v.overall_pass) overallPass = false;
			if (v.regressions_found) regressionsFound = true;
			allRecommendations.push(...v.recommendations);
			taskResults.push({
				task_id: v.task_id,
				overall_pass: v.overall_pass,
				gates: v.gates,
				recommendations: v.recommendations,
				regressions_found: v.regressions_found,
				summary: v.summary,
			});
		}

		const tasksPassedCount = taskResults.filter((t) => t.overall_pass).length;
		const tasksFailedCount = taskResults.length - tasksPassedCount;

		// Write verification.json to state directory
		const verificationData = {
			run_id: ctx.runId,
			created_at: now,
			overall_pass: overallPass,
			tasks_verified: taskResults.length,
			tasks_passed: tasksPassedCount,
			tasks_failed: tasksFailedCount,
			regressions_found: regressionsFound,
			tasks: taskResults,
			recommendations: [...new Set(allRecommendations)],
		};

		const stateDir = getRunStateDir(ctx.runId, ctx.workDir);
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}
		writeFileSync(
			join(stateDir, STATE_FILES.verification),
			JSON.stringify(verificationData, null, 2),
		);

		// Build and save the full VerificationReport format
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}

		// Aggregate all gates across tasks
		const allGateResults: Array<{ gate: string; passed: boolean; message?: string; evidence: never[] }> = [];
		for (const t of taskResults) {
			for (const g of t.gates) {
				allGateResults.push({ gate: g.gate, passed: g.passed, message: g.message, evidence: [] });
			}
		}
		const gatesPassed = allGateResults.filter((g) => g.passed).length;
		const gatesFailed = allGateResults.length - gatesPassed;

		const report: VerificationReport = {
			run_id: ctx.runId,
			created_at: now,
			duration_ms: Date.now() - ctx.startTime,
			overall_success: overallPass,
			gates: {
				total: allGateResults.length,
				passed: gatesPassed,
				failed: gatesFailed,
				results: allGateResults,
			},
			issues: [],
			ai_verification: {
				overall_pass: overallPass,
				recommendations: [...new Set(allRecommendations)],
				regressions_found: regressionsFound,
				summary: `${tasksPassedCount}/${taskResults.length} tasks passed verification`,
			},
			tokens: { input: totalInput, output: totalOutput },
			tasks: {
				completed: tasksPassedCount,
				failed: tasksFailedCount,
				total: taskResults.length,
			},
		};

		saveVerificationReport(report, ctx.workDir, ctx.runId);
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
		if (results.length === 0) return "failed";
		const passed = results.every((r) => r.success && r.result.overall_pass);
		return passed ? "completed" : "failed";
	},
};
