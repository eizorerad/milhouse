/**
 * @fileoverview Domain Config Barrel Export
 *
 * Central export point for domain config types, schemas, and defaults.
 *
 * @module domain/config
 * @since 5.0.0
 */

// Pure TypeScript types (no dependencies)
export type {
	ProjectInfo,
	CommandsConfig,
	BoundariesConfig,
	AllowedCommandsConfig,
	ExecutionConfig,
	GatesConfig,
	PipelineConfig,
	RunsConfig,
	GateProfilesConfig,
	MilhouseConfig,
	DetectedProject,
	ExecutionMode,
	PipelinePhase,
	RetryPolicy,
	CleanupPolicy,
	GateProfile,
} from "./types.ts";

// Directory constants and helpers
export {
	MILHOUSE_DIR,
	CONFIG_FILE,
	PROGRESS_FILE,
	STATE_DIR,
	PROBES_DIR,
	PLANS_DIR,
	WORK_DIR,
	RULES_DIR,
	RUNS_DIR,
	DIRECTORIES,
	PROBE_SUBDIRS,
	WORK_SUBDIRS,
	STATE_SUBDIRS,
	getDirectoryRelativePath,
	getProbeRelativePath,
	getWorkRelativePath,
	getStateRelativePath,
	getRunRelativePath,
	getAllDirectoryRelativePaths,
	getConfigFileRelativePath,
	getProgressFileRelativePath,
} from "./directories.ts";

export type {
	DirectoryKey,
	ProbeSubdir,
	WorkSubdir,
	StateSubdir,
} from "./directories.ts";

// Zod schemas (requires zod dependency)
export {
	CONFIG_VERSION,
	ProjectInfoSchema,
	CommandsConfigSchema,
	BoundariesConfigSchema,
	AllowedCommandsConfigSchema,
	ExecutionModeSchema,
	ExecutionConfigSchema,
	GatesConfigSchema,
	PipelinePhaseSchema,
	RetryPolicySchema,
	PipelineConfigSchema,
	CleanupPolicySchema,
	RunsConfigSchema,
	GateProfileSchema,
	GateProfilesConfigSchema,
	ConfigSchemaV1,
	CurrentConfigSchema,
} from "./schema.ts";

export type { InferredMilhouseConfig } from "./schema.ts";

// Default values
export {
	DEFAULT_PROJECT_INFO,
	DEFAULT_COMMANDS_CONFIG,
	DEFAULT_BOUNDARIES_CONFIG,
	DEFAULT_ALLOWED_COMMANDS_CONFIG,
	DEFAULT_EXECUTION_CONFIG,
	DEFAULT_GATES_CONFIG,
	DEFAULT_PHASE_TIMEOUTS,
	DEFAULT_RETRY_POLICY,
	DEFAULT_RETRY_POLICIES,
	DEFAULT_PIPELINE_CONFIG,
	DEFAULT_RUNS_CONFIG,
	DEFAULT_GATE_PROFILES_CONFIG,
	DEFAULT_CONFIG_V1,
	getCurrentDefaults,
	mergeWithDefaults,
} from "./defaults.ts";
