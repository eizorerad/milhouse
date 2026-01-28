/**
 * @fileoverview Config Module Barrel Export
 *
 * Central export point for configuration functionality.
 * Re-exports from services/config and domain/config.
 *
 * @module config
 * @since 5.0.0
 *
 * Modern imports:
 * - Types: import from `domain/config/types`
 * - Services: import from `services/config`
 * - Directories: import from `domain/config/directories`
 */

// ============================================================================
// Modern exports - Domain types
// ============================================================================

export type {
	MilhouseConfig,
	ProjectInfo,
	CommandsConfig,
	BoundariesConfig,
	AllowedCommandsConfig,
	ProbeConfig,
	ExecutionConfig,
	GatesConfig,
	PipelineConfig,
	RunsConfig,
	DetectedProject,
	ExecutionMode,
} from "../domain/config/types.ts";

// ============================================================================
// Modern exports - Directory constants
// ============================================================================

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
	type DirectoryKey,
	type ProbeSubdir,
	type WorkSubdir,
	type StateSubdir,
	getDirectoryRelativePath,
	getProbeRelativePath,
	getWorkRelativePath,
	getStateRelativePath,
	getRunRelativePath,
	getAllDirectoryRelativePaths,
	getConfigFileRelativePath,
	getProgressFileRelativePath,
} from "../domain/config/directories.ts";

// ============================================================================
// Modern exports - Services
// ============================================================================

export {
	ConfigService,
	createConfigService,
	getConfigService,
	resetDefaultServices,
	clearGlobalConfigCache,
	logTaskProgress,
} from "../services/config/ConfigService.ts";

export {
	DirectoryService,
	createDirectoryService,
	getDirectoryService,
	resetDirectoryService,
} from "../services/config/DirectoryService.ts";

export {
	ProjectDetector,
	detectProject,
	DETECTION_CONFIG,
} from "../services/config/ProjectDetector.ts";

export {
	YamlFsConfigStore,
	createYamlFsConfigStore,
} from "../services/config/YamlFsConfigStore.ts";

export type {
	ConfigStore,
	ConfigStoreOptions,
	IConfigService,
	IDirectoryService,
	Result,
	ConfigLoadError,
	ConfigSaveError,
	DirectoryResult,
} from "../services/config/types.ts";

export {
	formatLoadError,
	formatSaveError,
} from "../services/config/types.ts";

// ============================================================================
// Modern exports - Schema
// ============================================================================

export {
	CONFIG_VERSION,
	CurrentConfigSchema,
	ProjectInfoSchema,
	CommandsConfigSchema,
	BoundariesConfigSchema,
	AllowedCommandsConfigSchema,
	ProbeConfigSchema,
	ExecutionModeSchema,
	ExecutionConfigSchema,
	GatesConfigSchema,
	PipelinePhaseSchema,
	RetryPolicySchema,
	PipelineConfigSchema,
	CleanupPolicySchema,
	RunsConfigSchema,
	ProbePresetSchema,
	ProbePresetsConfigSchema,
	GateProfileSchema,
	GateProfilesConfigSchema,
	ConfigSchemaV1,
	parseConfig,
	safeParseConfig,
	getConfigVersion,
	type InferredMilhouseConfig,
} from "../domain/config/schema.ts";

// ============================================================================
// Legacy type exports - From types.ts (for backward compatibility)
// ============================================================================

export {
	// Zod schemas (legacy names - re-exported from types.ts)
	ProjectSchema,
	CommandsSchema,
	BoundariesSchema,
	AllowedCommandsSchema,
	MilhouseConfigSchema,
	// Legacy types
	type ScanScope,
	type RuntimeOptions,
	// Legacy constants
	DEFAULT_OPTIONS,
} from "./types.ts";
