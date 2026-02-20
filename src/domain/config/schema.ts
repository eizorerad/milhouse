/**
 * @fileoverview Domain Config Schema
 *
 * Versioned Zod schemas for Milhouse configuration validation.
 * Supports schema evolution with explicit version tracking.
 *
 * @module domain/config/schema
 * @since 5.0.0
 */

import { z } from "zod";
import type {
	AllowedCommandsConfig,
	BoundariesConfig,
	CleanupPolicy,
	CommandsConfig,
	ExecutionConfig,
	ExecutionMode,
	GateProfilesConfig,
	GatesConfig,
	MilhouseConfig,
	PipelineConfig,
	PipelinePhase,
	ProjectInfo,
	RetryPolicy,
	RunsConfig,
} from "./types.ts";

/**
 * Current configuration version
 *
 * Increment this when making breaking changes to the schema.
 * Use semantic versioning: MAJOR.MINOR
 */
export const CONFIG_VERSION = "1.0";

/**
 * Project info schema
 */
export const ProjectInfoSchema = z.object({
	name: z.string().default(""),
	language: z.string().default(""),
	framework: z.string().default(""),
	description: z.string().default(""),
}) satisfies z.ZodType<ProjectInfo>;

/**
 * Commands schema
 */
export const CommandsConfigSchema = z.object({
	test: z.string().default(""),
	lint: z.string().default(""),
	build: z.string().default(""),
	compile: z.string().default(""),
}) satisfies z.ZodType<CommandsConfig>;

/**
 * Boundaries schema
 */
export const BoundariesConfigSchema = z.object({
	never_touch: z.array(z.string()).default([]),
}) satisfies z.ZodType<BoundariesConfig>;

/**
 * Allowed commands schema
 */
export const AllowedCommandsConfigSchema = z.object({
	probes: z.array(z.string()).default([]),
	execution: z.array(z.string()).default([]),
}) satisfies z.ZodType<AllowedCommandsConfig>;

/**
 * Execution mode schema
 */
export const ExecutionModeSchema = z.enum([
	"in-place",
	"branch",
	"worktree",
	"pr",
]) satisfies z.ZodType<ExecutionMode>;

/**
 * Execution config schema
 */
export const ExecutionConfigSchema = z.object({
	mode: ExecutionModeSchema.default("branch"),
	parallel: z.number().default(4),
	auto_commit: z.boolean().default(true),
	create_pr: z.boolean().default(false),
	draft_pr: z.boolean().default(true),
}) satisfies z.ZodType<ExecutionConfig>;

/**
 * Gates config schema
 */
export const GatesConfigSchema = z.object({
	evidence_required: z.boolean().default(true),
	diff_hygiene: z.boolean().default(true),
	placeholder_check: z.boolean().default(true),
	dod_verification: z.boolean().default(true),
}) satisfies z.ZodType<GatesConfig>;

/**
 * Pipeline phase schema
 */
export const PipelinePhaseSchema = z.enum([
	"scan",
	"validate",
	"plan",
	"exec",
	"verify",
]) satisfies z.ZodType<PipelinePhase>;

/**
 * Retry policy schema
 */
export const RetryPolicySchema = z.object({
	maxRetries: z.number().default(3),
	delayMs: z.number().default(5000),
	exponentialBackoff: z.boolean().default(true),
}) satisfies z.ZodType<RetryPolicy>;

/**
 * Default phase timeouts in milliseconds
 */
const DEFAULT_PHASE_TIMEOUTS: Record<PipelinePhase, number> = {
	scan: 60000, // 1 minute
	validate: 120000, // 2 minutes
	plan: 180000, // 3 minutes
	exec: 4000000, // ~66 minutes
	verify: 120000, // 2 minutes
};

/**
 * Default retry policies per phase
 */
const DEFAULT_RETRY_POLICIES: Record<PipelinePhase, RetryPolicy> = {
	scan: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
	validate: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
	plan: { maxRetries: 3, delayMs: 5000, exponentialBackoff: true },
	exec: { maxRetries: 3, delayMs: 5000, exponentialBackoff: true },
	verify: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
};

/**
 * Pipeline config schema
 */
export const PipelineConfigSchema = z.object({
	defaultPhases: z
		.array(PipelinePhaseSchema)
		.default(["scan", "validate", "plan", "exec", "verify"]),
	phaseTimeouts: z.record(PipelinePhaseSchema, z.number()).default(DEFAULT_PHASE_TIMEOUTS),
	retryPolicy: z.record(PipelinePhaseSchema, RetryPolicySchema).default(DEFAULT_RETRY_POLICIES),
}) satisfies z.ZodType<PipelineConfig>;

/**
 * Cleanup policy schema
 */
export const CleanupPolicySchema = z.enum([
	"manual",
	"on-success",
	"always",
]) satisfies z.ZodType<CleanupPolicy>;

/**
 * Runs config schema
 */
export const RunsConfigSchema = z.object({
	runsDir: z.string().default(".milhouse/runs"),
	maxRunsToKeep: z.number().default(10),
	cleanupPolicy: CleanupPolicySchema.default("manual"),
}) satisfies z.ZodType<RunsConfig>;

/**
 * Gate profile schema
 */
export const GateProfileSchema = z.object({
	name: z.string(),
	description: z.string().default(""),
	gates: GatesConfigSchema,
});

/**
 * Gate profiles config schema
 */
export const GateProfilesConfigSchema = z.object({
	activeProfile: z.string().default("standard"),
	profiles: z.record(z.string(), GateProfileSchema).default({
		strict: {
			name: "strict",
			description: "All gates enabled with no exceptions",
			gates: {
				evidence_required: true,
				diff_hygiene: true,
				placeholder_check: true,

				dod_verification: true,
			},
		},
		standard: {
			name: "standard",
			description: "Balanced gate configuration for most projects",
			gates: {
				evidence_required: true,
				diff_hygiene: true,
				placeholder_check: true,

				dod_verification: true,
			},
		},
		relaxed: {
			name: "relaxed",
			description: "Minimal gates for rapid prototyping",
			gates: {
				evidence_required: false,
				diff_hygiene: true,
				placeholder_check: false,

				dod_verification: false,
			},
		},
	}),
}) satisfies z.ZodType<GateProfilesConfig>;

/**
 * Milhouse config schema v1.0
 *
 * This is the current schema version with all Milhouse-specific features.
 */
export const ConfigSchemaV1 = z.object({
	version: z.string().default(CONFIG_VERSION),
	project: ProjectInfoSchema.default({
		name: "",
		language: "",
		framework: "",
		description: "",
	}),
	commands: CommandsConfigSchema.default({
		test: "",
		lint: "",
		build: "",
		compile: "",
	}),
	rules: z.array(z.string()).default([]),
	boundaries: BoundariesConfigSchema.default({ never_touch: [] }),
	allowed_commands: AllowedCommandsConfigSchema.default({ probes: [], execution: [] }),
	execution: ExecutionConfigSchema.default({
		mode: "branch",
		parallel: 4,
		auto_commit: true,
		create_pr: false,
		draft_pr: true,
	}),
	gates: GatesConfigSchema.default({
		evidence_required: true,
		diff_hygiene: true,
		placeholder_check: true,
		dod_verification: true,
	}),
	pipeline: PipelineConfigSchema.optional(),
	runs: RunsConfigSchema.optional(),
	gateProfiles: GateProfilesConfigSchema.optional(),
}) satisfies z.ZodType<MilhouseConfig>;

/**
 * Current config schema
 *
 * Alias to the latest schema version for easy migration.
 */
export const CurrentConfigSchema = ConfigSchemaV1;

/**
 * Type inferred from the current schema
 */
export type InferredMilhouseConfig = z.infer<typeof CurrentConfigSchema>;
