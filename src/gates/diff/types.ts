import { z } from "zod";

// Diff hunk schema
export const DiffHunkSchema = z.object({
	oldStart: z.number(),
	oldLines: z.number(),
	newStart: z.number(),
	newLines: z.number(),
	lines: z.array(z.string()),
});

// File diff schema
export const FileDiffSchema = z.object({
	path: z.string(),
	oldPath: z.string().optional(),
	status: z.enum(["added", "modified", "deleted", "renamed"]),
	hunks: z.array(DiffHunkSchema),
	additions: z.number(),
	deletions: z.number(),
	binary: z.boolean().default(false),
});

// Diff analysis result
export const DiffAnalysisSchema = z.object({
	files: z.array(FileDiffSchema),
	totalAdditions: z.number(),
	totalDeletions: z.number(),
	suspiciousPatterns: z.array(
		z.object({
			pattern: z.string(),
			file: z.string(),
			line: z.number(),
			severity: z.enum(["low", "medium", "high", "critical"]),
			description: z.string(),
		}),
	),
	generatedFiles: z.array(z.string()),
	largeFiles: z.array(
		z.object({
			path: z.string(),
			changes: z.number(),
		}),
	),
	score: z.number().min(0).max(100),
});

export type DiffHunk = z.infer<typeof DiffHunkSchema>;
export type FileDiff = z.infer<typeof FileDiffSchema>;
export type DiffAnalysis = z.infer<typeof DiffAnalysisSchema>;
export type SuspiciousPattern = DiffAnalysis["suspiciousPatterns"][number];
