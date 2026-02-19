import { z } from "zod";
import type { Evidence } from "../state/types.ts";

/**
 * Probe type identifiers - matches inspector agent roles
 */
export const ProbeTypeSchema = z.enum([
	"compose", // ETI - Environment Topology Inspector
	"postgres", // DLA - Database Layer Auditor
	"redis", // CA - Cache Auditor
	"storage", // SI - Storage Inspector
	"deps", // DVA - Dependency Version Auditor
	"repro", // RR - Repro Runner
	"validation", // Used during issue validation
]);

export type ProbeType = z.infer<typeof ProbeTypeSchema>;

/**
 * Probe type descriptions
 */
export const PROBE_TYPE_DESCRIPTIONS: Record<ProbeType, string> = {
	compose:
		"Docker Compose topology inspector - analyzes compose files, services, networks, volumes",
	postgres: "PostgreSQL schema/migrations auditor - inspects database structure and migrations",
	redis: "Redis TTL/keyspace inspector - analyzes cache configuration and key patterns",
	storage: "S3/MinIO/FS inspector - examines storage configurations and permissions",
	deps: "Dependency version auditor - compares lockfile versions vs installed",
	repro: "Reproduction runner - executes reproduction steps and captures logs",
	validation: "Issue validation probe - collects evidence during validation",
};

/**
 * Mapping from probe type to agent role
 */
export const PROBE_TO_AGENT_ROLE: Record<ProbeType, string> = {
	compose: "ETI",
	postgres: "DLA",
	redis: "CA",
	storage: "SI",
	deps: "DVA",
	repro: "RR",
	validation: "IV",
};

/**
 * Mapping from agent role to probe type
 */
export const AGENT_ROLE_TO_PROBE: Record<string, ProbeType> = {
	ETI: "compose",
	DLA: "postgres",
	CA: "redis",
	SI: "storage",
	DVA: "deps",
	RR: "repro",
	IV: "validation",
};

/**
 * Probe status values
 */
export const ProbeStatusSchema = z.enum([
	"pending", // Probe is scheduled but not started
	"running", // Probe is currently executing
	"completed", // Probe finished successfully
	"failed", // Probe encountered an error
	"skipped", // Probe was skipped (e.g., service not found)
	"timeout", // Probe timed out
]);

export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

/**
 * Probe severity for issues found
 */
export const ProbeSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

export type ProbeSeverity = z.infer<typeof ProbeSeveritySchema>;

/**
 * Probe finding - an issue or observation discovered by a probe
 */
export const ProbeFindingSchema = z.object({
	/** Unique finding identifier */
	id: z.string(),
	/** Brief title of the finding */
	title: z.string(),
	/** Detailed description */
	description: z.string(),
	/** Severity level */
	severity: ProbeSeveritySchema,
	/** File location if applicable */
	file: z.string().optional(),
	/** Line number in file if applicable */
	line: z.number().optional(),
	/** End line number if applicable */
	line_end: z.number().optional(),
	/** Suggested fix or action */
	suggestion: z.string().optional(),
	/** Related evidence */
	evidence: z.array(z.string()).default([]),
	/** Additional metadata */
	metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProbeFinding = z.infer<typeof ProbeFindingSchema>;

/**
 * Probe result - output from a probe execution
 */
export const ProbeResultSchema = z.object({
	/** Unique probe result identifier */
	probe_id: z.string(),
	/** Type of probe */
	probe_type: ProbeTypeSchema,
	/** Whether the probe executed successfully */
	success: z.boolean(),
	/** Human-readable output summary */
	output: z.string().optional(),
	/** Error message if probe failed */
	error: z.string().optional(),
	/** ISO timestamp of probe execution */
	timestamp: z.string(),
	/** Whether the probe was read-only (no side effects) */
	read_only: z.boolean().default(true),
	/** Execution duration in milliseconds */
	duration_ms: z.number().optional(),
	/** Findings discovered by the probe */
	findings: z.array(ProbeFindingSchema).default([]),
	/** Raw command output if applicable */
	raw_output: z.string().optional(),
	/** Exit code if a command was executed */
	exit_code: z.number().optional(),
});

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/**
 * Probe input - common input for all probes
 */
export const ProbeInputSchema = z.object({
	/** Working directory to run probe in */
	workDir: z.string(),
	/** Target paths to inspect (probe-specific) */
	targets: z.array(z.string()).default([]),
	/** Additional options for the probe */
	options: z.record(z.string(), z.unknown()).default({}),
	/** Timeout in milliseconds */
	timeout_ms: z.number().default(30000),
	/** Whether to run in verbose mode */
	verbose: z.boolean().default(false),
});

export type ProbeInput = z.infer<typeof ProbeInputSchema>;

/**
 * Probe configuration - settings for probe execution
 */
export const ProbeConfigSchema = z.object({
	/** Whether the probe is enabled */
	enabled: z.boolean().default(true),
	/** Whether the probe is read-only */
	read_only: z.boolean().default(true),
	/** Default timeout in milliseconds */
	timeout_ms: z.number().default(30000),
	/** Maximum retries on failure */
	max_retries: z.number().default(2),
	/** Delay between retries in milliseconds */
	retry_delay_ms: z.number().default(2000),
	/** Custom options for the probe */
	options: z.record(z.string(), z.unknown()).default({}),
});

export type ProbeConfig = z.infer<typeof ProbeConfigSchema>;

/**
 * Default probe configurations per type
 */
export const DEFAULT_PROBE_CONFIGS: Record<ProbeType, ProbeConfig> = {
	compose: {
		enabled: true,
		read_only: true,
		timeout_ms: 60000,
		max_retries: 2,
		retry_delay_ms: 2000,
		options: {},
	},
	postgres: {
		enabled: true,
		read_only: true,
		timeout_ms: 90000,
		max_retries: 2,
		retry_delay_ms: 3000,
		options: {},
	},
	redis: {
		enabled: true,
		read_only: true,
		timeout_ms: 60000,
		max_retries: 2,
		retry_delay_ms: 2000,
		options: {},
	},
	storage: {
		enabled: true,
		read_only: true,
		timeout_ms: 60000,
		max_retries: 2,
		retry_delay_ms: 2000,
		options: {},
	},
	deps: {
		enabled: true,
		read_only: true,
		timeout_ms: 90000,
		max_retries: 2,
		retry_delay_ms: 3000,
		options: {},
	},
	repro: {
		enabled: true,
		read_only: false, // Repro may need to execute commands
		timeout_ms: 180000, // 3 minutes - longer for reproduction
		max_retries: 1,
		retry_delay_ms: 5000,
		options: {},
	},
	validation: {
		enabled: true,
		read_only: true,
		timeout_ms: 30000,
		max_retries: 2,
		retry_delay_ms: 2000,
		options: {},
	},
};

/**
 * Get probe configuration for a type
 */
export function getProbeConfig(probeType: ProbeType): ProbeConfig {
	return { ...DEFAULT_PROBE_CONFIGS[probeType] };
}

/**
 * Probe execution metrics
 */
export const ProbeMetricsSchema = z.object({
	/** Execution duration in milliseconds */
	duration_ms: z.number(),
	/** Number of retries performed */
	retries: z.number().default(0),
	/** Number of findings discovered */
	findings_count: z.number().default(0),
	/** Breakdown of findings by severity */
	findings_by_severity: z
		.object({
			CRITICAL: z.number().default(0),
			HIGH: z.number().default(0),
			MEDIUM: z.number().default(0),
			LOW: z.number().default(0),
			INFO: z.number().default(0),
		})
		.default({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }),
	/** Memory usage in bytes if available */
	memory_bytes: z.number().optional(),
});

export type ProbeMetrics = z.infer<typeof ProbeMetricsSchema>;

/**
 * Create empty metrics
 */
export function createEmptyProbeMetrics(): ProbeMetrics {
	return {
		duration_ms: 0,
		retries: 0,
		findings_count: 0,
		findings_by_severity: {
			CRITICAL: 0,
			HIGH: 0,
			MEDIUM: 0,
			LOW: 0,
			INFO: 0,
		},
	};
}

/**
 * Create metrics from probe result
 */
export function createMetricsFromProbeResult(result: ProbeResult): ProbeMetrics {
	const findingsBySeverity = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	for (const finding of result.findings) {
		findingsBySeverity[finding.severity]++;
	}

	return {
		duration_ms: result.duration_ms ?? 0,
		retries: 0,
		findings_count: result.findings.length,
		findings_by_severity: findingsBySeverity,
	};
}

/**
 * Compose probe specific types (ETI - Environment Topology Inspector)
 */

export const ComposeServiceSchema = z.object({
	name: z.string(),
	image: z.string().optional(),
	ports: z.array(z.string()).default([]),
	volumes: z.array(z.string()).default([]),
	environment: z.record(z.string(), z.string()).default({}),
	depends_on: z.array(z.string()).default([]),
	networks: z.array(z.string()).default([]),
	healthcheck: z
		.object({
			test: z.string().optional(),
			interval: z.string().optional(),
			timeout: z.string().optional(),
			retries: z.number().optional(),
		})
		.optional(),
});

export type ComposeService = z.infer<typeof ComposeServiceSchema>;

export const ComposeTopologySchema = z.object({
	version: z.string().optional(),
	services: z.array(ComposeServiceSchema).default([]),
	networks: z.array(z.string()).default([]),
	volumes: z.array(z.string()).default([]),
	config_files: z.array(z.string()).default([]),
});

export type ComposeTopology = z.infer<typeof ComposeTopologySchema>;

export const ComposeProbeOutputSchema = z.object({
	topology: ComposeTopologySchema,
	issues: z.array(ProbeFindingSchema).default([]),
});

export type ComposeProbeOutput = z.infer<typeof ComposeProbeOutputSchema>;

/**
 * PostgreSQL probe specific types (DLA - Database Layer Auditor)
 */

export const PostgresColumnSchema = z.object({
	name: z.string(),
	type: z.string(),
	nullable: z.boolean().default(true),
	default_value: z.string().optional(),
	is_primary: z.boolean().default(false),
	is_foreign: z.boolean().default(false),
	foreign_table: z.string().optional(),
	foreign_column: z.string().optional(),
});

export type PostgresColumn = z.infer<typeof PostgresColumnSchema>;

export const PostgresTableSchema = z.object({
	name: z.string(),
	schema: z.string().default("public"),
	columns: z.array(PostgresColumnSchema).default([]),
	indexes: z.array(z.string()).default([]),
	constraints: z.array(z.string()).default([]),
	row_count: z.number().optional(),
});

export type PostgresTable = z.infer<typeof PostgresTableSchema>;

export const PostgresMigrationSchema = z.object({
	name: z.string(),
	applied: z.boolean(),
	applied_at: z.string().optional(),
	checksum: z.string().optional(),
});

export type PostgresMigration = z.infer<typeof PostgresMigrationSchema>;

export const PostgresProbeOutputSchema = z.object({
	tables: z.array(PostgresTableSchema).default([]),
	migrations: z.array(PostgresMigrationSchema).default([]),
	extensions: z.array(z.string()).default([]),
	connection_info: z
		.object({
			host: z.string().optional(),
			port: z.number().optional(),
			database: z.string().optional(),
			ssl: z.boolean().optional(),
		})
		.optional(),
	issues: z.array(ProbeFindingSchema).default([]),
});

export type PostgresProbeOutput = z.infer<typeof PostgresProbeOutputSchema>;

/**
 * Redis probe specific types (CA - Cache Auditor)
 */

export const RedisKeyPatternSchema = z.object({
	pattern: z.string(),
	count: z.number(),
	sample_keys: z.array(z.string()).default([]),
	avg_ttl_seconds: z.number().optional(),
	avg_size_bytes: z.number().optional(),
});

export type RedisKeyPattern = z.infer<typeof RedisKeyPatternSchema>;

export const RedisProbeOutputSchema = z.object({
	key_patterns: z.array(RedisKeyPatternSchema).default([]),
	total_keys: z.number().default(0),
	memory_used_bytes: z.number().optional(),
	max_memory_bytes: z.number().optional(),
	eviction_policy: z.string().optional(),
	connection_info: z
		.object({
			host: z.string().optional(),
			port: z.number().optional(),
			database: z.number().optional(),
		})
		.optional(),
	issues: z.array(ProbeFindingSchema).default([]),
});

export type RedisProbeOutput = z.infer<typeof RedisProbeOutputSchema>;

/**
 * Storage probe specific types (SI - Storage Inspector)
 */

export const StorageBucketSchema = z.object({
	name: z.string(),
	region: z.string().optional(),
	created_at: z.string().optional(),
	versioning_enabled: z.boolean().default(false),
	public_access: z.boolean().default(false),
	encryption: z.string().optional(),
	object_count: z.number().optional(),
	total_size_bytes: z.number().optional(),
});

export type StorageBucket = z.infer<typeof StorageBucketSchema>;

export const StorageProbeOutputSchema = z.object({
	provider: z.enum(["s3", "minio", "gcs", "azure", "local"]),
	buckets: z.array(StorageBucketSchema).default([]),
	endpoint: z.string().optional(),
	region: z.string().optional(),
	issues: z.array(ProbeFindingSchema).default([]),
});

export type StorageProbeOutput = z.infer<typeof StorageProbeOutputSchema>;

/**
 * Dependency probe specific types (DVA - Dependency Version Auditor)
 */

export const DependencySchema = z.object({
	name: z.string(),
	specified_version: z.string(),
	installed_version: z.string().optional(),
	latest_version: z.string().optional(),
	is_dev: z.boolean().default(false),
	is_outdated: z.boolean().default(false),
	is_vulnerable: z.boolean().default(false),
	vulnerability_severity: ProbeSeveritySchema.optional(),
	vulnerability_ids: z.array(z.string()).default([]),
});

export type Dependency = z.infer<typeof DependencySchema>;

export const DepsProbeOutputSchema = z.object({
	package_manager: z.enum(["npm", "yarn", "pnpm", "pip", "poetry", "cargo", "go", "other"]),
	lockfile: z.string().optional(),
	dependencies: z.array(DependencySchema).default([]),
	total_count: z.number().default(0),
	outdated_count: z.number().default(0),
	vulnerable_count: z.number().default(0),
	issues: z.array(ProbeFindingSchema).default([]),
});

export type DepsProbeOutput = z.infer<typeof DepsProbeOutputSchema>;

/**
 * Repro probe specific types (RR - Repro Runner)
 */

export const ReproStepSchema = z.object({
	step: z.number(),
	command: z.string(),
	expected: z.string().optional(),
	actual: z.string().optional(),
	success: z.boolean(),
	duration_ms: z.number().optional(),
	exit_code: z.number().optional(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
});

export type ReproStep = z.infer<typeof ReproStepSchema>;

export const ReproProbeOutputSchema = z.object({
	reproduced: z.boolean(),
	steps: z.array(ReproStepSchema).default([]),
	environment: z.record(z.string(), z.string()).default({}),
	logs: z.array(z.string()).default([]),
	artifacts: z.array(z.string()).default([]),
	issues: z.array(ProbeFindingSchema).default([]),
});

export type ReproProbeOutput = z.infer<typeof ReproProbeOutputSchema>;

/**
 * Union type for all probe outputs
 */
export type ProbeOutput =
	| ComposeProbeOutput
	| PostgresProbeOutput
	| RedisProbeOutput
	| StorageProbeOutput
	| DepsProbeOutput
	| ReproProbeOutput;

/**
 * Helper functions
 */

/**
 * Check if a string is a valid probe type
 */
export function isValidProbeType(value: string): value is ProbeType {
	return ProbeTypeSchema.safeParse(value).success;
}

/**
 * Check if a probe type is read-only by default
 */
export function isReadOnlyProbe(probeType: ProbeType): boolean {
	return DEFAULT_PROBE_CONFIGS[probeType].read_only;
}

/**
 * Get all probe types
 */
export function getAllProbeTypes(): ProbeType[] {
	return ProbeTypeSchema.options.slice();
}

/**
 * Get inspector probe types (excludes validation)
 */
export function getInspectorProbeTypes(): ProbeType[] {
	return ProbeTypeSchema.options.filter((type) => type !== "validation");
}

/**
 * Get probe type from agent role
 */
export function getProbeTypeFromRole(role: string): ProbeType | undefined {
	return AGENT_ROLE_TO_PROBE[role];
}

/**
 * Get agent role from probe type
 */
export function getAgentRoleFromProbeType(probeType: ProbeType): string {
	return PROBE_TO_AGENT_ROLE[probeType];
}

/**
 * Convert probe result to evidence for state
 */
export function convertProbeResultToEvidence(result: ProbeResult): Evidence {
	return {
		type: "probe",
		probe_id: result.probe_id,
		output: result.output,
		timestamp: result.timestamp,
	};
}

/**
 * Create a probe finding
 */
export function createProbeFinding(
	id: string,
	title: string,
	description: string,
	severity: ProbeSeverity,
	options?: Partial<Omit<ProbeFinding, "id" | "title" | "description" | "severity">>,
): ProbeFinding {
	return {
		id,
		title,
		description,
		severity,
		evidence: options?.evidence ? [...options.evidence] : [],
		metadata: options?.metadata ? { ...options.metadata } : {},
		file: options?.file,
		line: options?.line,
		line_end: options?.line_end,
		suggestion: options?.suggestion,
	};
}

/**
 * Create a probe result
 */
export function createProbeResult(
	probeId: string,
	probeType: ProbeType,
	success: boolean,
	options?: Partial<Omit<ProbeResult, "probe_id" | "probe_type" | "success" | "timestamp">>,
): ProbeResult {
	return {
		probe_id: probeId,
		probe_type: probeType,
		success,
		timestamp: new Date().toISOString(),
		read_only: options?.read_only ?? DEFAULT_PROBE_CONFIGS[probeType].read_only,
		findings: options?.findings ? options.findings.map((f) => ({ ...f })) : [],
		output: options?.output,
		error: options?.error,
		duration_ms: options?.duration_ms,
		raw_output: options?.raw_output,
		exit_code: options?.exit_code,
	};
}

/**
 * Count findings by severity in a probe result
 */
export function countFindingsBySeverity(result: ProbeResult): Record<ProbeSeverity, number> {
	const counts: Record<ProbeSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	for (const finding of result.findings) {
		counts[finding.severity]++;
	}

	return counts;
}

/**
 * Check if probe result has critical or high severity findings
 */
export function hasBlockingFindings(result: ProbeResult): boolean {
	return result.findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
}

/**
 * Get findings filtered by severity
 */
export function getFindingsBySeverity(
	result: ProbeResult,
	severity: ProbeSeverity,
): ProbeFinding[] {
	return result.findings.filter((f) => f.severity === severity);
}

/**
 * Get all critical findings from a probe result
 */
export function getCriticalFindings(result: ProbeResult): ProbeFinding[] {
	return getFindingsBySeverity(result, "CRITICAL");
}

/**
 * Get all high severity findings from a probe result
 */
export function getHighFindings(result: ProbeResult): ProbeFinding[] {
	return getFindingsBySeverity(result, "HIGH");
}

/**
 * Merge multiple probe results into a summary
 */
export function mergeProbeResults(results: ProbeResult[]): {
	total_probes: number;
	successful_probes: number;
	failed_probes: number;
	total_findings: number;
	findings_by_severity: Record<ProbeSeverity, number>;
	total_duration_ms: number;
	has_blocking: boolean;
} {
	const findingsBySeverity: Record<ProbeSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		INFO: 0,
	};

	let totalFindings = 0;
	let totalDurationMs = 0;
	let successfulProbes = 0;
	let failedProbes = 0;

	for (const result of results) {
		if (result.success) {
			successfulProbes++;
		} else {
			failedProbes++;
		}

		totalFindings += result.findings.length;
		totalDurationMs += result.duration_ms ?? 0;

		for (const finding of result.findings) {
			findingsBySeverity[finding.severity]++;
		}
	}

	return {
		total_probes: results.length,
		successful_probes: successfulProbes,
		failed_probes: failedProbes,
		total_findings: totalFindings,
		findings_by_severity: findingsBySeverity,
		total_duration_ms: totalDurationMs,
		has_blocking: findingsBySeverity.CRITICAL > 0 || findingsBySeverity.HIGH > 0,
	};
}
