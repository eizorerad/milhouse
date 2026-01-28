import { theme } from "../../ui/theme";
import type { DiffAnalysis, SuspiciousPattern } from "./types";

// Generate a human-readable report
export function generateReport(analysis: DiffAnalysis): string {
	const lines: string[] = [];

	// Header
	lines.push(theme.bold("Diff Hygiene Report"));
	lines.push("═".repeat(50));
	lines.push("");

	// Summary
	lines.push(theme.bold("Summary:"));
	lines.push(`  Files changed: ${analysis.files.length}`);
	lines.push(`  Additions: ${theme.success(`+${analysis.totalAdditions}`)}`);
	lines.push(`  Deletions: ${theme.error(`-${analysis.totalDeletions}`)}`);
	lines.push(`  Score: ${formatScore(analysis.score)}`);
	lines.push("");

	// Suspicious patterns
	if (analysis.suspiciousPatterns.length > 0) {
		lines.push(theme.bold("Suspicious Patterns:"));

		const grouped = groupBySeverity(analysis.suspiciousPatterns);

		for (const [severity, patterns] of Object.entries(grouped)) {
			if (patterns.length === 0) continue;

			lines.push(
				`  ${formatSeverity(severity as "low" | "medium" | "high" | "critical")} (${patterns.length}):`,
			);
			for (const p of patterns.slice(0, 5)) {
				lines.push(`    • ${p.file}:${p.line} - ${p.description}`);
			}
			if (patterns.length > 5) {
				lines.push(`    ... and ${patterns.length - 5} more`);
			}
		}
		lines.push("");
	}

	// Generated files
	if (analysis.generatedFiles.length > 0) {
		lines.push(theme.bold("Generated Files (excluded from analysis):"));
		for (const file of analysis.generatedFiles.slice(0, 5)) {
			lines.push(`  • ${file}`);
		}
		if (analysis.generatedFiles.length > 5) {
			lines.push(`  ... and ${analysis.generatedFiles.length - 5} more`);
		}
		lines.push("");
	}

	// Large files
	if (analysis.largeFiles.length > 0) {
		lines.push(theme.bold("Large Changes (review carefully):"));
		for (const file of analysis.largeFiles) {
			lines.push(`  • ${file.path} (${file.changes} changes)`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// Generate JSON report
export function generateJsonReport(analysis: DiffAnalysis): string {
	return JSON.stringify(analysis, null, 2);
}

// Format score with color
function formatScore(score: number): string {
	if (score >= 80) return theme.success(`${score}/100`);
	if (score >= 60) return theme.warning(`${score}/100`);
	return theme.error(`${score}/100`);
}

// Format severity with color
function formatSeverity(severity: "low" | "medium" | "high" | "critical"): string {
	switch (severity) {
		case "critical":
			return theme.error("CRITICAL");
		case "high":
			return theme.error("HIGH");
		case "medium":
			return theme.warning("MEDIUM");
		case "low":
			return theme.muted("LOW");
	}
}

// Group patterns by severity
function groupBySeverity(patterns: SuspiciousPattern[]): Record<string, SuspiciousPattern[]> {
	return {
		critical: patterns.filter((p) => p.severity === "critical"),
		high: patterns.filter((p) => p.severity === "high"),
		medium: patterns.filter((p) => p.severity === "medium"),
		low: patterns.filter((p) => p.severity === "low"),
	};
}
