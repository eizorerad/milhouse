/**
 * Probe System - Central export module
 *
 * Provides:
 * - Type definitions and schemas for probe configurations
 * - Base probe class with common functionality
 * - Specialized probe implementations for each inspector
 * - Probe registry and factory for creating probes by type
 * - Parallel execution utilities
 *
 * Inspector Probes:
 * - ETI (compose): Environment Topology Inspector - Docker Compose analysis
 * - DLA (postgres): Database Layer Auditor - PostgreSQL schema/migrations
 * - CA (redis): Cache Auditor - Redis TTL/keyspace inspection
 * - SI (storage): Storage Inspector - S3/MinIO/FS analysis
 * - DVA (deps): Dependency Version Auditor - Package version auditing
 * - RR (repro): Repro Runner - Log and reproduction execution
 */

// ============================================================================
// Type definitions and schemas
// ============================================================================
export {
	// Probe type schema and type
	ProbeTypeSchema,
	type ProbeType,
	// Type descriptions and mappings
	PROBE_TYPE_DESCRIPTIONS,
	PROBE_TO_AGENT_ROLE,
	AGENT_ROLE_TO_PROBE,
	// Status types
	ProbeStatusSchema,
	type ProbeStatus,
	// Severity types
	ProbeSeveritySchema,
	type ProbeSeverity,
	// Finding types
	ProbeFindingSchema,
	type ProbeFinding,
	createProbeFinding,
	// Result types
	ProbeResultSchema,
	type ProbeResult,
	createProbeResult,
	// Input types
	ProbeInputSchema,
	type ProbeInput,
	// Config types
	ProbeConfigSchema,
	type ProbeConfig,
	DEFAULT_PROBE_CONFIGS,
	getProbeConfig,
	// Metrics types
	ProbeMetricsSchema,
	type ProbeMetrics,
	createEmptyProbeMetrics,
	createMetricsFromProbeResult,
	// Probe-specific output types
	ComposeServiceSchema,
	type ComposeService,
	ComposeTopologySchema,
	type ComposeTopology,
	ComposeProbeOutputSchema,
	type ComposeProbeOutput,
	PostgresColumnSchema,
	type PostgresColumn,
	PostgresTableSchema,
	type PostgresTable,
	PostgresMigrationSchema,
	type PostgresMigration,
	PostgresProbeOutputSchema,
	type PostgresProbeOutput,
	RedisKeyPatternSchema,
	type RedisKeyPattern,
	RedisProbeOutputSchema,
	type RedisProbeOutput,
	StorageBucketSchema,
	type StorageBucket,
	StorageProbeOutputSchema,
	type StorageProbeOutput,
	DependencySchema,
	type Dependency,
	DepsProbeOutputSchema,
	type DepsProbeOutput,
	ReproStepSchema,
	type ReproStep,
	ReproProbeOutputSchema,
	type ReproProbeOutput,
	type ProbeOutput,
	// Helper functions
	isValidProbeType,
	isReadOnlyProbe,
	getAllProbeTypes,
	getInspectorProbeTypes,
	getProbeTypeFromRole,
	getAgentRoleFromProbeType,
	convertProbeResultToEvidence,
	countFindingsBySeverity,
	hasBlockingFindings,
	getFindingsBySeverity,
	getCriticalFindings,
	getHighFindings,
	mergeProbeResults,
} from "./types.ts";

// ============================================================================
// Base probe class and utilities
// ============================================================================
export {
	// Error classes
	ProbeExecutionError,
	ProbeTimeoutError,
	ProbeSafetyError,
	// Execution options
	type ProbeExecutionOptions,
	// Base probe interface and class
	type IProbe,
	BaseProbe,
	// Lifecycle hooks
	type ProbeHooks,
	// Command execution
	type CommandResult,
	executeCommandWithTimeout,
	// Utility functions
	generateProbeId,
	DEFAULT_UNSAFE_PATTERNS,
	containsUnsafePattern,
	findUnsafePattern,
	createProbeInput,
	isProbeSupported,
	// Parallel execution
	mergeProbeMetrics,
	executeProbesInParallel,
	allProbesSucceeded,
	getFailedProbes,
	getSuccessfulProbes,
} from "./base.ts";

// ============================================================================
// Compose Probe (ETI - Environment Topology Inspector)
// ============================================================================
export {
	ComposeProbe,
	createComposeProbe,
	parseComposeFile,
	findComposeFiles,
	analyzeComposeTopology,
	hasComposeFiles,
	getServiceNames,
	getServiceDependencies,
	hasCircularDependencies as hasComposeCircularDependencies,
	getUsedNetworks,
	getUsedVolumes,
	formatTopologyAsMarkdown,
} from "./compose.ts";

// ============================================================================
// PostgreSQL Probe (DLA - Database Layer Auditor)
// ============================================================================
export {
	PostgresProbe,
	createPostgresProbe,
	hasPostgresConfig,
	detectOrmFramework,
	parsePrismaSchemaFile,
	findMigrationFiles,
	extractPostgresConnectionInfo,
	analyzeDatabaseSchema,
	formatPostgresOutputAsMarkdown,
	getMigrationStats,
	checkDatabaseAntiPatterns,
} from "./postgres.ts";

// ============================================================================
// Redis Probe (CA - Cache Auditor)
// ============================================================================
export {
	RedisProbe,
	createRedisProbe,
	hasRedisConfig,
	extractRedisConnectionInfo,
	formatRedisOutputAsMarkdown,
	getRedisMemoryConfig,
	categorizeKeyPatterns,
	parseRedisMemoryString,
	checkRedisConfiguration,
} from "./redis.ts";

// ============================================================================
// Storage Probe (SI - Storage Inspector)
// ============================================================================
export {
	StorageProbe,
	createStorageProbe,
	hasStorageConfig,
	detectStorageProvider,
	extractStorageBuckets,
	formatStorageOutputAsMarkdown,
	checkStorageConfiguration,
} from "./storage.ts";

// ============================================================================
// Dependencies Probe (DVA - Dependency Version Auditor)
// ============================================================================
export {
	DepsProbe,
	createDepsProbe,
	hasDependencyConfig,
	detectPackageManager,
	extractDependencies,
	formatDepsOutputAsMarkdown,
	checkDependencyVulnerabilities,
	compareSemanticVersions,
} from "./deps.ts";

// ============================================================================
// Repro Probe (RR - Repro Runner)
// ============================================================================
export {
	ReproProbe,
	createReproProbe,
	hasReproConfig,
	findLogFilesInDirectory,
	analyzeLogsForErrors,
	parseReproSteps,
	detectProjectTestCommand,
	formatReproOutputAsMarkdown,
	isCommandSafe,
} from "./repro.ts";

// ============================================================================
// Probe Registry and Factory
// ============================================================================

import type { IProbe } from "./base.ts";
import { ComposeProbe, hasComposeFiles } from "./compose.ts";
import { DepsProbe } from "./deps.ts";
import { PostgresProbe, hasPostgresConfig } from "./postgres.ts";
import { RedisProbe, hasRedisConfig } from "./redis.ts";
import { ReproProbe, hasReproConfig } from "./repro.ts";
import { StorageProbe, hasStorageConfig } from "./storage.ts";
import type { ProbeConfig, ProbeInput, ProbeResult, ProbeType } from "./types.ts";

/**
 * Inspector probe type (excludes validation)
 */
export type InspectorProbeType = "compose" | "postgres" | "redis" | "storage" | "deps" | "repro";

/**
 * Check if a probe type is an inspector probe type
 */
export function isInspectorProbeType(probeType: ProbeType): probeType is InspectorProbeType {
	return ["compose", "postgres", "redis", "storage", "deps", "repro"].includes(probeType);
}

/**
 * Probe class constructors for inspector probes
 */
export const PROBE_CLASSES: Record<
	InspectorProbeType,
	new (
		configOverrides?: Partial<ProbeConfig>,
	) => IProbe<unknown>
> = {
	compose: ComposeProbe,
	postgres: PostgresProbe,
	redis: RedisProbe,
	storage: StorageProbe,
	deps: DepsProbe,
	repro: ReproProbe,
};

/**
 * Create a probe instance by type
 *
 * @param probeType - The probe type to create
 * @param configOverrides - Optional configuration overrides
 * @returns The created probe instance
 * @throws Error if the probe type is not an inspector probe
 */
export function createProbe(
	probeType: InspectorProbeType,
	configOverrides?: Partial<ProbeConfig>,
): IProbe<unknown> {
	const ProbeClass = PROBE_CLASSES[probeType];
	if (!ProbeClass) {
		throw new Error(`Unknown inspector probe type: ${probeType}`);
	}
	return new ProbeClass(configOverrides);
}

/**
 * Create a typed Compose probe
 */
export function createCompose(configOverrides?: Partial<ProbeConfig>): ComposeProbe {
	return new ComposeProbe(configOverrides);
}

/**
 * Create a typed PostgreSQL probe
 */
export function createPostgres(configOverrides?: Partial<ProbeConfig>): PostgresProbe {
	return new PostgresProbe(configOverrides);
}

/**
 * Create a typed Redis probe
 */
export function createRedis(configOverrides?: Partial<ProbeConfig>): RedisProbe {
	return new RedisProbe(configOverrides);
}

/**
 * Create a typed Storage probe
 */
export function createStorage(configOverrides?: Partial<ProbeConfig>): StorageProbe {
	return new StorageProbe(configOverrides);
}

/**
 * Create a typed Dependencies probe
 */
export function createDeps(configOverrides?: Partial<ProbeConfig>): DepsProbe {
	return new DepsProbe(configOverrides);
}

/**
 * Create a typed Repro probe
 */
export function createRepro(configOverrides?: Partial<ProbeConfig>): ReproProbe {
	return new ReproProbe(configOverrides);
}

/**
 * Get probe by type with proper typing
 *
 * Helper function that returns a properly typed probe for each type.
 * Useful when you know the type at compile time.
 */
export function getTypedProbe<T extends InspectorProbeType>(
	probeType: T,
	configOverrides?: Partial<ProbeConfig>,
): T extends "compose"
	? ComposeProbe
	: T extends "postgres"
		? PostgresProbe
		: T extends "redis"
			? RedisProbe
			: T extends "storage"
				? StorageProbe
				: T extends "deps"
					? DepsProbe
					: T extends "repro"
						? ReproProbe
						: never {
	switch (probeType) {
		case "compose":
			return new ComposeProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		case "postgres":
			return new PostgresProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		case "redis":
			return new RedisProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		case "storage":
			return new StorageProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		case "deps":
			return new DepsProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		case "repro":
			return new ReproProbe(configOverrides) as ReturnType<typeof getTypedProbe<T>>;
		default:
			throw new Error(`Unknown inspector probe type: ${probeType}`);
	}
}

/**
 * Registry entry for a probe
 */
export interface ProbeRegistryEntry {
	/** Probe type identifier */
	probeType: InspectorProbeType;
	/** Agent role this probe maps to */
	agentRole: string;
	/** Probe class constructor */
	ProbeClass: new (
		configOverrides?: Partial<ProbeConfig>,
	) => IProbe<unknown>;
	/** Factory function to create the probe */
	create: (configOverrides?: Partial<ProbeConfig>) => IProbe<unknown>;
	/** Human-readable name */
	name: string;
	/** Description of what the probe does */
	description: string;
	/** Whether the probe is read-only */
	readOnly: boolean;
}

/**
 * Probe registry - provides metadata and factories for all inspector probes
 */
export const PROBE_REGISTRY: Record<InspectorProbeType, ProbeRegistryEntry> = {
	compose: {
		probeType: "compose",
		agentRole: "ETI",
		ProbeClass: ComposeProbe,
		create: createCompose,
		name: "Compose Probe",
		description:
			"Docker Compose topology inspector - analyzes compose files, services, networks, volumes",
		readOnly: true,
	},
	postgres: {
		probeType: "postgres",
		agentRole: "DLA",
		ProbeClass: PostgresProbe,
		create: createPostgres,
		name: "PostgreSQL Probe",
		description:
			"PostgreSQL schema/migrations auditor - inspects database structure and migrations",
		readOnly: true,
	},
	redis: {
		probeType: "redis",
		agentRole: "CA",
		ProbeClass: RedisProbe,
		create: createRedis,
		name: "Redis Probe",
		description: "Redis TTL/keyspace inspector - analyzes cache configuration and key patterns",
		readOnly: true,
	},
	storage: {
		probeType: "storage",
		agentRole: "SI",
		ProbeClass: StorageProbe,
		create: createStorage,
		name: "Storage Probe",
		description: "S3/MinIO/FS inspector - examines storage configurations and permissions",
		readOnly: true,
	},
	deps: {
		probeType: "deps",
		agentRole: "DVA",
		ProbeClass: DepsProbe,
		create: createDeps,
		name: "Dependencies Probe",
		description: "Dependency version auditor - compares lockfile versions vs installed",
		readOnly: true,
	},
	repro: {
		probeType: "repro",
		agentRole: "RR",
		ProbeClass: ReproProbe,
		create: createRepro,
		name: "Repro Probe",
		description: "Reproduction runner - executes reproduction steps and captures logs",
		readOnly: false, // Repro may execute commands
	},
};

/**
 * Get all inspector probe types
 */
export function getInspectorProbeTypeList(): InspectorProbeType[] {
	return ["compose", "postgres", "redis", "storage", "deps", "repro"];
}

/**
 * Get probe registry entry by type
 */
export function getProbeRegistryEntry(probeType: InspectorProbeType): ProbeRegistryEntry {
	return PROBE_REGISTRY[probeType];
}

/**
 * Check if a probe type is registered
 */
export function isProbeRegistered(probeType: string): probeType is InspectorProbeType {
	return probeType in PROBE_REGISTRY;
}

/**
 * Create all inspector probes with optional config overrides
 */
export function createAllProbes(
	configOverrides?: Partial<ProbeConfig>,
): Record<InspectorProbeType, IProbe<unknown>> {
	return {
		compose: createCompose(configOverrides),
		postgres: createPostgres(configOverrides),
		redis: createRedis(configOverrides),
		storage: createStorage(configOverrides),
		deps: createDeps(configOverrides),
		repro: createRepro(configOverrides),
	};
}

/**
 * Get read-only probe types
 */
export function getReadOnlyProbeTypes(): InspectorProbeType[] {
	return getInspectorProbeTypeList().filter((type) => PROBE_REGISTRY[type].readOnly);
}

/**
 * Get probe types that may modify state
 */
export function getNonReadOnlyProbeTypes(): InspectorProbeType[] {
	return getInspectorProbeTypeList().filter((type) => !PROBE_REGISTRY[type].readOnly);
}

/**
 * Dispatch configuration - options for the probe dispatcher
 */
export interface ProbeDispatchConfig {
	/** Maximum concurrent probes */
	maxConcurrent: number;
	/** Whether to skip failed probes and continue */
	continueOnFailure: boolean;
	/** Timeout for individual probes (overrides probe default) */
	timeoutMs?: number;
	/** Force read-only mode for all probes */
	forceReadOnly: boolean;
	/** Probe types to run (empty = all) */
	probeTypes?: InspectorProbeType[];
}

/**
 * Default dispatch configuration
 */
export const DEFAULT_DISPATCH_CONFIG: ProbeDispatchConfig = {
	maxConcurrent: 4,
	continueOnFailure: true,
	forceReadOnly: true,
	probeTypes: undefined, // All probes
};

/**
 * Probe dispatch result
 */
export interface ProbeDispatchResult {
	/** All probe results */
	results: ProbeResult[];
	/** Probes that succeeded */
	successful: ProbeResult[];
	/** Probes that failed */
	failed: ProbeResult[];
	/** Total execution time in ms */
	totalDurationMs: number;
	/** Summary statistics */
	summary: {
		total: number;
		succeeded: number;
		failed: number;
		skipped: number;
		totalFindings: number;
		findingsBySeverity: Record<string, number>;
	};
}

/**
 * Probe dispatcher - runs multiple probes with configuration
 *
 * @param workDir - Working directory to probe
 * @param config - Dispatch configuration
 * @returns Dispatch result with all probe results and summary
 */
export async function dispatchProbes(
	workDir: string,
	config: Partial<ProbeDispatchConfig> = {},
): Promise<ProbeDispatchResult> {
	const startTime = Date.now();
	const mergedConfig: ProbeDispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, ...config };
	const probeTypes = mergedConfig.probeTypes ?? getInspectorProbeTypeList();

	// Filter out non-read-only probes if forceReadOnly is true
	const typesToRun = mergedConfig.forceReadOnly
		? probeTypes.filter((type) => PROBE_REGISTRY[type].readOnly)
		: probeTypes;

	// Create probes and inputs
	const probes: Array<{ probe: IProbe<unknown>; type: InspectorProbeType }> = [];
	const inputs: ProbeInput[] = [];

	for (const probeType of typesToRun) {
		const probe = createProbe(probeType);
		probes.push({ probe, type: probeType });
		inputs.push({
			workDir,
			targets: [],
			options: {},
			timeout_ms: mergedConfig.timeoutMs ?? probe.config.timeout_ms,
			verbose: false,
		});
	}

	// Execute probes in parallel batches
	const results: ProbeResult[] = [];
	const skipped = probeTypes.length - typesToRun.length;

	for (let i = 0; i < probes.length; i += mergedConfig.maxConcurrent) {
		const batch = probes.slice(i, i + mergedConfig.maxConcurrent);
		const batchInputs = inputs.slice(i, i + mergedConfig.maxConcurrent);

		const batchPromises = batch.map(async ({ probe }, idx) => {
			try {
				return await probe.execute(batchInputs[idx], {
					forceReadOnly: mergedConfig.forceReadOnly,
				});
			} catch (error) {
				// Return error result if continueOnFailure is true
				if (mergedConfig.continueOnFailure) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						probe_id: `${batch[idx].type}-error-${Date.now()}`,
						probe_type: batch[idx].type,
						success: false,
						error: errorMessage,
						timestamp: new Date().toISOString(),
						read_only: true,
						findings: [],
					} as ProbeResult;
				}
				throw error;
			}
		});

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	// Compute summary
	const successful = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	const findingsBySeverity: Record<string, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	let totalFindings = 0;
	for (const result of results) {
		totalFindings += result.findings.length;
		for (const finding of result.findings) {
			findingsBySeverity[finding.severity] = (findingsBySeverity[finding.severity] || 0) + 1;
		}
	}

	return {
		results,
		successful,
		failed,
		totalDurationMs: Date.now() - startTime,
		summary: {
			total: results.length,
			succeeded: successful.length,
			failed: failed.length,
			skipped,
			totalFindings,
			findingsBySeverity,
		},
	};
}

/**
 * Run a single probe type on a directory
 *
 * @param probeType - The probe type to run
 * @param workDir - Working directory to probe
 * @param options - Optional execution options
 * @returns The probe result
 */
export async function runProbe(
	probeType: InspectorProbeType,
	workDir: string,
	options?: {
		timeoutMs?: number;
		forceReadOnly?: boolean;
		targets?: string[];
	},
): Promise<ProbeResult> {
	const probe = createProbe(probeType);
	const input: ProbeInput = {
		workDir,
		targets: options?.targets ?? [],
		options: {},
		timeout_ms: options?.timeoutMs ?? probe.config.timeout_ms,
		verbose: false,
	};

	return probe.execute(input, {
		forceReadOnly: options?.forceReadOnly,
	});
}

/**
 * Detect which probes are applicable for a directory
 *
 * @param workDir - Working directory to check
 * @returns Array of applicable probe types
 */
export function detectApplicableProbes(workDir: string): InspectorProbeType[] {
	const applicable: InspectorProbeType[] = [];

	// Always include deps probe as most projects have dependencies
	applicable.push("deps");

	// Check for compose files
	if (hasComposeFiles(workDir)) {
		applicable.push("compose");
	}

	// Check for postgres configuration
	if (hasPostgresConfig(workDir)) {
		applicable.push("postgres");
	}

	// Check for redis configuration
	if (hasRedisConfig(workDir)) {
		applicable.push("redis");
	}

	// Check for storage configuration
	if (hasStorageConfig(workDir)) {
		applicable.push("storage");
	}

	// Check for repro configuration
	if (hasReproConfig(workDir)) {
		applicable.push("repro");
	}

	return applicable;
}

/**
 * Format probe results as a summary markdown
 *
 * @param results - Array of probe results
 * @returns Markdown summary
 */
export function formatProbeResultsAsMarkdown(results: ProbeResult[]): string {
	const lines: string[] = [];

	lines.push("# Probe Results Summary");
	lines.push("");

	// Overview table
	lines.push("## Overview");
	lines.push("| Probe | Status | Duration | Findings |");
	lines.push("|-------|--------|----------|----------|");

	for (const result of results) {
		const status = result.success ? "PASS" : "FAIL";
		const duration = result.duration_ms ? `${result.duration_ms}ms` : "-";
		const findings = result.findings.length;
		lines.push(`| ${result.probe_type} | ${status} | ${duration} | ${findings} |`);
	}
	lines.push("");

	// Summary statistics
	const successful = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;
	const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);

	lines.push("## Summary");
	lines.push(`- Total probes: ${results.length}`);
	lines.push(`- Successful: ${successful}`);
	lines.push(`- Failed: ${failed}`);
	lines.push(`- Total findings: ${totalFindings}`);
	lines.push("");

	// Findings by severity
	const findingsBySeverity: Record<string, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	for (const result of results) {
		for (const finding of result.findings) {
			findingsBySeverity[finding.severity]++;
		}
	}

	if (totalFindings > 0) {
		lines.push("### Findings by Severity");
		lines.push(`- CRITICAL: ${findingsBySeverity.CRITICAL}`);
		lines.push(`- HIGH: ${findingsBySeverity.HIGH}`);
		lines.push(`- MEDIUM: ${findingsBySeverity.MEDIUM}`);
		lines.push(`- LOW: ${findingsBySeverity.LOW}`);
		lines.push(`- INFO: ${findingsBySeverity.INFO}`);
		lines.push("");
	}

	// Failed probes details
	const failedResults = results.filter((r) => !r.success);
	if (failedResults.length > 0) {
		lines.push("## Failed Probes");
		for (const result of failedResults) {
			lines.push(`### ${result.probe_type}`);
			lines.push(`Error: ${result.error || "Unknown error"}`);
			lines.push("");
		}
	}

	// Critical and high findings
	const criticalHighFindings = results.flatMap((r) =>
		r.findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH"),
	);

	if (criticalHighFindings.length > 0) {
		lines.push("## Critical and High Severity Findings");
		for (const finding of criticalHighFindings) {
			lines.push(`### [${finding.severity}] ${finding.title}`);
			lines.push(finding.description);
			if (finding.suggestion) {
				lines.push(`**Suggestion:** ${finding.suggestion}`);
			}
			if (finding.file) {
				lines.push(`**File:** ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}
