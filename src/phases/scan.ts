/**
 * Scan phase — identify work items in the codebase.
 */

import { buildScanPrompt, SCAN_SCHEMA } from "../prompts/scan.ts";
import type { RunStore } from "../state.ts";
import type { Config, Issue, PhaseConfig, PhaseResult } from "../types.ts";
import { log, severityColor } from "../ui.ts";
import { extractJson, generateId, now } from "../util.ts";

interface ScanInput { scope: string }

interface ScanResult {
	issues: Array<{
		type?: string; title?: string; rationale?: string;
		severity?: string; scope_impact?: string; strategy?: string;
	}>;
}

export const scanPhase: PhaseConfig<ScanInput, ScanResult> = {
	name: "scan",
	schema: SCAN_SCHEMA as Record<string, unknown>,
	maxTurns: 100,
	timeout: 15 * 60 * 1000, // 15 min — scan reads many files

	loadItems(store, config) {
		const scope = config.pipeline.includes("scan") ? (store.loadMeta().scope ?? "find issues") : "find issues";
		return [{ scope }];
	},

	buildPrompt(item, _store, config) {
		return buildScanPrompt(item.scope, config);
	},

	parseResponse(response) {
		// Try direct JSON.parse first (structured_output from --json-schema is clean JSON)
		let parsed: unknown;
		try {
			parsed = JSON.parse(response);
		} catch {
			// Fallback: extract JSON from markdown/text response
			const jsonStr = extractJson(response);
			if (!jsonStr) throw new Error(`Scan: no JSON in response (first 200 chars: ${response.slice(0, 200)})`);
			try {
				parsed = JSON.parse(jsonStr);
			} catch {
				throw new Error(`Scan: invalid JSON (first 200 chars: ${jsonStr.slice(0, 200)})`);
			}
		}
		const raw = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).items;
		const items = Array.isArray(raw) ? raw : [];
		return { issues: items.filter((i: unknown) => {
			if (typeof i !== "object" || i === null) return false;
			const o = i as Record<string, unknown>;
			return (typeof o.title === "string" && o.title.trim()) ||
			       (typeof o.symptom === "string");
		}) };
	},

	saveResults(results, store) {
		const timestamp = now();
		const issues: Issue[] = results.flatMap(r =>
			r.success ? r.result.issues.map(raw => ({
				id: generateId("P"),
				type: (raw.type as Issue["type"]) ?? "bug",
				title: raw.title ?? "",
				rationale: raw.rationale ?? "",
				severity: (raw.severity as Issue["severity"]) ?? "MEDIUM",
				status: "UNVALIDATED" as const,
				evidence: [],
				scope_impact: raw.scope_impact,
				strategy: raw.strategy,
				created_at: timestamp,
				updated_at: timestamp,
			})) : []
		);

		if (issues.length > 0) {
			store.saveIssues(issues);
			store.updateStats({ issues_found: issues.length });
			for (const i of issues) {
				log.info(severityColor(i.severity, `[${i.severity}]`) + ` ${i.title}`);
			}
		}
	},
};
