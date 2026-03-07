/**
 * Validate phase — validate each issue with evidence.
 */

import { buildValidatePrompt, VALIDATE_SCHEMA } from "../prompts/validate.ts";
import type { RunStore } from "../state.ts";
import type { Issue, IssueStatus, PhaseConfig, PhaseResult } from "../types.ts";
import { printIssueList } from "../ui.ts";
import { extractJson } from "../util.ts";

interface ValidateResult {
	issue_id: string;
	status: IssueStatus;
	confidence?: string;
	summary?: string;
	corrected_description?: string;
	evidence?: Array<{ type: string; file?: string; line_start?: number; line_end?: number; output?: string }>;
}

export const validatePhase: PhaseConfig<Issue, ValidateResult> = {
	name: "validate",
	schema: VALIDATE_SCHEMA as Record<string, unknown>,
	maxTurns: 15,
	timeout: 5 * 60 * 1000, // 5 min per issue

	loadItems(store) {
		return store.loadIssues().filter((i: Issue) => i.status === "UNVALIDATED");
	},

	buildPrompt(issue) {
		return buildValidatePrompt(issue);
	},

	parseResponse(response, item) {
		// Try direct JSON.parse first (structured_output from --json-schema is clean JSON)
		// biome-ignore lint: parsed needs any for JSON.parse compatibility
		let parsed: any;
		try {
			parsed = JSON.parse(response);
		} catch {
			// Fallback: extract JSON from markdown/text response
			const jsonStr = extractJson(response);
			if (!jsonStr) return { issue_id: item.id, status: "UNVALIDATED" as IssueStatus, summary: "No JSON" };
			parsed = JSON.parse(jsonStr);
		}
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
	},

	saveResults(results, store) {
		// Batch update: load all issues once, apply all changes, save once.
		// This avoids the race condition where parallel updateIssue() calls
		// overwrite each other (read-modify-write on the same file).
		const allIssues: Issue[] = store.loadIssues();
		const issueMap = new Map<string, Issue>(allIssues.map((i: Issue) => [i.id, i]));
		let validated = 0;

		for (const r of results) {
			if (!r.success || r.result.status === "UNVALIDATED") continue;
			const v = r.result;
			const originalIssue = r.item as Issue;
			const issue = issueMap.get(originalIssue.id);
			if (!issue) continue;

			const newEvidence = (v.evidence ?? []).map(e => ({
				type: e.type as "file" | "log" | "command",
				file: e.file,
				line_start: e.line_start,
				line_end: e.line_end,
				output: e.output,
			}));

			issue.status = v.status;
			issue.corrected_description = v.corrected_description;
			issue.evidence = [...issue.evidence, ...newEvidence];
			issue.updated_at = new Date().toISOString();
			validated++;
		}

		// Single write with all updates
		store.saveIssues(allIssues);
		if (validated > 0) store.updateStats({ issues_validated: validated });

		printIssueList(allIssues);
	},
};
