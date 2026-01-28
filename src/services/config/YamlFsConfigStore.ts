/**
 * @fileoverview YAML Filesystem Config Store
 *
 * Implementation of ConfigStore that persists configuration
 * to a YAML file on the filesystem with atomic write support
 * and optional file locking for concurrent access safety.
 *
 * @module services/config/YamlFsConfigStore
 * @since 5.0.0
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CONFIG_FILE, MILHOUSE_DIR } from "../../domain/config/directories";
import { CurrentConfigSchema } from "../../domain/config/schema";
import type { MilhouseConfig } from "../../domain/config/types";
import { migrateConfig, needsMigration } from "./migration";
import type {
	ConfigLoadResult,
	ConfigSaveResult,
	ConfigStore,
	ConfigStoreOptions,
} from "./types.ts";

/**
 * Lock file suffix
 */
const LOCK_SUFFIX = ".lock";

/**
 * Lock timeout in milliseconds
 */
const LOCK_TIMEOUT_MS = 5000;

/**
 * Lock retry interval in milliseconds
 */
const LOCK_RETRY_MS = 50;

/**
 * YAML filesystem-based configuration store
 *
 * Stores configuration in a YAML file with:
 * - Atomic writes (write to temp, then rename)
 * - Optional file locking for concurrent access
 * - Zod validation on load
 * - Automatic directory creation on save
 * - Automatic config migration on load
 */
export class YamlFsConfigStore implements ConfigStore {
	private readonly configPath: string;
	private readonly configDir: string;
	private readonly enableLocking: boolean;

	constructor(options: ConfigStoreOptions = {}) {
		const workDir = options.workDir ?? process.cwd();
		const configDirName = options.configDirName ?? MILHOUSE_DIR;
		const configFileName = options.configFileName ?? CONFIG_FILE;

		this.configDir = join(workDir, configDirName);
		this.configPath = join(this.configDir, configFileName);
		this.enableLocking = options.enableLocking ?? false;
	}

	/**
	 * Load configuration from YAML file
	 *
	 * Automatically migrates old config versions to the current version.
	 */
	load(): ConfigLoadResult {
		// Check if file exists
		if (!existsSync(this.configPath)) {
			return {
				success: false,
				error: { type: "not_found", path: this.configPath },
			};
		}

		// Read file content
		let content: string;
		try {
			content = readFileSync(this.configPath, "utf-8");
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "EACCES") {
				return {
					success: false,
					error: { type: "permission_denied", path: this.configPath },
				};
			}
			return {
				success: false,
				error: { type: "unknown", message: error.message },
			};
		}

		// Parse YAML
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (err) {
			const error = err as Error;
			return {
				success: false,
				error: {
					type: "parse_error",
					path: this.configPath,
					message: error.message,
				},
			};
		}

		// Check if migration is needed
		if (needsMigration(parsed)) {
			try {
				parsed = migrateConfig(parsed);
			} catch (err) {
				const error = err as Error;
				const fromVersion =
					typeof parsed === "object" && parsed !== null && "version" in parsed
						? String((parsed as Record<string, unknown>).version)
						: "unknown";
				return {
					success: false,
					error: {
						type: "migration_failed",
						fromVersion,
						message: error.message,
					},
				};
			}
		}

		// Validate with Zod schema
		const validation = CurrentConfigSchema.safeParse(parsed);
		if (!validation.success) {
			return {
				success: false,
				error: {
					type: "validation_error",
					path: this.configPath,
					message: validation.error.message,
				},
			};
		}

		return {
			success: true,
			value: validation.data,
		};
	}

	/**
	 * Save configuration to YAML file with atomic write
	 *
	 * Uses write-to-temp-then-rename pattern for atomicity.
	 * Optionally acquires a file lock for concurrent access safety.
	 */
	save(config: MilhouseConfig): ConfigSaveResult {
		// Acquire lock if enabled
		if (this.enableLocking) {
			const lockResult = this.acquireLock();
			if (!lockResult.success) {
				return lockResult;
			}
		}

		try {
			return this.saveInternal(config);
		} finally {
			// Release lock if enabled
			if (this.enableLocking) {
				this.releaseLock();
			}
		}
	}

	/**
	 * Internal save implementation
	 */
	private saveInternal(config: MilhouseConfig): ConfigSaveResult {
		// Ensure directory exists
		if (!existsSync(this.configDir)) {
			try {
				mkdirSync(this.configDir, { recursive: true });
			} catch (err) {
				const error = err as NodeJS.ErrnoException;
				if (error.code === "EACCES") {
					return {
						success: false,
						error: { type: "permission_denied", path: this.configDir },
					};
				}
				return {
					success: false,
					error: { type: "directory_not_found", path: this.configDir },
				};
			}
		}

		// Serialize to YAML
		let yamlContent: string;
		try {
			yamlContent = YAML.stringify(config);
		} catch (err) {
			const error = err as Error;
			return {
				success: false,
				error: { type: "serialization_error", message: error.message },
			};
		}

		// Atomic write: write to temp file, then rename
		const tempPath = `${this.configPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
		try {
			writeFileSync(tempPath, yamlContent, "utf-8");
			renameSync(tempPath, this.configPath);
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			// Clean up temp file if it exists
			this.cleanupTempFile(tempPath);

			if (error.code === "EACCES") {
				return {
					success: false,
					error: { type: "permission_denied", path: this.configPath },
				};
			}
			return {
				success: false,
				error: {
					type: "atomic_write_failed",
					path: this.configPath,
					message: error.message,
				},
			};
		}

		return { success: true, value: undefined };
	}

	/**
	 * Check if configuration file exists
	 */
	exists(): boolean {
		return existsSync(this.configPath);
	}

	/**
	 * Get the path to the configuration file
	 */
	getPath(): string {
		return this.configPath;
	}

	/**
	 * Get the path to the configuration directory
	 */
	getConfigDir(): string {
		return this.configDir;
	}

	/**
	 * Acquire a file lock
	 */
	private acquireLock(): ConfigSaveResult {
		const lockPath = this.configPath + LOCK_SUFFIX;
		const startTime = Date.now();

		while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
			try {
				// Try to create lock file exclusively
				writeFileSync(lockPath, String(process.pid), { flag: "wx" });
				return { success: true, value: undefined };
			} catch (err) {
				const error = err as NodeJS.ErrnoException;
				if (error.code === "EEXIST") {
					// Lock exists, check if it's stale
					if (this.isLockStale(lockPath)) {
						this.releaseLock();
						continue;
					}
					// Wait and retry
					this.sleep(LOCK_RETRY_MS);
					continue;
				}
				return {
					success: false,
					error: { type: "lock_failed", path: lockPath, message: error.message },
				};
			}
		}

		return {
			success: false,
			error: { type: "lock_failed", path: lockPath, message: "Lock timeout exceeded" },
		};
	}

	/**
	 * Release the file lock
	 */
	private releaseLock(): void {
		const lockPath = this.configPath + LOCK_SUFFIX;
		try {
			if (existsSync(lockPath)) {
				unlinkSync(lockPath);
			}
		} catch {
			// Ignore errors when releasing lock
		}
	}

	/**
	 * Check if a lock file is stale (older than timeout)
	 */
	private isLockStale(lockPath: string): boolean {
		try {
			const { statSync } = require("node:fs");
			const stats = statSync(lockPath);
			const age = Date.now() - stats.mtimeMs;
			return age > LOCK_TIMEOUT_MS * 2;
		} catch {
			return true;
		}
	}

	/**
	 * Clean up a temporary file
	 */
	private cleanupTempFile(tempPath: string): void {
		try {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
		} catch {
			// Ignore cleanup errors
		}
	}

	/**
	 * Synchronous sleep
	 */
	private sleep(ms: number): void {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// Busy wait
		}
	}
}

/**
 * Create a new YAML filesystem config store
 *
 * @param options - Store options
 * @returns New config store instance
 */
export function createYamlFsConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
	return new YamlFsConfigStore(options);
}
