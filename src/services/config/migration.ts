/**
 * @fileoverview Config Migration
 *
 * Version migration chain for Milhouse configuration.
 * Handles upgrading old config versions to the current version.
 *
 * @module services/config/migration
 * @since 5.0.0
 */

import { mergeWithDefaults } from "../../domain/config/defaults.ts";
import { CONFIG_VERSION } from "../../domain/config/schema.ts";
import type { MilhouseConfig } from "../../domain/config/types.ts";

/**
 * Migration function type
 *
 * Takes a config object and returns the migrated version.
 */
export type MigrationFn = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration registry
 *
 * Maps source version to migration function.
 * Each migration upgrades to the next version in the chain.
 */
const MIGRATIONS: Map<string, { targetVersion: string; migrate: MigrationFn }> = new Map([
	// Migration from unversioned (legacy) to v1.0
	[
		"unversioned",
		{
			targetVersion: "1.0",
			migrate: migrateUnversionedToV1,
		},
	],
	// Future migrations would be added here:
	// ["1.0", { targetVersion: "1.1", migrate: migrateV1ToV1_1 }],
]);

/**
 * Check if a config needs migration
 *
 * @param config - Raw configuration data
 * @returns Whether migration is needed
 */
export function needsMigration(config: unknown): boolean {
	if (typeof config !== "object" || config === null) {
		return false;
	}

	const configObj = config as Record<string, unknown>;
	const version = configObj.version;

	// No version field means unversioned (legacy) config
	if (version === undefined) {
		return true;
	}

	// Check if version matches current
	if (typeof version === "string" && version !== CONFIG_VERSION) {
		return true;
	}

	return false;
}

/**
 * Get the version of a config object
 *
 * @param config - Raw configuration data
 * @returns Version string or "unversioned" if not present
 */
export function getVersion(config: unknown): string {
	if (typeof config !== "object" || config === null) {
		return "unversioned";
	}

	const configObj = config as Record<string, unknown>;
	const version = configObj.version;

	if (typeof version === "string") {
		return version;
	}

	return "unversioned";
}

/**
 * Migrate a config to the current version
 *
 * Applies all necessary migrations in sequence to bring
 * the config up to the current version.
 *
 * @param config - Raw configuration data
 * @returns Migrated configuration
 * @throws Error if migration fails
 */
export function migrateConfig(config: unknown): MilhouseConfig {
	if (typeof config !== "object" || config === null) {
		throw new Error("Invalid config: expected object");
	}

	let currentConfig = config as Record<string, unknown>;
	let currentVersion = getVersion(currentConfig);

	// Apply migrations in sequence until we reach the current version
	while (currentVersion !== CONFIG_VERSION) {
		const migration = MIGRATIONS.get(currentVersion);

		if (!migration) {
			// No migration path found - try to parse as-is with defaults
			break;
		}

		currentConfig = migration.migrate(currentConfig);
		currentVersion = migration.targetVersion;
	}

	// Ensure version is set
	currentConfig.version = CONFIG_VERSION;

	// Merge with defaults to fill in any missing fields
	return mergeWithDefaults(currentConfig as Partial<MilhouseConfig>);
}

/**
 * Migrate unversioned (legacy) config to v1.0
 *
 * Handles configs from before versioning was introduced.
 */
function migrateUnversionedToV1(config: Record<string, unknown>): Record<string, unknown> {
	const migrated: Record<string, unknown> = { ...config };

	// Add version field
	migrated.version = "1.0";

	// Migrate old field names if present
	// (Add specific field migrations here as needed)

	// Ensure project section exists
	if (!migrated.project) {
		migrated.project = {
			name: "",
			language: "",
			framework: "",
			description: "",
		};
	}

	// Ensure commands section exists
	if (!migrated.commands) {
		migrated.commands = {
			test: "",
			lint: "",
			build: "",
			compile: "",
		};
	}

	// Ensure rules array exists
	if (!Array.isArray(migrated.rules)) {
		migrated.rules = [];
	}

	// Ensure boundaries section exists
	if (!migrated.boundaries) {
		migrated.boundaries = {
			never_touch: [],
		};
	}

	// Ensure allowed_commands section exists
	if (!migrated.allowed_commands) {
		migrated.allowed_commands = {
			probes: [],
			execution: [],
		};
	}

	// Ensure probes section exists
	if (!migrated.probes) {
		migrated.probes = {};
	}

	// Ensure execution section exists with defaults
	if (!migrated.execution) {
		migrated.execution = {
			mode: "branch",
			parallel: 4,
			auto_commit: true,
			create_pr: false,
			draft_pr: true,
		};
	}

	// Ensure gates section exists with defaults
	if (!migrated.gates) {
		migrated.gates = {
			evidence_required: true,
			diff_hygiene: true,
			placeholder_check: true,
			env_consistency: true,
			dod_verification: true,
		};
	}

	return migrated;
}

/**
 * Get the migration path from one version to another
 *
 * @param fromVersion - Source version
 * @param toVersion - Target version (defaults to current)
 * @returns Array of version strings in the migration path
 */
export function getMigrationPath(
	fromVersion: string,
	toVersion: string = CONFIG_VERSION,
): string[] {
	const path: string[] = [fromVersion];
	let currentVersion = fromVersion;

	while (currentVersion !== toVersion) {
		const migration = MIGRATIONS.get(currentVersion);
		if (!migration) {
			break;
		}
		path.push(migration.targetVersion);
		currentVersion = migration.targetVersion;
	}

	return path;
}

/**
 * Check if a migration path exists
 *
 * @param fromVersion - Source version
 * @param toVersion - Target version (defaults to current)
 * @returns Whether a migration path exists
 */
export function hasMigrationPath(fromVersion: string, toVersion: string = CONFIG_VERSION): boolean {
	if (fromVersion === toVersion) {
		return true;
	}

	let currentVersion = fromVersion;
	const visited = new Set<string>();

	while (currentVersion !== toVersion) {
		if (visited.has(currentVersion)) {
			// Cycle detected
			return false;
		}
		visited.add(currentVersion);

		const migration = MIGRATIONS.get(currentVersion);
		if (!migration) {
			return false;
		}
		currentVersion = migration.targetVersion;
	}

	return true;
}

/**
 * Register a custom migration
 *
 * Useful for testing or extending the migration chain.
 *
 * @param fromVersion - Source version
 * @param targetVersion - Target version
 * @param migrate - Migration function
 */
export function registerMigration(
	fromVersion: string,
	targetVersion: string,
	migrate: MigrationFn,
): void {
	MIGRATIONS.set(fromVersion, { targetVersion, migrate });
}

/**
 * Clear all custom migrations
 *
 * Resets to the default migration chain.
 * Useful for testing.
 */
export function clearCustomMigrations(): void {
	// Keep only the built-in migrations
	const builtInMigrations = new Map([
		[
			"unversioned",
			{
				targetVersion: "1.0",
				migrate: migrateUnversionedToV1,
			},
		],
	]);

	MIGRATIONS.clear();
	for (const [key, value] of builtInMigrations) {
		MIGRATIONS.set(key, value);
	}
}
