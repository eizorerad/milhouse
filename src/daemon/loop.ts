/**
 * Daemon loop — cost extraction and budget enforcement utilities
 *
 * Provides helpers for reading cost data from completed child runs
 * and accumulating totalCost for cross-run budget enforcement.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRunDir } from "../state/runs.ts";

/**
 * Extract the total cost from a completed run's report.json.
 *
 * Reads `.milhouse/runs/<runId>/reports/report.json`, parses JSON,
 * and returns `cost.total` (USD). Returns 0 on any failure:
 * - Missing report.json (child crashed before generating it)
 * - Corrupt / invalid JSON
 * - Missing or non-numeric cost.total field
 * - Child killed by watchdog before report generation
 * - Negative cost values (defensive)
 */
export function extractRunCost(runId: string, workDir: string): number {
	try {
		const runDir = getRunDir(runId, workDir);
		const reportPath = join(runDir, "reports", "report.json");

		if (!existsSync(reportPath)) {
			return 0;
		}

		const raw = readFileSync(reportPath, "utf-8");
		const report = JSON.parse(raw);

		const total = report?.cost?.total;
		if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
			return 0;
		}

		return total;
	} catch {
		return 0;
	}
}
