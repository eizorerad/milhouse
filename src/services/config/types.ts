/**
 * @fileoverview Config Service Types
 *
 * Type definitions for configuration service interfaces.
 * Defines the contracts for config storage and operations.
 *
 * @module services/config/types
 * @since 5.0.0
 */

import type { DetectedProject, MilhouseConfig } from "../../domain/config/types.ts";

/**
 * Result type for operations that can fail
 *
 * A discriminated union that represents either success with a value
 * or failure with an error.
 */
export type Result<T, E = Error> = { success: true; value: T } | { success: false; error: E };

/**
 * Configuration load error types
 *
 * Represents all possible errors when loading configuration.
 */
export type ConfigLoadError =
	| { type: "not_found"; path: string }
	| { type: "parse_error"; path: string; message: string }
	| { type: "validation_error"; path: string; message: string }
	| { type: "permission_denied"; path: string }
	| { type: "migration_failed"; fromVersion: string; message: string }
	| { type: "unknown"; message: string };

/**
 * Configuration save error types
 *
 * Represents all possible errors when saving configuration.
 */
export type ConfigSaveError =
	| { type: "permission_denied"; path: string }
	| { type: "directory_not_found"; path: string }
	| { type: "serialization_error"; message: string }
	| { type: "atomic_write_failed"; path: string; message: string }
	| { type: "lock_failed"; path: string; message: string }
	| { type: "unknown"; message: string };

/**
 * Configuration load result
 */
export type ConfigLoadResult = Result<MilhouseConfig, ConfigLoadError>;

/**
 * Configuration save result
 */
export type ConfigSaveResult = Result<void, ConfigSaveError>;

/**
 * Configuration store interface
 *
 * Abstracts the storage mechanism for Milhouse configuration.
 * Implementations can use different backends (YAML files, JSON, etc.)
 */
export interface ConfigStore {
	/**
	 * Load configuration from storage
	 *
	 * @returns Result containing the configuration or an error
	 */
	load(): ConfigLoadResult;

	/**
	 * Save configuration to storage
	 *
	 * @param config - Configuration to save
	 * @returns Result indicating success or error
	 */
	save(config: MilhouseConfig): ConfigSaveResult;

	/**
	 * Check if configuration exists in storage
	 *
	 * @returns Whether configuration exists
	 */
	exists(): boolean;

	/**
	 * Get the path to the configuration file
	 *
	 * @returns Path to the configuration file
	 */
	getPath(): string;

	/**
	 * Get the path to the configuration directory
	 *
	 * @returns Path to the configuration directory
	 */
	getConfigDir(): string;
}

/**
 * Options for creating a config store
 */
export interface ConfigStoreOptions {
	/** Working directory (defaults to cwd) */
	workDir?: string;
	/** Custom config directory name (defaults to .milhouse) */
	configDirName?: string;
	/** Custom config file name (defaults to config.yaml) */
	configFileName?: string;
	/** Enable file locking for concurrent access safety */
	enableLocking?: boolean;
}

/**
 * Configuration service interface
 *
 * High-level interface for configuration operations.
 * Provides caching, validation, and business logic.
 */
export interface IConfigService {
	/**
	 * Get configuration, using cache if available
	 *
	 * @returns Configuration or null if not found
	 */
	getConfig(): MilhouseConfig | null;

	/**
	 * Get configuration or return default values
	 *
	 * @returns Configuration (defaults if not found)
	 */
	getConfigOrDefault(): MilhouseConfig;

	/**
	 * Check if configuration is initialized
	 *
	 * @returns Whether config exists
	 */
	isInitialized(): boolean;

	/**
	 * Initialize configuration if not already done
	 *
	 * @param force - Overwrite existing config
	 * @returns Result with detected project info
	 */
	ensureInitialized(
		force?: boolean,
	): Result<{ detected: DetectedProject; configPath: string }, ConfigSaveError>;

	/**
	 * Add a rule to the configuration
	 *
	 * @param rule - Rule text to add
	 * @returns Result indicating success or error
	 */
	addRule(
		rule: string,
	): Result<void, ConfigLoadError | ConfigSaveError | { type: "invalid_rule"; message: string }>;

	/**
	 * Update configuration with partial values
	 *
	 * @param partial - Partial configuration to merge
	 * @returns Result indicating success or error
	 */
	updateConfig(partial: Partial<MilhouseConfig>): Result<void, ConfigLoadError | ConfigSaveError>;

	/**
	 * Get the path to the configuration file
	 */
	getConfigPath(): string;

	/**
	 * Get the working directory
	 */
	getWorkDir(): string;

	/**
	 * Clear the configuration cache
	 */
	clearCache(): void;
}

/**
 * Project detector interface
 *
 * Detects project settings from the codebase.
 */
export interface IProjectDetector {
	/**
	 * Detect project settings from the codebase
	 *
	 * @param workDir - Working directory to analyze
	 * @returns Detected project information
	 */
	detectProject(workDir?: string): DetectedProject;
}

/**
 * Directory creation result
 */
export interface DirectoryResult {
	/** Directories that were created */
	created: string[];
	/** Directories that already existed */
	existing: string[];
}

/**
 * Directory service interface
 *
 * Manages the Milhouse directory structure.
 */
export interface IDirectoryService {
	/**
	 * Create the complete directory structure
	 *
	 * @param workDir - Working directory
	 * @returns Result with created/existing directories
	 */
	createDirectoryStructure(workDir?: string): DirectoryResult;

	/**
	 * Ensure a single directory exists
	 *
	 * @param path - Directory path
	 * @returns Whether the directory was created (false if existed)
	 */
	ensureDirectory(path: string): boolean;

	/**
	 * Check if the complete directory structure exists
	 *
	 * @param workDir - Working directory
	 * @returns Whether all directories exist
	 */
	isDirectoryStructureComplete(workDir?: string): boolean;

	/**
	 * Get missing directories from the expected structure
	 *
	 * @param workDir - Working directory
	 * @returns Array of missing directory paths
	 */
	getMissingDirectories(workDir?: string): string[];

	/**
	 * Get a specific directory path
	 *
	 * @param type - Directory type
	 * @param workDir - Working directory
	 * @returns Full path to the directory
	 */
	getDirectoryPath(type: string, workDir?: string): string;
}

/**
 * Format a config load error for display
 *
 * @param error - The error to format
 * @returns Human-readable error message
 */
export function formatLoadError(error: ConfigLoadError): string {
	switch (error.type) {
		case "not_found":
			return `Configuration not found at: ${error.path}`;
		case "parse_error":
			return `Failed to parse configuration at ${error.path}: ${error.message}`;
		case "validation_error":
			return `Invalid configuration at ${error.path}: ${error.message}`;
		case "permission_denied":
			return `Permission denied reading: ${error.path}`;
		case "migration_failed":
			return `Failed to migrate configuration from version ${error.fromVersion}: ${error.message}`;
		case "unknown":
			return `Unknown error: ${error.message}`;
	}
}

/**
 * Format a config save error for display
 *
 * @param error - The error to format
 * @returns Human-readable error message
 */
export function formatSaveError(error: ConfigSaveError): string {
	switch (error.type) {
		case "permission_denied":
			return `Permission denied writing: ${error.path}`;
		case "directory_not_found":
			return `Directory not found: ${error.path}`;
		case "serialization_error":
			return `Failed to serialize configuration: ${error.message}`;
		case "atomic_write_failed":
			return `Atomic write failed at ${error.path}: ${error.message}`;
		case "lock_failed":
			return `Failed to acquire lock for ${error.path}: ${error.message}`;
		case "unknown":
			return `Unknown error: ${error.message}`;
	}
}
