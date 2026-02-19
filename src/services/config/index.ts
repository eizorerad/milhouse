/**
 * @fileoverview Config Services Barrel Export
 *
 * Central export point for configuration services.
 *
 * @module services/config
 * @since 5.0.0
 */

// Types
export type {
	Result,
	ConfigLoadError,
	ConfigSaveError,
	ConfigLoadResult,
	ConfigSaveResult,
	ConfigStore,
	ConfigStoreOptions,
	IConfigService,
	IProjectDetector,
	IDirectoryService,
	DirectoryResult,
} from "./types.ts";

export { formatLoadError, formatSaveError } from "./types.ts";

// YamlFsConfigStore
export { YamlFsConfigStore, createYamlFsConfigStore } from "./YamlFsConfigStore.ts";

// ConfigService
export {
	ConfigService,
	createConfigService,
	getConfigService,
	resetDefaultServices,
	clearGlobalConfigCache,
	logTaskProgress,
} from "./ConfigService.ts";

export type { ConfigServiceOptions } from "./ConfigService.ts";

// Migration
export {
	needsMigration,
	getVersion,
	migrateConfig,
	getMigrationPath,
	hasMigrationPath,
	registerMigration,
	clearCustomMigrations,
} from "./migration.ts";

export type { MigrationFn } from "./migration.ts";

// ProjectDetector
export {
	ProjectDetector,
	createProjectDetector,
	detectProject,
	DETECTION_CONFIG,
} from "./ProjectDetector.ts";

// DirectoryService
export {
	DirectoryService,
	createDirectoryService,
	getDirectoryService,
	resetDirectoryService,
} from "./DirectoryService.ts";
