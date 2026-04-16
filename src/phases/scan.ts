/**
 * Scan phase — identify work items in the codebase.
 */

import { SCAN_SCHEMA, buildScanPrompt } from "../prompts/scan.ts";
import type { Issue, PhaseConfig } from "../types.ts";
import { log, severityColor } from "../ui.ts";
import { generateId, now, parseJsonResponse } from "../util.ts";

interface ScanInput {
	scope: string;
}

interface ScanResult {
	issues: Array<{
		type?: string;
		title?: string;
		rationale?: string;
		severity?: string;
		scope_impact?: string;
		strategy?: string;
	}>;
}

export const scanPhase: PhaseConfig<ScanInput, ScanResult> = {
	name: "scan",
	schema: SCAN_SCHEMA as Record<string, unknown>,
	maxTurns: 100,
	timeout: 15 * 60 * 1000, // 15 min — scan reads many files

	loadItems(store, config) {
		const scope = config.pipeline.includes("scan")
			? (store.loadMeta().scope ?? "find issues")
			: "find issues";
		return [{ scope }];
	},

	buildPrompt(item, _store, config) {
		return buildScanPrompt(item.scope, config);
	},

	parseResponse(response) {
		const parsed = parseJsonResponse(response, "Scan");
		const raw = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).items;
		const items = Array.isArray(raw) ? raw : [];
		return {
			issues: items.filter((i: unknown) => {
				if (typeof i !== "object" || i === null) return false;
				const o = i as Record<string, unknown>;
				return (typeof o.title === "string" && o.title.trim()) || typeof o.symptom === "string";
			}),
		};
	},

	saveResults(results, store) {
		const timestamp = now();
		const issues: Issue[] = results.flatMap((r) =>
			r.success
				? r.result.issues.map((raw) => ({
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
					}))
				: [],
		);

		if (issues.length > 0) {
			store.saveIssues(issues);
			store.refreshStats();
			for (const i of issues) {
				log.info(`${severityColor(i.severity, `[${i.severity}]`)} ${i.title}`);
			}
		}
	},
};
