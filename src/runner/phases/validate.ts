/**
 * Validate phase config — Issue Validator (IV)
 *
 * Each UNVALIDATED issue is validated by a dedicated agent.
 * Updates issue status to CONFIRMED, FALSE, PARTIAL, or MISDIAGNOSED.
 * Supports automatic retry for issues that remain UNVALIDATED.
 */

import type { PhaseConfig, PhaseContext, PhaseItemResult } from "../types.ts";
import type { Issue, IssueStatus, RunPhase } from "../../state/types.ts";
import { buildValidatePrompt } from "../../agents/prompts/validate.ts";
import { VALIDATE_SCHEMA } from "../../agents/schemas/validate.ts";
import { loadIssuesForRun, updateIssueForRun } from "../../state/issues.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";

/** Parsed validation result from AI */
interface ValidationResult {
	issue_id: string;
	status: IssueStatus;
	confidence?: string;
	summary?: string;
	corrected_description?: string;
	evidence?: Array<{
		type: string;
		file?: string;
		line_start?: number;
		line_end?: number;
		output?: string;
		timestamp?: string;
	}>;
}

export const validatePhaseConfig: PhaseConfig<Issue, ValidationResult> = {
	name: "validate",
	role: "IV",
	jsonSchema: VALIDATE_SCHEMA as Record<string, unknown>,
	mode: "per-item",
	defaultParallel: 5,

	// Retry configuration
	isRetryable: true,
	maxRetryRounds: 2,

	loadItems(ctx) {
		const issues = loadIssuesForRun(ctx.runId, ctx.workDir);
		return issues.filter((i) => i.status === "UNVALIDATED");
	},

	buildPrompt(issue, ctx) {
		return buildValidatePrompt(issue, ctx);
	},

	parseResponse(response, item) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) {
			return {
				issue_id: item.id,
				status: "UNVALIDATED" as IssueStatus,
				summary: "Failed to extract JSON from response",
			};
		}

		try {
			const parsed = JSON.parse(jsonStr);

			const validStatuses: IssueStatus[] = ["CONFIRMED", "FALSE", "PARTIAL", "MISDIAGNOSED"];
			const status = validStatuses.includes(parsed.status) ? parsed.status : "UNVALIDATED";

			return {
				issue_id: item.id,
				status,
				confidence: parsed.confidence,
				summary: parsed.summary,
				corrected_description: parsed.corrected_description,
				evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
			};
		} catch {
			return {
				issue_id: item.id,
				status: "UNVALIDATED" as IssueStatus,
				summary: "Failed to parse validation response",
			};
		}
	},

	retryFilter(items, results) {
		// Retry items whose validation yielded UNVALIDATED (parsing failure)
		const unvalidatedIds = new Set(
			results
				.filter((r) => r.success && r.result.status === "UNVALIDATED")
				.map((r) => (r.item as Issue).id),
		);
		return items.filter((i) => unvalidatedIds.has(i.id));
	},

	async saveResults(results, ctx) {
		const now = new Date().toISOString();
		let validated = 0;

		for (const r of results) {
			if (!r.success) continue;
			const result = r.result;
			if (result.status === "UNVALIDATED") continue;

			const evidence = (result.evidence ?? []).map((ev) => ({
				...ev,
				type: ev.type as "file" | "probe" | "log" | "command",
				timestamp: ev.timestamp ?? now,
			}));

			const issue = r.item as Issue;
			updateIssueForRun(
				ctx.runId,
				issue.id,
				{
					status: result.status,
					corrected_description: result.corrected_description,
					evidence: [...issue.evidence, ...evidence],
					validated_by: "IV",
				},
				ctx.workDir,
			);

			validated++;
		}

		if (validated > 0) {
			await updateRunStatsWithLock(ctx.runId, { issues_validated: validated }, ctx.workDir);
		}
	},

	nextPhase(results): RunPhase {
		const hasConfirmed = results.some(
			(r) => r.success && (r.result.status === "CONFIRMED" || r.result.status === "PARTIAL"),
		);
		return hasConfirmed ? "plan" : "completed";
	},
};
