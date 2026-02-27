/**
 * Scan phase config — Lead Investigator (LI)
 *
 * Analyzes the repository to identify work items (bugs, features,
 * refactoring, improvements, tasks). Produces Work Brief v0 (UNVALIDATED).
 */

import pc from "picocolors";
import { buildScanPrompt } from "../../agents/prompts/scan.ts";
import { SCAN_SCHEMA } from "../../agents/schemas/scan.ts";
import { saveIssuesForRun } from "../../state/issues.ts";
import { writeProblemBriefForRun } from "../../state/plan-store.ts";
import { updateRunStatsWithLock } from "../../state/runs.ts";
import type { Issue, RunPhase } from "../../state/types.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";
import { displayPhaseSummaryHeader } from "../phase-runner.ts";
import type { PhaseConfig } from "../types.ts";

/** Scan input — scope and workDir */
interface ScanInput {
	scope: string;
	workDir: string;
}

/** Parsed issue from AI response */
interface ScanIssue {
	type?: string;
	title?: string;
	rationale?: string;
	symptom?: string;
	hypothesis?: string;
	severity: string;
	scope_impact?: string;
	strategy?: string;
	frequency?: string;
	blast_radius?: string;
}

/** Scan result — the list of parsed issues */
interface ScanResult {
	issues: ScanIssue[];
}

export const scanPhaseConfig: PhaseConfig<ScanInput, ScanResult> = {
	name: "scan",
	role: "LI",
	jsonSchema: SCAN_SCHEMA as Record<string, unknown>,
	engineMetadata: { maxTurns: 50 },
	mode: "single-agent",
	defaultParallel: 1,

	loadItems(ctx) {
		return [{ scope: ctx.config.scanFocus ?? "find and analyze issues", workDir: ctx.workDir }];
	},

	buildPrompt(item, ctx) {
		return buildScanPrompt(item.scope, item.workDir, ctx);
	},

	parseResponse(response) {
		const jsonStr = extractJsonFromResponse(response);
		if (!jsonStr) return { issues: [] };

		try {
			const parsed = JSON.parse(jsonStr);
			// Handle --json-schema wrapper: {"items": [...]}
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				Array.isArray(parsed.items)
			) {
				return { issues: parsed.items.filter(isValidIssue) };
			}
			if (Array.isArray(parsed)) {
				return { issues: parsed.filter(isValidIssue) };
			}
			return { issues: [] };
		} catch {
			return { issues: [] };
		}
	},

	async saveResults(results, ctx) {
		const now = new Date().toISOString();
		const issues: Issue[] = results.flatMap((r) =>
			r.success
				? r.result.issues.map((raw) => {
						const timestamp = Date.now().toString(36);
						const random = Math.random().toString(36).substring(2, 8);
						const title = raw.title ?? raw.symptom ?? "";
						const rationale = raw.rationale ?? raw.hypothesis ?? "";
						const validTypes = ["bug", "feature", "refactor", "improvement", "task"];
						const itemType = raw.type && validTypes.includes(raw.type) ? raw.type : "bug";

						return {
							id: `P-${timestamp}-${random}`,
							type: itemType as Issue["type"],
							title,
							rationale,
							symptom: title,
							hypothesis: rationale,
							severity: (raw.severity ?? "MEDIUM") as Issue["severity"],
							frequency: raw.frequency ?? undefined,
							blast_radius: raw.blast_radius ?? undefined,
							scope_impact: raw.scope_impact ?? undefined,
							strategy: raw.strategy ?? undefined,
							status: "UNVALIDATED" as const,
							evidence: [],
							related_task_ids: [],
							created_at: now,
							updated_at: now,
						};
					})
				: [],
		);

		if (issues.length > 0) {
			saveIssuesForRun(ctx.runId, issues, ctx.workDir);

			// Generate Work Brief
			const brief = generateWorkBrief(issues, ctx.runId);
			writeProblemBriefForRun(ctx.workDir, ctx.runId, brief);

			await updateRunStatsWithLock(ctx.runId, { issues_found: issues.length }, ctx.workDir);
		}
	},

	formatSummary(results, ctx) {
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of results) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}
		const startTime = ctx.startTime;
		displayPhaseSummaryHeader("scan", results, totalInput, totalOutput, ctx.config, startTime);

		const allIssues = results.flatMap((r) => (r.success ? r.result.issues : []));
		if (allIssues.length > 0) {
			console.log("");
			console.log(`  ${pc.bold("Work Items")} ${pc.dim("(UNVALIDATED)")}:`);
			for (const issue of allIssues) {
				const title = issue.title ?? issue.symptom ?? "Untitled";
				const typeTag = pc.dim(`[${issue.type ?? "bug"}]`);
				const sev = issue.severity ?? "MEDIUM";
				const sevColor =
					sev === "CRITICAL"
						? pc.red
						: sev === "HIGH"
							? pc.yellow
							: sev === "MEDIUM"
								? pc.blue
								: pc.dim;
				console.log(`    ${typeTag} ${sevColor(`[${sev}]`)} ${title}`);
			}
		}

		console.log("");
		console.log(`  ${pc.dim("->")} Next: ${pc.cyan("milhouse --validate")}`);
		console.log(pc.dim("═".repeat(47)));
		console.log("");
	},

	nextPhase(results): RunPhase {
		const hasIssues = results.some((r) => r.success && r.result.issues.length > 0);
		return hasIssues ? "validate" : "completed";
	},
};

/** Validate a parsed issue has required fields */
function isValidIssue(issue: unknown): issue is ScanIssue {
	if (typeof issue !== "object" || issue === null) return false;
	const obj = issue as Record<string, unknown>;

	const hasTitle = typeof obj.title === "string" && obj.title.trim() !== "";
	const hasSymptom = typeof obj.symptom === "string" && (obj.symptom as string).trim() !== "";
	if (!hasTitle && !hasSymptom) return false;

	const hasRationale = typeof obj.rationale === "string" && obj.rationale.trim() !== "";
	const hasHypothesis =
		typeof obj.hypothesis === "string" && (obj.hypothesis as string).trim() !== "";
	if (!hasRationale && !hasHypothesis) return false;

	// Default severity if missing
	const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
	if (typeof obj.severity !== "string" || !validSeverities.includes(obj.severity)) {
		(obj as Record<string, unknown>).severity = "MEDIUM";
	}

	return true;
}

/** Generate Work Brief markdown */
function generateWorkBrief(issues: Issue[], runId: string): string {
	const timestamp = new Date().toISOString();
	const parts: string[] = [];

	parts.push(`# Work Brief v0

> **Status**: UNVALIDATED
> **Run ID**: ${runId}
> **Generated**: ${timestamp}
> **Work Items Found**: ${issues.length}

---

## Work Items
`);

	for (const issue of issues) {
		const title = issue.title ?? issue.symptom;
		const rationale = issue.rationale ?? issue.hypothesis;
		const itemType = issue.type ?? "bug";
		parts.push(`### ${issue.id}: ${title}

| Field | Value |
|-------|-------|
| **Type** | ${itemType} |
| **Status** | ${issue.status} |
| **Severity** | ${issue.severity} |
| **Rationale** | ${rationale} |

---
`);
	}

	parts.push(`## Next Steps

1. Run \`milhouse validate\` to validate each work item with evidence
2. Run \`milhouse plan\` to generate WBS for confirmed work items
`);

	return parts.join("\n");
}
