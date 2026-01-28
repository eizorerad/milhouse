import { z } from "zod";

// Task status enum - expanded from simple boolean
export const TaskStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	"failed",
	"skipped",
	"blocked",
]);

// Task priority levels
export const TaskPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

// Task metadata - rich context about task origin and relationships
export const TaskMetadataSchema = z.object({
	source: z.string(),
	sourceFile: z.string().optional(),
	lineNumber: z.number().optional(),
	parallelGroup: z.number().optional(),
	dependencies: z.array(z.string()).default([]),
	labels: z.array(z.string()).default([]),
	assignee: z.string().optional(),
	dueDate: z.string().optional(),
	estimatedEffort: z.string().optional(),
});

// Core task schema with full validation
export const TaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().optional(),
	status: TaskStatusSchema.default("pending"),
	priority: TaskPrioritySchema.default("medium"),
	metadata: TaskMetadataSchema,
	createdAt: z.string().datetime().optional(),
	updatedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
});

// Task collection schema for batch operations
export const TaskCollectionSchema = z.object({
	tasks: z.array(TaskSchema),
	source: z.string(),
	lastSynced: z.string().datetime().optional(),
});

// Source configuration schema
export const TaskSourceConfigSchema = z.object({
	type: z.enum(["markdown", "markdown-folder", "yaml", "github"]),
	path: z.string().optional(),
	patterns: z.array(z.string()).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

// Export inferred types
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskCollection = z.infer<typeof TaskCollectionSchema>;
export type TaskSourceConfig = z.infer<typeof TaskSourceConfigSchema>;
