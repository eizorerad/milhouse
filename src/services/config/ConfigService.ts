/**
 * @fileoverview Configuration Service
 *
 * Business logic layer for configuration management.
 * Provides high-level operations with caching and error handling.
 *
 * @module services/config/ConfigService
 * @since 5.0.0
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentDefaults } from "../../domain/config/defaults";
import { MILHOUSE_DIR, PROGRESS_FILE } from "../../domain/config/directories";
import { CONFIG_VERSION, CurrentConfigSchema } from "../../domain/config/schema";
import type { DetectedProject, MilhouseConfig } from "../../domain/config/types";
import { ProjectDetector } from "./ProjectDetector";
import { createYamlFsConfigStore } from "./YamlFsConfigStore";
import type {
	ConfigLoadError,
	ConfigSaveError,
	ConfigStore,
	IConfigService,
	Result,
} from "./types";

/**
 * Configuration service options
 */
export interface ConfigServiceOptions {
	/** Working directory (defaults to cwd) */
	workDir?: string;
	/** Custom config store (for testing) */
	store?: ConfigStore;
	/** Disable caching */
	noCache?: boolean;
	/** Custom project detector (for testing) */
	detector?: ProjectDetector;
}

/**
 * In-memory cache for configuration
 * Avoids repeated disk reads during a single CLI process
 */
interface ConfigCache {
	config: MilhouseConfig | null;
	workDir: string;
	timestamp: number;
}

/**
 * Global config cache
 */
let globalConfigCache: ConfigCache | null = null;

/**
 * Clear the global configuration cache
 * Useful for testing or when config changes externally
 */
export function clearGlobalConfigCache(): void {
	globalConfigCache = null;
}

/**
 * Configuration service class
 *
 * Provides high-level configuration operations with:
 * - In-memory caching
 * - Automatic store creation
 * - Business logic for common operations
 * - Version migration support
 */
export class ConfigService implements IConfigService {
	private readonly store: ConfigStore;
	private readonly workDir: string;
	private readonly noCache: boolean;
	private readonly detector: ProjectDetector;
	private localCache: MilhouseConfig | null = null;

	constructor(options: ConfigServiceOptions = {}) {
		this.workDir = options.workDir ?? process.cwd();
		this.noCache = options.noCache ?? false;
		this.store = options.store ?? createYamlFsConfigStore({ workDir: this.workDir });
		this.detector = options.detector ?? new ProjectDetector();
	}

	/**
	 * Get configuration, using cache if available
	 *
	 * @returns Configuration or null if not found
	 */
	getConfig(): MilhouseConfig | null {
		// Check local cache first
		if (!this.noCache && this.localCache) {
			return this.localCache;
		}

		// Check global cache
		if (!this.noCache && globalConfigCache?.workDir === this.workDir) {
			this.localCache = globalConfigCache.config;
			return this.localCache;
		}

		// Load from store
		const result = this.store.load();
		if (!result.success) {
			this.updateCache(null);
			return null;
		}

		// Cache and return
		this.updateCache(result.value);
		return result.value;
	}

	/**
	 * Get configuration or return default values
	 *
	 * @returns Configuration (defaults if not found)
	 */
	getConfigOrDefault(): MilhouseConfig {
		const config = this.getConfig();
		if (config) return config;

		// Return default config
		return getCurrentDefaults();
	}

	/**
	 * Check if configuration is initialized
	 *
	 * @returns Whether config exists
	 */
	isInitialized(): boolean {
		return this.store.exists();
	}

	/**
	 * Initialize configuration if not already done
	 *
	 * @param force - Overwrite existing config
	 * @returns Result with detected project info
	 */
	ensureInitialized(
		force = false,
	): Result<{ detected: DetectedProject; configPath: string }, ConfigSaveError> {
		// Check if already initialized
		if (this.store.exists() && !force) {
			const detected = this.detector.detectProject(this.workDir);
			return {
				success: true,
				value: { detected, configPath: this.store.getPath() },
			};
		}

		// Detect project
		const detected = this.detector.detectProject(this.workDir);

		// Create initial config with detected values
		const config = CurrentConfigSchema.parse({
			version: CONFIG_VERSION,
			project: {
				name: detected.name,
				language: detected.language || "",
				framework: detected.framework || "",
				description: "",
			},
			commands: {
				test: detected.testCmd || "",
				lint: detected.lintCmd || "",
				build: detected.buildCmd || "",
				compile: "",
			},
		});

		// Save config
		const saveResult = this.store.save(config);
		if (!saveResult.success) {
			return saveResult;
		}

		// Create progress file
		const progressPath = join(this.workDir, MILHOUSE_DIR, PROGRESS_FILE);
		try {
			writeFileSync(progressPath, "# Milhouse Progress Log\n\n", "utf-8");
		} catch {
			// Ignore progress file creation errors
		}

		// Clear cache
		this.clearCache();

		return {
			success: true,
			value: { detected, configPath: this.store.getPath() },
		};
	}

	/**
	 * Add a rule to the configuration
	 *
	 * @param rule - Rule text to add
	 * @returns Result indicating success or error
	 */
	addRule(
		rule: string,
	): Result<void, ConfigLoadError | ConfigSaveError | { type: "invalid_rule"; message: string }> {
		// Validate rule
		if (!rule || rule.trim().length === 0) {
			return {
				success: false,
				error: { type: "invalid_rule", message: "Rule cannot be empty" },
			};
		}

		// Load current config
		const loadResult = this.store.load();
		if (!loadResult.success) {
			return loadResult;
		}

		// Add rule (immutably)
		const config = loadResult.value;
		const updatedConfig: MilhouseConfig = {
			...config,
			rules: [...(config.rules ?? []), rule.trim()],
		};

		// Save updated config
		const saveResult = this.store.save(updatedConfig);
		if (!saveResult.success) {
			return saveResult;
		}

		// Clear cache
		this.clearCache();

		return { success: true, value: undefined };
	}

	/**
	 * Update configuration with partial values
	 *
	 * @param partial - Partial configuration to merge
	 * @returns Result indicating success or error
	 */
	updateConfig(partial: Partial<MilhouseConfig>): Result<void, ConfigLoadError | ConfigSaveError> {
		// Load current config
		const loadResult = this.store.load();
		if (!loadResult.success) {
			return loadResult;
		}

		// Deep merge configs
		const config = this.deepMerge(loadResult.value, partial);

		// Save updated config
		const saveResult = this.store.save(config);
		if (!saveResult.success) {
			return saveResult;
		}

		// Clear cache
		this.clearCache();

		return { success: true, value: undefined };
	}

	/**
	 * Get the path to the configuration file
	 */
	getConfigPath(): string {
		return this.store.getPath();
	}

	/**
	 * Get the working directory
	 */
	getWorkDir(): string {
		return this.workDir;
	}

	/**
	 * Clear the configuration cache
	 */
	clearCache(): void {
		this.localCache = null;
		clearGlobalConfigCache();
	}

	/**
	 * Log a task to the progress file
	 *
	 * @param task - Task description
	 * @param status - Task status ("completed" or "failed")
	 */
	logTaskProgress(task: string, status: "completed" | "failed"): void {
		const progressPath = join(this.workDir, MILHOUSE_DIR, PROGRESS_FILE);

		if (!existsSync(progressPath)) {
			return;
		}

		const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
		const icon = status === "completed" ? "✓" : "✗";
		const line = `- [${icon}] ${timestamp} - ${task}\n`;

		appendFileSync(progressPath, line, "utf-8");
	}

	/**
	 * Update the cache with a new config
	 */
	private updateCache(config: MilhouseConfig | null): void {
		if (this.noCache) return;

		this.localCache = config;
		globalConfigCache = {
			config,
			workDir: this.workDir,
			timestamp: Date.now(),
		};
	}

	/**
	 * Deep merge two objects
	 */
	private deepMerge(target: MilhouseConfig, source: Partial<MilhouseConfig>): MilhouseConfig {
		const result = { ...target };

		for (const key of Object.keys(source) as (keyof MilhouseConfig)[]) {
			const sourceValue = source[key];
			const targetValue = target[key];

			if (sourceValue === undefined) {
				continue;
			}

			if (
				typeof sourceValue === "object" &&
				sourceValue !== null &&
				!Array.isArray(sourceValue) &&
				typeof targetValue === "object" &&
				targetValue !== null &&
				!Array.isArray(targetValue)
			) {
				// Deep merge objects
				(result as Record<string, unknown>)[key] = {
					...targetValue,
					...sourceValue,
				};
			} else {
				// Direct assignment for primitives and arrays
				(result as Record<string, unknown>)[key] = sourceValue;
			}
		}

		return result;
	}
}

/**
 * Create a new configuration service
 *
 * @param options - Service options
 * @returns New config service instance
 */
export function createConfigService(options: ConfigServiceOptions = {}): ConfigService {
	return new ConfigService(options);
}

/**
 * Default service instances per working directory
 */
const defaultServices = new Map<string, ConfigService>();

/**
 * Get a singleton config service for the specified working directory
 *
 * @param workDir - Working directory (defaults to cwd)
 * @returns Config service instance
 */
export function getConfigService(workDir?: string): ConfigService {
	const targetWorkDir = workDir ?? process.cwd();

	let service = defaultServices.get(targetWorkDir);
	if (!service) {
		service = createConfigService({ workDir: targetWorkDir });
		defaultServices.set(targetWorkDir, service);
	}

	return service;
}

/**
 * Reset all default services (for testing)
 */
export function resetDefaultServices(): void {
	defaultServices.clear();
	clearGlobalConfigCache();
}

/**
 * Log a task to the progress file
 *
 * Convenience function that uses the singleton config service.
 *
 * @param task - Task description
 * @param status - Task status ("completed" or "failed")
 * @param workDir - Working directory (defaults to cwd)
 */
export function logTaskProgress(
	task: string,
	status: "completed" | "failed",
	workDir = process.cwd(),
): void {
	const service = getConfigService(workDir);
	service.logTaskProgress(task, status);
}
