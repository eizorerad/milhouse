/**
 * @fileoverview Domain Config Defaults
 *
 * Default values for Milhouse configuration per version.
 * Provides sensible defaults for all configuration options.
 *
 * @module domain/config/defaults
 * @since 5.0.0
 */

import { CONFIG_VERSION } from "./schema.ts";
import type {
	AllowedCommandsConfig,
	BoundariesConfig,
	CommandsConfig,
	ExecutionConfig,
	GateProfilesConfig,
	GatesConfig,
	MilhouseConfig,
	PipelineConfig,
	PipelinePhase,
	ProbePresetsConfig,
	ProjectInfo,
	RetryPolicy,
	RunsConfig,
} from "./types.ts";

/**
 * Default project info
 */
export const DEFAULT_PROJECT_INFO: ProjectInfo = {
	name: "",
	language: "",
	framework: "",
	description: "",
};

/**
 * Default commands config
 */
export const DEFAULT_COMMANDS_CONFIG: CommandsConfig = {
	test: "",
	lint: "",
	build: "",
	compile: "",
};

/**
 * Default boundaries config
 */
export const DEFAULT_BOUNDARIES_CONFIG: BoundariesConfig = {
	never_touch: [],
};

/**
 * Default allowed commands config
 */
export const DEFAULT_ALLOWED_COMMANDS_CONFIG: AllowedCommandsConfig = {
	probes: [],
	execution: [],
};

/**
 * Default execution config
 */
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
	mode: "branch",
	parallel: 4,
	auto_commit: true,
	create_pr: false,
	draft_pr: true,
};

/**
 * Default gates config
 */
export const DEFAULT_GATES_CONFIG: GatesConfig = {
	evidence_required: true,
	diff_hygiene: true,
	placeholder_check: true,
	env_consistency: true,
	dod_verification: true,
};

/**
 * Default phase timeouts in milliseconds
 */
export const DEFAULT_PHASE_TIMEOUTS: Record<PipelinePhase, number> = {
	scan: 60000, // 1 minute
	validate: 120000, // 2 minutes
	plan: 180000, // 3 minutes
	exec: 4000000, // ~66 minutes
	verify: 120000, // 2 minutes
};

/**
 * Default retry policy
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 3,
	delayMs: 5000,
	exponentialBackoff: true,
};

/**
 * Default retry policies per phase
 */
export const DEFAULT_RETRY_POLICIES: Record<PipelinePhase, RetryPolicy> = {
	scan: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
	validate: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
	plan: { maxRetries: 3, delayMs: 5000, exponentialBackoff: true },
	exec: { maxRetries: 3, delayMs: 5000, exponentialBackoff: true },
	verify: { maxRetries: 2, delayMs: 3000, exponentialBackoff: false },
};

/**
 * Default pipeline config
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
	defaultPhases: ["scan", "validate", "plan", "exec", "verify"],
	phaseTimeouts: DEFAULT_PHASE_TIMEOUTS,
	retryPolicy: DEFAULT_RETRY_POLICIES,
};

/**
 * Default runs config
 */
export const DEFAULT_RUNS_CONFIG: RunsConfig = {
	runsDir: ".milhouse/runs",
	maxRunsToKeep: 10,
	cleanupPolicy: "manual",
};

/**
 * Default probe presets config
 */
export const DEFAULT_PROBE_PRESETS_CONFIG: ProbePresetsConfig = {
	activePreset: "standard",
	presets: {
		standard: {
			name: "standard",
			description: "Standard probe configuration for most projects",
			enabledProbes: ["compose", "postgres", "redis", "storage", "deps"],
			overrides: {},
		},
		minimal: {
			name: "minimal",
			description: "Minimal probes for quick scans",
			enabledProbes: ["deps"],
			overrides: {},
		},
		comprehensive: {
			name: "comprehensive",
			description: "All probes enabled for thorough analysis",
			enabledProbes: ["compose", "postgres", "redis", "storage", "deps", "repro"],
			overrides: {},
		},
	},
};

/**
 * Default gate profiles config
 */
export const DEFAULT_GATE_PROFILES_CONFIG: GateProfilesConfig = {
	activeProfile: "standard",
	profiles: {
		strict: {
			name: "strict",
			description: "All gates enabled with no exceptions",
			gates: {
				evidence_required: true,
				diff_hygiene: true,
				placeholder_check: true,
				env_consistency: true,
				dod_verification: true,
			},
		},
		standard: {
			name: "standard",
			description: "Balanced gate configuration for most projects",
			gates: {
				evidence_required: true,
				diff_hygiene: true,
				placeholder_check: true,
				env_consistency: true,
				dod_verification: true,
			},
		},
		relaxed: {
			name: "relaxed",
			description: "Minimal gates for rapid prototyping",
			gates: {
				evidence_required: false,
				diff_hygiene: true,
				placeholder_check: false,
				env_consistency: false,
				dod_verification: false,
			},
		},
	},
};

/**
 * Default config for version 1.0
 *
 * Complete default configuration with all Milhouse-specific features.
 */
export const DEFAULT_CONFIG_V1: MilhouseConfig = {
	version: CONFIG_VERSION,
	project: DEFAULT_PROJECT_INFO,
	commands: DEFAULT_COMMANDS_CONFIG,
	rules: [],
	boundaries: DEFAULT_BOUNDARIES_CONFIG,
	allowed_commands: DEFAULT_ALLOWED_COMMANDS_CONFIG,
	probes: {},
	execution: DEFAULT_EXECUTION_CONFIG,
	gates: DEFAULT_GATES_CONFIG,
	pipeline: DEFAULT_PIPELINE_CONFIG,
	runs: DEFAULT_RUNS_CONFIG,
	probePresets: DEFAULT_PROBE_PRESETS_CONFIG,
	gateProfiles: DEFAULT_GATE_PROFILES_CONFIG,
};

/**
 * Get the current default configuration
 *
 * Returns the default configuration for the current schema version.
 * Use this function to get defaults that match the current version.
 *
 * @returns Default configuration for current version
 */
export function getCurrentDefaults(): MilhouseConfig {
	return { ...DEFAULT_CONFIG_V1 };
}

/**
 * Get default configuration for a specific version
 *
 * @param version - Configuration version
 * @returns Default configuration for the specified version
 * @throws Error if version is not supported
 */
export function getDefaultsForVersion(version: string): MilhouseConfig {
	switch (version) {
		case "1.0":
			return { ...DEFAULT_CONFIG_V1 };
		default:
			throw new Error(`Unsupported configuration version: ${version}`);
	}
}

/**
 * Merge partial config with defaults
 *
 * Deep merges a partial configuration with the default values.
 *
 * @param partial - Partial configuration
 * @returns Complete configuration with defaults applied
 */
export function mergeWithDefaults(partial: Partial<MilhouseConfig>): MilhouseConfig {
	const defaults = getCurrentDefaults();

	return {
		version: partial.version ?? defaults.version,
		project: { ...defaults.project, ...partial.project },
		commands: { ...defaults.commands, ...partial.commands },
		rules: partial.rules ?? defaults.rules,
		boundaries: { ...defaults.boundaries, ...partial.boundaries },
		allowed_commands: { ...defaults.allowed_commands, ...partial.allowed_commands },
		probes: { ...defaults.probes, ...partial.probes },
		execution: { ...defaults.execution, ...partial.execution },
		gates: { ...defaults.gates, ...partial.gates },
		pipeline: partial.pipeline ?? defaults.pipeline,
		runs: partial.runs ?? defaults.runs,
		probePresets: partial.probePresets ?? defaults.probePresets,
		gateProfiles: partial.gateProfiles ?? defaults.gateProfiles,
	};
}
