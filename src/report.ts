/**
 * Report — generate a summary report for a completed run.
 */

import { formatCost, formatPhaseCosts } from "./cost.ts";
import type { RunStore } from "./state.ts";
import type { PhaseCost, Phase, RunCost, RunMeta } from "./types.ts";
import { formatDuration } from "./ui.ts";

export interface RunReport {
	meta: RunMeta;
	issues: {
		total: number;
		confirmed: number;
		false_positive: number;
		partial: number;
		misdiagnosed: number;
		unvalidated: number;
		bySeverity: Record<string, number>;
	};
	tasks: {
		total: number;
		done: number;
		failed: number;
		pending: number;
		skipped: number;
	};
	verification: {
		passed: number;
		failed: number;
		overall_pass: boolean;
	};
	cost: {
		total: RunCost;
		byPhase: Partial<Record<Phase, PhaseCost>>;
	};
	timeline: {
		started: string;
		finished: string;
		durationMs: number;
	};
}

/**
 * Generate a structured report from a completed run.
 */
export function generateReport(store: RunStore): RunReport {
	const meta = store.loadMeta();
	const issues = store.loadIssues();
	const tasks = store.loadTasks();

	// Issue stats
	const issueStats = {
		total: issues.length,
		confirmed: issues.filter((i) => i.status === "CONFIRMED").length,
		false_positive: issues.filter((i) => i.status === "FALSE").length,
		partial: issues.filter((i) => i.status === "PARTIAL").length,
		misdiagnosed: issues.filter((i) => i.status === "MISDIAGNOSED").length,
		unvalidated: issues.filter((i) => i.status === "UNVALIDATED").length,
		bySeverity: countBy(issues, (i) => i.severity),
	};

	// Task stats
	const taskStats = {
		total: tasks.length,
		done: tasks.filter((t) => t.status === "done").length,
		failed: tasks.filter((t) => t.status === "failed").length,
		pending: tasks.filter((t) => t.status === "pending").length,
		skipped: tasks.filter((t) => t.status === "skipped").length,
	};

	// Verification stats
	let verificationStats = { passed: 0, failed: 0, overall_pass: false };
	const verData = store.loadVerification() as Record<string, unknown> | null;
	if (verData) {
		const verTasks = Array.isArray(verData.tasks) ? verData.tasks : [];
		verificationStats = {
			passed: verTasks.filter((t: { overall_pass?: boolean }) => t.overall_pass).length,
			failed: verTasks.filter((t: { overall_pass?: boolean }) => !t.overall_pass).length,
			overall_pass: verData.overall_pass === true,
		};
	}

	// Cost
	const runCost = store.loadCost();

	// Timeline
	const started = meta.created_at;
	const finished = meta.updated_at;
	const durationMs =
		started && finished ? new Date(finished).getTime() - new Date(started).getTime() : 0;

	return {
		meta,
		issues: issueStats,
		tasks: taskStats,
		verification: verificationStats,
		cost: { total: runCost, byPhase: runCost.byPhase },
		timeline: { started, finished, durationMs },
	};
}

/**
 * Format report as markdown string.
 */
export function formatReportMarkdown(report: RunReport): string {
	const lines: string[] = [];
	const dur = formatDuration(report.timeline.durationMs);

	lines.push(`# Milhouse Run Report`);
	lines.push("");
	lines.push(`**Run ID**: ${report.meta.id}`);
	if (report.meta.scope) lines.push(`**Scope**: ${report.meta.scope}`);
	lines.push(`**Phase**: ${report.meta.phase}`);
	lines.push(`**Duration**: ${dur}`);
	lines.push(`**Started**: ${report.timeline.started}`);
	lines.push(`**Finished**: ${report.timeline.finished}`);

	// Issues
	lines.push("");
	lines.push("## Issues");
	lines.push("");
	lines.push(`| Status | Count |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Total | ${report.issues.total} |`);
	lines.push(`| ✅ Confirmed | ${report.issues.confirmed} |`);
	lines.push(`| ❌ False Positive | ${report.issues.false_positive} |`);
	lines.push(`| ⚠️ Partial | ${report.issues.partial} |`);
	lines.push(`| 🔄 Misdiagnosed | ${report.issues.misdiagnosed} |`);
	lines.push(`| ❓ Unvalidated | ${report.issues.unvalidated} |`);

	if (Object.keys(report.issues.bySeverity).length > 0) {
		lines.push("");
		lines.push("### By Severity");
		lines.push("");
		lines.push(`| Severity | Count |`);
		lines.push(`|----------|-------|`);
		for (const [sev, count] of Object.entries(report.issues.bySeverity)) {
			lines.push(`| ${sev} | ${count} |`);
		}
	}

	// Tasks
	lines.push("");
	lines.push("## Tasks");
	lines.push("");
	lines.push(`| Status | Count |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Total | ${report.tasks.total} |`);
	lines.push(`| ✅ Done | ${report.tasks.done} |`);
	lines.push(`| ❌ Failed | ${report.tasks.failed} |`);
	lines.push(`| ⏳ Pending | ${report.tasks.pending} |`);
	lines.push(`| ⏭️ Skipped | ${report.tasks.skipped} |`);

	// Verification
	lines.push("");
	lines.push("## Verification");
	lines.push("");
	const passIcon = report.verification.overall_pass ? "✅" : "❌";
	lines.push(`**Overall**: ${passIcon} ${report.verification.overall_pass ? "PASSED" : "FAILED"}`);
	lines.push(`**Passed**: ${report.verification.passed} | **Failed**: ${report.verification.failed}`);

	// Cost
	lines.push("");
	lines.push("## Cost");
	lines.push("");
	lines.push(`**Total**: ${formatCost(report.cost.total)}`);
	const phaseEntries = Object.entries(report.cost.byPhase) as [Phase, PhaseCost][];
	if (phaseEntries.length > 0) {
		lines.push("");
		lines.push(`| Phase | Input Tokens | Output Tokens | Cost |`);
		lines.push(`|-------|-------------|---------------|------|`);
		for (const [phase, pc] of phaseEntries) {
			lines.push(`| ${phase} | ${pc.inputTokens.toLocaleString()} | ${pc.outputTokens.toLocaleString()} | $${pc.cost.toFixed(2)} |`);
		}
	}

	return lines.join("\n");
}

/**
 * Format report as compact terminal output.
 */
export function formatReportTerminal(report: RunReport): string {
	const dur = formatDuration(report.timeline.durationMs);
	const lines: string[] = [];

	lines.push(`Run: ${report.meta.id} (${report.meta.phase})`);
	if (report.meta.scope) lines.push(`Scope: ${report.meta.scope}`);
	lines.push(`Duration: ${dur}`);
	lines.push("");
	lines.push(
		`Issues: ${report.issues.total} found → ${report.issues.confirmed} confirmed, ${report.issues.false_positive} false`,
	);
	lines.push(
		`Tasks:  ${report.tasks.total} total → ${report.tasks.done} done, ${report.tasks.failed} failed, ${report.tasks.pending} pending`,
	);
	lines.push(
		`Verify: ${report.verification.overall_pass ? "PASS" : "FAIL"} (${report.verification.passed}/${report.verification.passed + report.verification.failed})`,
	);
	lines.push(`Cost:   ${formatCost(report.cost.total)}`);

	return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const result: Record<string, number> = {};
	for (const item of items) {
		const k = key(item);
		result[k] = (result[k] ?? 0) + 1;
	}
	return result;
}

