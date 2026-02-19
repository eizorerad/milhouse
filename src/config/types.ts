/**
 * Configuration Types Module
 *
 * Legacy barrel that historically re-defined CLI RuntimeOptions.
 *
 * @module config/types
 * @deprecated Import from 'cli/runtime-options' (CLI) or 'domain/config' (persisted config)
 */

// Re-export directory constants from domain layer
export {
	MILHOUSE_DIR,
	CONFIG_FILE,
	PROGRESS_FILE,
	STATE_DIR,
	PROBES_DIR,
	PLANS_DIR,
	WORK_DIR,
	DIRECTORIES,
} from "../domain/config/directories.ts";

// Re-export Zod schemas from domain layer
export {
	ProjectInfoSchema as ProjectSchema,
	CommandsConfigSchema as CommandsSchema,
	BoundariesConfigSchema as BoundariesSchema,
	AllowedCommandsConfigSchema as AllowedCommandsSchema,
	ProbeConfigSchema,
	CurrentConfigSchema as MilhouseConfigSchema,
} from "../domain/config/schema.ts";

// Re-export types from domain layer
export type {
	MilhouseConfig,
	ProjectInfo,
	CommandsConfig,
	BoundariesConfig,
	AllowedCommandsConfig,
	ProbeConfig,
	ExecutionConfig,
	GatesConfig,
} from "../domain/config/types.ts";

// Re-export CLI RuntimeOptions from the canonical source.
// This keeps legacy imports working and ensures DEFAULT_OPTIONS is the same reference.
export type { ExecutionMode, RuntimeOptions, ScanScope } from "../cli/runtime-options.ts";
export { DEFAULT_OPTIONS } from "../cli/runtime-options.ts";
