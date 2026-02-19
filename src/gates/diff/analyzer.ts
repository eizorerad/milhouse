import * as Diff from "diff";
import { checkLineForPatterns, isGeneratedFile } from "./patterns";
import type { DiffAnalysis, DiffHunk, FileDiff, SuspiciousPattern } from "./types";

// Analyze a unified diff string
export function analyzeDiff(diffText: string): DiffAnalysis {
	const files = parseDiff(diffText);
	const suspiciousPatterns: SuspiciousPattern[] = [];
	const generatedFiles: string[] = [];
	const largeFiles: { path: string; changes: number }[] = [];

	let totalAdditions = 0;
	let totalDeletions = 0;

	for (const file of files) {
		totalAdditions += file.additions;
		totalDeletions += file.deletions;

		// Check for generated files
		if (isGeneratedFile(file.path)) {
			generatedFiles.push(file.path);
		}

		// Check for large files
		const changes = file.additions + file.deletions;
		if (changes > 500) {
			largeFiles.push({ path: file.path, changes });
		}

		// Analyze hunks for suspicious patterns
		for (const hunk of file.hunks) {
			let lineNumber = hunk.newStart;
			for (const line of hunk.lines) {
				if (line.startsWith("+") && !line.startsWith("+++")) {
					const patterns = checkLineForPatterns(line.slice(1), file.path, lineNumber);
					suspiciousPatterns.push(...patterns);
				}
				if (!line.startsWith("-")) {
					lineNumber++;
				}
			}
		}
	}

	// Calculate hygiene score
	const score = calculateHygieneScore({
		totalAdditions,
		totalDeletions,
		suspiciousPatterns,
		generatedFiles,
		largeFiles,
		fileCount: files.length,
	});

	return {
		files,
		totalAdditions,
		totalDeletions,
		suspiciousPatterns,
		generatedFiles,
		largeFiles,
		score,
	};
}

// Parse unified diff into structured format
export function parseDiff(diffText: string): FileDiff[] {
	const files: FileDiff[] = [];
	const patches = Diff.parsePatch(diffText);

	for (const patch of patches) {
		const hunks: DiffHunk[] = patch.hunks.map((h) => ({
			oldStart: h.oldStart,
			oldLines: h.oldLines,
			newStart: h.newStart,
			newLines: h.newLines,
			lines: h.lines,
		}));

		let additions = 0;
		let deletions = 0;

		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) deletions++;
			}
		}

		// Determine status
		let status: FileDiff["status"] = "modified";
		if (patch.oldFileName === "/dev/null") status = "added";
		else if (patch.newFileName === "/dev/null") status = "deleted";
		else if (patch.oldFileName !== patch.newFileName) status = "renamed";

		files.push({
			path:
				patch.newFileName?.replace(/^b\//, "") ||
				patch.oldFileName?.replace(/^a\//, "") ||
				"unknown",
			oldPath: patch.oldFileName?.replace(/^a\//, ""),
			status,
			hunks,
			additions,
			deletions,
			binary: false,
		});
	}

	return files;
}

// Compare two strings and create diff
export function createDiff(oldStr: string, newStr: string, fileName = "file"): string {
	return Diff.createPatch(fileName, oldStr, newStr);
}

// Calculate hygiene score (0-100)
function calculateHygieneScore(metrics: {
	totalAdditions: number;
	totalDeletions: number;
	suspiciousPatterns: SuspiciousPattern[];
	generatedFiles: string[];
	largeFiles: { path: string; changes: number }[];
	fileCount: number;
}): number {
	let score = 100;

	// Deduct for suspicious patterns
	for (const pattern of metrics.suspiciousPatterns) {
		switch (pattern.severity) {
			case "critical":
				score -= 20;
				break;
			case "high":
				score -= 10;
				break;
			case "medium":
				score -= 5;
				break;
			case "low":
				score -= 2;
				break;
		}
	}

	// Deduct for large files
	score -= metrics.largeFiles.length * 5;

	// Bonus for small, focused changes
	const totalChanges = metrics.totalAdditions + metrics.totalDeletions;
	if (totalChanges < 100 && metrics.fileCount <= 5) {
		score += 10;
	}

	return Math.max(0, Math.min(100, score));
}
