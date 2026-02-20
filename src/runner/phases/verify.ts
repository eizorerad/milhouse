/**
 * Verify phase config — Truth Verifier (TV)
 *
 * Single-agent phase that verifies execution results by running quality
 * gates and checking for regressions. Determines overall pass/fail.
 */

import pc from "picocolors";
import {
	type VerifyInput,
	type VerifyPreCheckIssue,
	buildVerifyPrompt,
} from "../../agents/prompts/verify.ts";
import { VERIFY_SCHEMA } from "../../agents/schemas/verify.ts";
import { loadTasksForRun } from "../../state/tasks.ts";
import type { RunPhase } from "../../state/types.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import type { PhaseConfig } from "../types.ts";

/** Parsed verification result */
interface VerifyResult {
	overall_pass: boolean;
	gates: Array<{ gate: string; passed: boolean; message?: string }>;
	recommendations: string[];
	regressions_found: boolean;
	summary: string;
}

export const verifyPhaseConfig: PhaseConfig<VerifyInput, VerifyResult> = {
	name: "verify",
	role: "TV",
	jsonSchema: VERIFY_SCHEMA as Record<string, unknown>,
	mode: "single-agent",
	defaultParallel: 1,

	loadItems(ctx) {
		const tasks = loadTasksForRun(ctx.runId, ctx.workDir);
		const completedTasks = tasks.filter((t) => t.status === "done");
		const failedTasks = tasks.filter((t) => t.status === "failed");

		if (completedTasks.length === 0 && failedTasks.length === 0) return [];

		// Pre-check issues could be gathered here from automated gates
		// For now, pass empty — the AI does the verification
		const preCheckIssues: VerifyPreCheckIssue[] = [];

		return [{ tasks, preCheckIssues }];
	},

	buildPrompt(input, ctx) {
		return buildVerifyPrompt(input, ctx);
	},

	parseResponse(response) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) {
			return {
				overall_pass: false,
				gates: [{ gate: "parsing", passed: false, message: "Failed to extract JSON" }],
				recommendations: [],
				regressions_found: false,
				summary: "Failed to parse verification response",
			};
		}

		try {
			const parsed = JSON.parse(jsonStr);
			return {
				overall_pass: typeof parsed.overall_pass === "boolean" ? parsed.overall_pass : false,
				gates: Array.isArray(parsed.gates) ? parsed.gates : [],
				recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
				regressions_found:
					typeof parsed.regressions_found === "boolean" ? parsed.regressions_found : false,
				summary: typeof parsed.summary === "string" ? parsed.summary : "",
			};
		} catch {
			return {
				overall_pass: false,
				gates: [{ gate: "parsing", passed: false, message: "JSON parse error" }],
				recommendations: [],
				regressions_found: false,
				summary: "Failed to parse verification response",
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
		const startTime = (ctx.store._startTime as number) ?? 0;
		displayPhaseSummaryHeader("verify", results, totalInput, totalOutput, ctx.config, startTime);

		for (const r of results) {
			if (!r.success) continue;
			const v = r.result;

			// Overall status
			const statusText = v.overall_pass ? pc.green("PASS") : pc.red("FAIL");
			const regressions = v.regressions_found ? pc.red(" (regressions found)") : "";
			console.log("");
			console.log(`  ${pc.bold("Verification:")} ${statusText}${regressions}`);

			// Gate results in a compact line
			if (v.gates.length > 0) {
				const gateStrs = v.gates.map((g) => {
					const icon = g.passed ? pc.green("✔") : pc.red("✗");
					return `${icon} ${g.gate}`;
				});
				console.log(`    ${gateStrs.join("  ")}`);
			}

			// Recommendations
			if (v.recommendations.length > 0) {
				console.log("");
				console.log(`  ${pc.bold("Recommendations:")}`);
				for (const rec of v.recommendations) {
					console.log(`    ${pc.dim("-")} ${rec}`);
				}
			}

			// Summary
			if (v.summary) {
				console.log("");
				console.log(`  ${pc.dim(v.summary)}`);
			}
		}

		console.log(pc.dim("═".repeat(47)));
		console.log("");
	},

	nextPhase(results): RunPhase {
		const passed = results.every((r) => r.success && r.result.overall_pass);
		return passed ? "completed" : "failed";
	},
};
