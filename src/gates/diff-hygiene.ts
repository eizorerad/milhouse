import * as path from "node:path";
import { getDiffContent, getDiffStats } from "../vcs";
import {
	type DiffAnalysis as NewDiffAnalysis,
	type SuspiciousPattern,
	analyzeDiff as analyzeWithDiffPackage,
	createDiff,
	generateJsonReport,
	generateReport,
} from "./diff";
import {
	type DiffAnalysis,
	type DiffChangeType,
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateSeverity,
	type GateViolation,
	createGateResult,
	createGateViolation,
	getGateConfig,
	shouldExcludeFile,
} from "./types.ts";

/**
 * Diff hygiene violation types
 */
export type DiffHygieneViolationType =
	| "silent_refactor" // Undeclared structural changes
	| "extra_file" // Files changed that weren't declared in task
	| "whitespace_bomb" // Excessive whitespace-only changes
	| "formatting_only" // Pure formatting changes without content
	| "undeclared_rename" // Variable/function renamed without declaration
	| "large_diff" // Unusually large diff for the task scope
	| "unrelated_change"; // Changes unrelated to the task description

/**
 * Configuration options for diff hygiene gate
 */
export interface DiffHygieneOptions {
	/** Maximum allowed whitespace-only line changes */
	maxWhitespaceChanges: number;
	/** Whether to check for formatting-only changes */
	checkFormatting: boolean;
	/** Maximum lines changed before flagging as large diff */
	maxLinesChanged: number;
	/** Whether to require file declarations in tasks */
	requireFilesDeclaration: boolean;
	/** Patterns to ignore for whitespace checks */
	whitespaceIgnorePatterns: string[];
}

/**
 * Default diff hygiene options
 */
export const DEFAULT_DIFF_HYGIENE_OPTIONS: DiffHygieneOptions = {
	maxWhitespaceChanges: 10,
	checkFormatting: true,
	maxLinesChanged: 500,
	requireFilesDeclaration: false,
	whitespaceIgnorePatterns: ["*.md", "*.txt", "*.json", "*.yaml", "*.yml"],
};

/**
 * Git diff statistics for a file
 */
export interface DiffStats {
	/** File path */
	file: string;
	/** Number of lines added */
	linesAdded: number;
	/** Number of lines removed */
	linesRemoved: number;
	/** Whether file is new */
	isNew: boolean;
	/** Whether file is deleted */
	isDeleted: boolean;
	/** Whether file is renamed */
	isRenamed: boolean;
	/** Original file path if renamed */
	originalPath?: string;
	/** Binary file flag */
	isBinary: boolean;
}

/**
 * Detailed line change information
 */
export interface LineChange {
	/** Line number in the original file (null for added lines) */
	oldLineNumber: number | null;
	/** Line number in the new file (null for removed lines) */
	newLineNumber: number | null;
	/** The actual line content */
	content: string;
	/** Type of change */
	type: "added" | "removed" | "context";
}

/**
 * Parsed diff hunk
 */
export interface DiffHunk {
	/** Starting line in original file */
	oldStart: number;
	/** Number of lines in original file */
	oldCount: number;
	/** Starting line in new file */
	newStart: number;
	/** Number of lines in new file */
	newCount: number;
	/** Lines in the hunk */
	lines: LineChange[];
}

/**
 * Generate a unique gate ID
 */
export function generateGateId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `diff-hygiene-${timestamp}-${random}`;
}

/**
 * Parse git diff --numstat output
 */
export function parseDiffStats(numstatOutput: string): DiffStats[] {
	const stats: DiffStats[] = [];
	const lines = numstatOutput.trim().split("\n").filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;

		const [addedStr, removedStr, filePath] = parts;
		const isBinary = addedStr === "-" && removedStr === "-";

		// Handle renames (format: {old => new} or old => new)
		let file = filePath;
		let originalPath: string | undefined;
		let isRenamed = false;

		const renameMatch = filePath.match(/^(.+?)\{(.+?) => (.+?)\}(.*)$|^(.+?) => (.+?)$/);
		if (renameMatch) {
			isRenamed = true;
			if (renameMatch[1] !== undefined) {
				// Format: prefix{old => new}suffix
				originalPath = `${renameMatch[1]}${renameMatch[2]}${renameMatch[4]}`;
				file = `${renameMatch[1]}${renameMatch[3]}${renameMatch[4]}`;
			} else {
				// Format: old => new
				originalPath = renameMatch[5];
				file = renameMatch[6];
			}
		}

		stats.push({
			file,
			linesAdded: isBinary ? 0 : Number.parseInt(addedStr, 10),
			linesRemoved: isBinary ? 0 : Number.parseInt(removedStr, 10),
			isNew: false, // Will be determined later
			isDeleted: false, // Will be determined later
			isRenamed,
			originalPath,
			isBinary,
		});
	}

	return stats;
}

/**
 * Get diff stats for staged changes
 */
export async function getStagedDiffStats(workDir: string): Promise<DiffStats[]> {
	const result = await getDiffStats(workDir, { cached: true });
	return result.ok ? result.value : [];
}

/**
 * Get diff stats for unstaged changes
 */
export async function getUnstagedDiffStats(workDir: string): Promise<DiffStats[]> {
	const result = await getDiffStats(workDir, {});
	return result.ok ? result.value : [];
}

/**
 * Get diff stats comparing to a specific commit/branch
 */
export async function getDiffStatsAgainstRef(workDir: string, ref: string): Promise<DiffStats[]> {
	const result = await getDiffStats(workDir, { ref });
	return result.ok ? result.value : [];
}

/**
 * Get the actual diff content for a file
 */
export async function getFileDiff(workDir: string, filePath: string, cached = false): Promise<string> {
	const result = await getDiffContent(workDir, { cached, file: filePath });
	return result.ok ? result.value : "";
}

/**
 * Parse unified diff into hunks
 */
export function parseDiffHunks(diffContent: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	const lines = diffContent.split("\n");
	let currentHunk: DiffHunk | null = null;
	let oldLineNumber = 0;
	let newLineNumber = 0;

	for (const line of lines) {
		// Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
		const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
		if (hunkMatch) {
			if (currentHunk) {
				hunks.push(currentHunk);
			}
			currentHunk = {
				oldStart: Number.parseInt(hunkMatch[1], 10),
				oldCount: hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1,
				newStart: Number.parseInt(hunkMatch[3], 10),
				newCount: hunkMatch[4] ? Number.parseInt(hunkMatch[4], 10) : 1,
				lines: [],
			};
			oldLineNumber = currentHunk.oldStart;
			newLineNumber = currentHunk.newStart;
			continue;
		}

		if (!currentHunk) continue;

		if (line.startsWith("+") && !line.startsWith("+++")) {
			currentHunk.lines.push({
				oldLineNumber: null,
				newLineNumber,
				content: line.substring(1),
				type: "added",
			});
			newLineNumber++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			currentHunk.lines.push({
				oldLineNumber,
				newLineNumber: null,
				content: line.substring(1),
				type: "removed",
			});
			oldLineNumber++;
		} else if (line.startsWith(" ")) {
			currentHunk.lines.push({
				oldLineNumber,
				newLineNumber,
				content: line.substring(1),
				type: "context",
			});
			oldLineNumber++;
			newLineNumber++;
		}
	}

	if (currentHunk) {
		hunks.push(currentHunk);
	}

	return hunks;
}

/**
 * Check if a change is whitespace-only
 */
export function isWhitespaceOnlyChange(oldContent: string, newContent: string): boolean {
	const normalizeWhitespace = (s: string): string => s.replace(/\s+/g, " ").trim();
	return normalizeWhitespace(oldContent) === normalizeWhitespace(newContent);
}

/**
 * Analyze a diff hunk for whitespace-only changes
 */
export function analyzeHunkForWhitespace(hunk: DiffHunk): {
	whitespaceOnlyChanges: number;
	meaningfulChanges: number;
} {
	let whitespaceOnlyChanges = 0;
	let meaningfulChanges = 0;

	const removedLines = hunk.lines.filter((l) => l.type === "removed");
	const addedLines = hunk.lines.filter((l) => l.type === "added");

	// Pair up removed and added lines to check for whitespace-only changes
	const minLength = Math.min(removedLines.length, addedLines.length);

	for (let i = 0; i < minLength; i++) {
		if (isWhitespaceOnlyChange(removedLines[i].content, addedLines[i].content)) {
			whitespaceOnlyChanges++;
		} else {
			meaningfulChanges++;
		}
	}

	// Count remaining unpaired lines as meaningful changes
	meaningfulChanges += Math.abs(removedLines.length - addedLines.length);

	return { whitespaceOnlyChanges, meaningfulChanges };
}

/**
 * Detect if a file change is a rename with minimal content changes
 */
export function detectSilentRename(
	workDir: string,
	stats: DiffStats,
): { isRename: boolean; similarity: number } {
	if (!stats.isRenamed || !stats.originalPath) {
		return { isRename: false, similarity: 0 };
	}

	// Git already detected it as a rename, calculate similarity
	const totalChanges = stats.linesAdded + stats.linesRemoved;
	// Similarity is inverse of changes - fewer changes = higher similarity
	const similarity = totalChanges === 0 ? 100 : Math.max(0, 100 - totalChanges);

	return { isRename: true, similarity };
}

/**
 * Categorize the type of change in a file
 */
export async function categorizeChange(
	workDir: string,
	filePath: string,
	stats: DiffStats,
): Promise<DiffChangeType> {
	// Check for rename
	if (stats.isRenamed) {
		return "rename";
	}

	// Get the diff content for deeper analysis
	const diffContent = (await getFileDiff(workDir, filePath, true)) || (await getFileDiff(workDir, filePath));
	if (!diffContent) {
		return "unknown";
	}

	const hunks = parseDiffHunks(diffContent);
	let totalWhitespaceChanges = 0;
	let totalMeaningfulChanges = 0;

	for (const hunk of hunks) {
		const { whitespaceOnlyChanges, meaningfulChanges } = analyzeHunkForWhitespace(hunk);
		totalWhitespaceChanges += whitespaceOnlyChanges;
		totalMeaningfulChanges += meaningfulChanges;
	}

	// Pure whitespace change
	if (totalMeaningfulChanges === 0 && totalWhitespaceChanges > 0) {
		return "whitespace";
	}

	// Mostly whitespace changes
	if (totalWhitespaceChanges > 0 && totalWhitespaceChanges > totalMeaningfulChanges * 2) {
		return "formatting";
	}

	// Check for code movement (similar lines removed and added)
	const removedContent = hunks
		.flatMap((h) => h.lines.filter((l) => l.type === "removed").map((l) => l.content.trim()))
		.filter(Boolean);
	const addedContent = hunks
		.flatMap((h) => h.lines.filter((l) => l.type === "added").map((l) => l.content.trim()))
		.filter(Boolean);

	const matchingLines = removedContent.filter((r) => addedContent.includes(r));
	if (matchingLines.length > removedContent.length * 0.5) {
		return "move";
	}

	// Default categorization based on net changes
	if (stats.linesAdded > stats.linesRemoved * 2) {
		return "feature";
	}

	if (stats.linesRemoved > stats.linesAdded * 2) {
		return "refactor";
	}

	if (Math.abs(stats.linesAdded - stats.linesRemoved) < 10) {
		return "fix";
	}

	return "unknown";
}

/**
 * Analyze all diffs and return analysis results
 */
export async function analyzeDiffs(
	workDir: string,
	stats: DiffStats[],
	declaredFiles: string[] = [],
): Promise<DiffAnalysis[]> {
	const analyses: DiffAnalysis[] = [];
	const declaredSet = new Set(declaredFiles.map((f) => path.normalize(f)));

	for (const stat of stats) {
		const changeType = await categorizeChange(workDir, stat.file, stat);
		const normalizedPath = path.normalize(stat.file);
		const isDeclared = declaredSet.size === 0 || declaredSet.has(normalizedPath);

		analyses.push({
			file: stat.file,
			changeType,
			linesAdded: stat.linesAdded,
			linesRemoved: stat.linesRemoved,
			isDeclared,
			description: getChangeDescription(changeType, stat),
		});
	}

	return analyses;
}

/**
 * Get human-readable description of a change
 */
export function getChangeDescription(changeType: DiffChangeType, stats: DiffStats): string {
	const netChange = stats.linesAdded - stats.linesRemoved;
	const changeDir = netChange > 0 ? "added" : netChange < 0 ? "removed" : "modified";

	switch (changeType) {
		case "whitespace":
			return `Whitespace-only changes (${stats.linesAdded} added, ${stats.linesRemoved} removed)`;
		case "formatting":
			return `Formatting changes (${stats.linesAdded} added, ${stats.linesRemoved} removed)`;
		case "rename":
			return `Renamed from ${stats.originalPath ?? "unknown"}`;
		case "move":
			return `Code movement (${stats.linesAdded} added, ${stats.linesRemoved} removed)`;
		case "refactor":
			return `Refactoring (net ${Math.abs(netChange)} lines ${changeDir})`;
		case "feature":
			return `New feature code (${stats.linesAdded} lines added)`;
		case "fix":
			return `Bug fix (${stats.linesAdded} added, ${stats.linesRemoved} removed)`;
		default:
			return `Unknown change type (${stats.linesAdded} added, ${stats.linesRemoved} removed)`;
	}
}

/**
 * Determine violation severity based on change type and context
 */
export function getViolationSeverity(
	violationType: DiffHygieneViolationType,
	analysis: DiffAnalysis,
): GateSeverity {
	switch (violationType) {
		case "silent_refactor":
			// Silent refactors in core files are critical
			if (analysis.file.includes("/core/") || analysis.file.includes("/api/")) {
				return "CRITICAL";
			}
			return "HIGH";

		case "extra_file":
			// Extra files in sensitive areas are more concerning
			if (
				analysis.file.includes("config") ||
				analysis.file.includes("auth") ||
				analysis.file.includes("security")
			) {
				return "HIGH";
			}
			return "MEDIUM";

		case "whitespace_bomb":
			// Large whitespace changes are suspicious
			if (analysis.linesAdded + analysis.linesRemoved > 100) {
				return "HIGH";
			}
			return "MEDIUM";

		case "formatting_only":
			return "LOW";

		case "undeclared_rename":
			return "MEDIUM";

		case "large_diff":
			// Very large diffs are more concerning
			if (analysis.linesAdded + analysis.linesRemoved > 1000) {
				return "HIGH";
			}
			return "MEDIUM";

		case "unrelated_change":
			return "HIGH";

		default:
			return "MEDIUM";
	}
}

/**
 * Check for whitespace bomb (excessive whitespace-only changes)
 */
export function checkWhitespaceBomb(
	analysis: DiffAnalysis,
	options: DiffHygieneOptions,
): GateViolation | null {
	if (analysis.changeType !== "whitespace" && analysis.changeType !== "formatting") {
		return null;
	}

	// Skip if file matches whitespace ignore patterns
	for (const pattern of options.whitespaceIgnorePatterns) {
		if (pattern.startsWith("*.")) {
			const ext = pattern.slice(1);
			if (analysis.file.endsWith(ext)) {
				return null;
			}
		}
	}

	const totalChanges = analysis.linesAdded + analysis.linesRemoved;
	if (totalChanges > options.maxWhitespaceChanges) {
		const severity = getViolationSeverity("whitespace_bomb", analysis);
		return createGateViolation(
			`whitespace-bomb-${analysis.file}`,
			"Whitespace bomb detected",
			`File ${analysis.file} has ${totalChanges} whitespace-only changes (max: ${options.maxWhitespaceChanges}). Large whitespace-only changes may hide meaningful modifications or indicate formatting tool issues.`,
			severity,
			{
				file: analysis.file,
				suggestion:
					"Review whitespace changes carefully or run formatter separately before making code changes",
				metadata: {
					linesAdded: analysis.linesAdded,
					linesRemoved: analysis.linesRemoved,
					changeType: analysis.changeType,
				},
			},
		);
	}

	return null;
}

/**
 * Check for silent refactors (undeclared structural changes)
 */
export function checkSilentRefactor(
	analysis: DiffAnalysis,
	options: DiffHygieneOptions,
): GateViolation | null {
	// Only flag if files declaration is required and file wasn't declared
	if (!options.requireFilesDeclaration || analysis.isDeclared) {
		return null;
	}

	// Only flag refactors, moves, and renames
	if (!["refactor", "move", "rename"].includes(analysis.changeType)) {
		return null;
	}

	const severity = getViolationSeverity("silent_refactor", analysis);
	return createGateViolation(
		`silent-refactor-${analysis.file}`,
		"Silent refactor detected",
		`File ${analysis.file} contains ${analysis.changeType} changes that were not declared in the task. Structural changes should be explicitly declared to maintain traceability.`,
		severity,
		{
			file: analysis.file,
			suggestion:
				"Declare this file in the task's files array or create a separate refactoring task",
			metadata: {
				changeType: analysis.changeType,
				linesAdded: analysis.linesAdded,
				linesRemoved: analysis.linesRemoved,
			},
		},
	);
}

/**
 * Check for extra files (undeclared file changes)
 */
export function checkExtraFile(
	analysis: DiffAnalysis,
	options: DiffHygieneOptions,
): GateViolation | null {
	if (!options.requireFilesDeclaration || analysis.isDeclared) {
		return null;
	}

	// Only flag files with meaningful changes
	if (["whitespace", "formatting"].includes(analysis.changeType)) {
		return null;
	}

	const severity = getViolationSeverity("extra_file", analysis);
	return createGateViolation(
		`extra-file-${analysis.file}`,
		"Undeclared file modification",
		`File ${analysis.file} was modified but not declared in the task's files array. All file modifications should be declared to ensure proper scope control.`,
		severity,
		{
			file: analysis.file,
			suggestion: "Add this file to the task's files array or move changes to a separate task",
			metadata: {
				changeType: analysis.changeType,
				linesAdded: analysis.linesAdded,
				linesRemoved: analysis.linesRemoved,
			},
		},
	);
}

/**
 * Check for large diffs
 */
export function checkLargeDiff(
	analysis: DiffAnalysis,
	options: DiffHygieneOptions,
): GateViolation | null {
	const totalChanges = analysis.linesAdded + analysis.linesRemoved;

	if (totalChanges <= options.maxLinesChanged) {
		return null;
	}

	const severity = getViolationSeverity("large_diff", analysis);
	return createGateViolation(
		`large-diff-${analysis.file}`,
		"Large diff detected",
		`File ${analysis.file} has ${totalChanges} lines changed (max: ${options.maxLinesChanged}). Large diffs are harder to review and may indicate scope creep.`,
		severity,
		{
			file: analysis.file,
			suggestion: "Consider breaking this change into smaller, more focused commits",
			metadata: {
				linesAdded: analysis.linesAdded,
				linesRemoved: analysis.linesRemoved,
				totalChanges,
			},
		},
	);
}

/**
 * Diff Hygiene Gate
 *
 * Checks for problematic diff patterns:
 * - Silent refactors (undeclared structural changes)
 * - Extra files (modifications outside declared scope)
 * - Whitespace bombs (excessive formatting-only changes)
 * - Large diffs (scope creep indicators)
 *
 * Purpose: Ensure that all code changes are intentional, declared,
 * and properly scoped to their tasks.
 */
export async function runDiffHygieneGate(
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const startTime = Date.now();
	const gateId = generateGateId();
	const config = { ...getGateConfig("diff-hygiene"), ...configOverrides };

	const options: DiffHygieneOptions = {
		...DEFAULT_DIFF_HYGIENE_OPTIONS,
		...(config.options as Partial<DiffHygieneOptions>),
	};

	const violations: GateViolation[] = [];
	let filesChecked = 0;
	const gateEvidence: GateResult["evidence"] = [];

	try {
		// Get diff stats - prefer staged changes, fall back to unstaged
		let diffStats = await getStagedDiffStats(input.workDir);
		const diffSource = diffStats.length > 0 ? "staged" : "unstaged";

		if (diffStats.length === 0) {
			diffStats = await getUnstagedDiffStats(input.workDir);
		}

		// If specific targets provided, filter to those files
		if (input.targets.length > 0) {
			const targetSet = new Set(input.targets.map((t) => path.normalize(t)));
			diffStats = diffStats.filter((s) => targetSet.has(path.normalize(s.file)));
		}

		// Filter out excluded files
		diffStats = diffStats.filter((s) => !shouldExcludeFile(s.file, config.exclude_patterns));

		filesChecked = diffStats.length;

		if (filesChecked === 0) {
			const durationMs = Date.now() - startTime;
			return createGateResult(gateId, "diff-hygiene", true, {
				message: "No diff changes to analyze",
				violations: [],
				evidence: [],
				duration_ms: durationMs,
				files_checked: 0,
				items_checked: 0,
			});
		}

		// Analyze all diffs
		const analyses = await analyzeDiffs(input.workDir, diffStats, input.targets);

		// Record evidence of what we analyzed
		gateEvidence.push({
			type: "command",
			command: `git diff --numstat (${diffSource})`,
			output: `Analyzed ${filesChecked} files`,
			timestamp: new Date().toISOString(),
		});

		// Run checks on each analysis
		for (const analysis of analyses) {
			// Check for whitespace bombs
			const whitespaceViolation = checkWhitespaceBomb(analysis, options);
			if (whitespaceViolation) {
				violations.push(whitespaceViolation);
			}

			// Check for silent refactors
			const silentRefactorViolation = checkSilentRefactor(analysis, options);
			if (silentRefactorViolation) {
				violations.push(silentRefactorViolation);
			}

			// Check for extra files
			const extraFileViolation = checkExtraFile(analysis, options);
			if (extraFileViolation) {
				violations.push(extraFileViolation);
			}

			// Check for large diffs
			const largeDiffViolation = checkLargeDiff(analysis, options);
			if (largeDiffViolation) {
				violations.push(largeDiffViolation);
			}

			// Record file analysis as evidence
			gateEvidence.push({
				type: "file",
				file: analysis.file,
				timestamp: new Date().toISOString(),
			});
		}

		const durationMs = Date.now() - startTime;
		const passed = config.strict
			? violations.length === 0
			: !violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");

		return createGateResult(gateId, "diff-hygiene", passed, {
			message: passed
				? `Analyzed ${filesChecked} files with no hygiene issues`
				: `Found ${violations.length} diff hygiene issues in ${filesChecked} files`,
			violations,
			evidence: gateEvidence,
			duration_ms: durationMs,
			files_checked: filesChecked,
			items_checked: analyses.length,
		});
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		return createGateResult(gateId, "diff-hygiene", false, {
			message: `Diff hygiene gate failed: ${errorMessage}`,
			violations: [
				createGateViolation("gate-error", "Gate execution error", errorMessage, "CRITICAL"),
			],
			duration_ms: durationMs,
			files_checked: filesChecked,
			items_checked: 0,
		});
	}
}

/**
 * Check if a specific file has diff hygiene issues
 */
export async function checkFileDiffHygiene(
	workDir: string,
	filePath: string,
	options?: Partial<DiffHygieneOptions>,
): Promise<GateViolation[]> {
	const fullOptions: DiffHygieneOptions = {
		...DEFAULT_DIFF_HYGIENE_OPTIONS,
		...options,
	};

	const violations: GateViolation[] = [];

	// Get diff stats for this specific file
	let stats = await getStagedDiffStats(workDir);
	if (stats.length === 0) {
		stats = await getUnstagedDiffStats(workDir);
	}

	const fileStats = stats.find((s) => s.file === filePath);
	if (!fileStats) {
		return violations;
	}

	const analysis: DiffAnalysis = {
		file: fileStats.file,
		changeType: await categorizeChange(workDir, filePath, fileStats),
		linesAdded: fileStats.linesAdded,
		linesRemoved: fileStats.linesRemoved,
		isDeclared: true, // Assume declared when checking single file
	};

	const whitespaceViolation = checkWhitespaceBomb(analysis, fullOptions);
	if (whitespaceViolation) {
		violations.push(whitespaceViolation);
	}

	const largeDiffViolation = checkLargeDiff(analysis, fullOptions);
	if (largeDiffViolation) {
		violations.push(largeDiffViolation);
	}

	return violations;
}

/**
 * Get summary of diff hygiene analysis
 */
export function getDiffHygieneSummary(analyses: DiffAnalysis[]): {
	totalFiles: number;
	byChangeType: Record<DiffChangeType, number>;
	totalLinesAdded: number;
	totalLinesRemoved: number;
	undeclaredFiles: number;
} {
	const byChangeType: Record<DiffChangeType, number> = {
		whitespace: 0,
		formatting: 0,
		rename: 0,
		move: 0,
		refactor: 0,
		feature: 0,
		fix: 0,
		unknown: 0,
	};

	let totalLinesAdded = 0;
	let totalLinesRemoved = 0;
	let undeclaredFiles = 0;

	for (const analysis of analyses) {
		byChangeType[analysis.changeType]++;
		totalLinesAdded += analysis.linesAdded;
		totalLinesRemoved += analysis.linesRemoved;
		if (!analysis.isDeclared) {
			undeclaredFiles++;
		}
	}

	return {
		totalFiles: analyses.length,
		byChangeType,
		totalLinesAdded,
		totalLinesRemoved,
		undeclaredFiles,
	};
}

/**
 * Format diff hygiene summary for display
 */
export function formatDiffHygieneSummary(analyses: DiffAnalysis[]): string {
	const summary = getDiffHygieneSummary(analyses);
	const lines: string[] = [];

	lines.push(`Files analyzed: ${summary.totalFiles}`);
	lines.push(`Lines: +${summary.totalLinesAdded} / -${summary.totalLinesRemoved}`);

	const changeTypeCounts = Object.entries(summary.byChangeType)
		.filter(([, count]) => count > 0)
		.map(([type, count]) => `${type}: ${count}`)
		.join(", ");

	if (changeTypeCounts) {
		lines.push(`Change types: ${changeTypeCounts}`);
	}

	if (summary.undeclaredFiles > 0) {
		lines.push(`Undeclared files: ${summary.undeclaredFiles}`);
	}

	return lines.join("\n");
}

/**
 * Enhanced diff hygiene options using the diff package
 */
export interface EnhancedDiffHygieneOptions {
	/** Minimum hygiene score to pass (0-100) */
	minScore?: number;
	/** Patterns to allow (won't be flagged) */
	allowedPatterns?: string[];
	/** Maximum changes per file */
	maxFileChanges?: number;
	/** Maximum total changes across all files */
	maxTotalChanges?: number;
	/** Base branch to compare against */
	baseBranch?: string;
}

/**
 * Enhanced Diff Hygiene Gate using the diff package
 *
 * Provides more sophisticated diff analysis including:
 * - Pattern detection for security issues, code quality, and potential bugs
 * - Generated file detection
 * - Large file change detection
 * - Hygiene scoring (0-100)
 *
 * This is an enhanced version that uses the `diff` npm package for
 * more accurate diff parsing and analysis.
 */
export async function runEnhancedDiffHygieneGate(
	workDir: string,
	options: EnhancedDiffHygieneOptions = {},
): Promise<{
	passed: boolean;
	score: number;
	analysis: NewDiffAnalysis;
	report: string;
	issues: string[];
}> {
	const {
		minScore = 60,
		allowedPatterns = [],
		maxFileChanges = 1000,
		maxTotalChanges = 5000,
		baseBranch = "main",
	} = options;

	try {
		// Get diff from git
		const diffText = await getDiffFromGit(workDir, baseBranch);

		// Analyze diff using the diff package
		const analysis = analyzeWithDiffPackage(diffText);

		// Filter out allowed patterns
		const filteredPatterns = analysis.suspiciousPatterns.filter(
			(p) => !allowedPatterns.includes(p.pattern),
		);

		// Check thresholds
		const issues: string[] = [];

		if (analysis.score < minScore) {
			issues.push(`Hygiene score ${analysis.score} is below minimum ${minScore}`);
		}

		if (analysis.totalAdditions + analysis.totalDeletions > maxTotalChanges) {
			issues.push(`Total changes exceed maximum of ${maxTotalChanges}`);
		}

		for (const file of analysis.largeFiles) {
			if (file.changes > maxFileChanges) {
				issues.push(`File ${file.path} has ${file.changes} changes (max: ${maxFileChanges})`);
			}
		}

		const criticalPatterns = filteredPatterns.filter((p) => p.severity === "critical");
		if (criticalPatterns.length > 0) {
			issues.push(`Found ${criticalPatterns.length} critical issues`);
		}

		const passed = issues.length === 0;
		const report = generateReport({
			...analysis,
			suspiciousPatterns: filteredPatterns,
		});

		return {
			passed,
			score: analysis.score,
			analysis: { ...analysis, suspiciousPatterns: filteredPatterns },
			report,
			issues,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			passed: false,
			score: 0,
			analysis: {
				files: [],
				totalAdditions: 0,
				totalDeletions: 0,
				suspiciousPatterns: [],
				generatedFiles: [],
				largeFiles: [],
				score: 0,
			},
			report: `Error: ${errorMessage}`,
			issues: [errorMessage],
		};
	}
}

/**
 * Get diff from git comparing to a base branch
 */
async function getDiffFromGit(workDir: string, baseBranch = "main"): Promise<string> {
	// Try to get diff against base branch
	const result = await getDiffContent(workDir, { ref: baseBranch, unified: 3 });
	if (result.ok && result.value.trim()) {
		return result.value;
	}

	// If base branch doesn't exist, try to get staged diff
	const cachedResult = await getDiffContent(workDir, { cached: true, unified: 3 });
	if (cachedResult.ok && cachedResult.value.trim()) {
		return cachedResult.value;
	}

	// Fall back to unstaged diff
	const unstagedResult = await getDiffContent(workDir, { unified: 3 });
	if (unstagedResult.ok) {
		return unstagedResult.value;
	}

	return "";
}

/**
 * Analyze a diff string directly (useful for testing or non-git diffs)
 */
export function analyzeRawDiff(diffText: string): NewDiffAnalysis {
	return analyzeWithDiffPackage(diffText);
}

/**
 * Create a diff between two strings (useful for testing)
 */
export function createStringDiff(oldStr: string, newStr: string, fileName = "file"): string {
	return createDiff(oldStr, newStr, fileName);
}

/**
 * Generate a human-readable report from diff analysis
 */
export function generateDiffReport(analysis: NewDiffAnalysis): string {
	return generateReport(analysis);
}

/**
 * Generate a JSON report from diff analysis
 */
export function generateDiffJsonReport(analysis: NewDiffAnalysis): string {
	return generateJsonReport(analysis);
}

// Re-export types and functions from the diff module for convenience
export type { NewDiffAnalysis, SuspiciousPattern };
