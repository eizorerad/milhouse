/**
 * @fileoverview Domain Config Types
 *
 * Pure TypeScript interfaces for Milhouse configuration.
 * This module contains NO external dependencies (no Zod, no fs, etc.)
 * to keep the domain layer pure and testable.
 *
 * @module domain/config/types
 * @since 5.0.0
 */

/**
 * Project information configuration
 *
 * Contains metadata about the project being managed by Milhouse.
 */
export interface ProjectInfo {
	/** Project name (from package.json or directory name) */
	name: string;
	/** Primary programming language */
	language: string;
	/** Detected framework(s) */
	framework: string;
	/** Brief project description */
	description: string;
}

/**
 * Commands configuration
 *
 * Shell commands for common project operations.
 */
export interface CommandsConfig {
	/** Command to run tests */
	test: string;
	/** Command to run linting */
	lint: string;
	/** Command to build the project */
	build: string;
	/** Command to compile the project */
	compile: string;
}

/**
 * Boundaries configuration
 *
 * Defines files and directories that should not be modified.
 */
export interface BoundariesConfig {
	/** Glob patterns for files/directories that should never be touched */
	never_touch: string[];
}

/**
 * Allowed commands configuration
 *
 * Defines which shell commands are permitted during different phases.
 */
export interface AllowedCommandsConfig {
	/** Commands allowed during probe execution */
	probes: string[];
	/** Commands allowed during task execution */
	execution: string[];
}

/**
 * Probe configuration
 *
 * Settings for individual probe behavior.
 */
export interface ProbeConfig {
	/** Whether the probe is enabled */
	enabled: boolean;
	/** Whether the probe operates in read-only mode */
	read_only: boolean;
	/** Timeout in milliseconds */
	timeout_ms: number;
}

/**
 * Execution mode
 *
 * Determines how tasks are executed in relation to git.
 */
export type ExecutionMode = "in-place" | "branch" | "worktree" | "pr";

/**
 * Execution configuration
 *
 * Settings for task execution behavior.
 */
export interface ExecutionConfig {
	/** Execution mode (in-place, branch, worktree, pr) */
	mode: ExecutionMode;
	/** Number of parallel workers */
	parallel: number;
	/** Whether to auto-commit changes */
	auto_commit: boolean;
	/** Whether to create a PR after execution */
	create_pr: boolean;
	/** Whether to create a draft PR */
	draft_pr: boolean;
}

/**
 * Gates configuration
 *
 * Quality gates that must pass before task completion.
 */
export interface GatesConfig {
	/** Require evidence for all changes */
	evidence_required: boolean;
	/** Check diff hygiene (no debug code, etc.) */
	diff_hygiene: boolean;
	/** Check for placeholder text */
	placeholder_check: boolean;
	/** Verify environment consistency */
	env_consistency: boolean;
	/** Verify definition of done */
	dod_verification: boolean;
}

/**
 * Pipeline phase
 *
 * Represents a phase in the Milhouse pipeline.
 */
export type PipelinePhase = "scan" | "validate" | "plan" | "exec" | "verify";

/**
 * Retry policy configuration
 *
 * Settings for retry behavior on failure.
 */
export interface RetryPolicy {
	/** Maximum number of retries */
	maxRetries: number;
	/** Delay between retries in milliseconds */
	delayMs: number;
	/** Whether to use exponential backoff */
	exponentialBackoff: boolean;
}

/**
 * Pipeline configuration
 *
 * Milhouse-specific pipeline settings.
 */
export interface PipelineConfig {
	/** Default phases to execute */
	defaultPhases: PipelinePhase[];
	/** Timeout per phase in milliseconds */
	phaseTimeouts: Record<PipelinePhase, number>;
	/** Retry policy per phase */
	retryPolicy: Record<PipelinePhase, RetryPolicy>;
}

/**
 * Cleanup policy for runs
 */
export type CleanupPolicy = "manual" | "on-success" | "always";

/**
 * Runs configuration
 *
 * Settings for run isolation and management.
 */
export interface RunsConfig {
	/** Directory for storing runs */
	runsDir: string;
	/** Maximum number of runs to keep */
	maxRunsToKeep: number;
	/** When to clean up runs */
	cleanupPolicy: CleanupPolicy;
}

/**
 * Probe preset configuration
 *
 * Predefined combinations of probe settings.
 */
export interface ProbePreset {
	/** Preset name */
	name: string;
	/** Preset description */
	description: string;
	/** Probes enabled in this preset */
	enabledProbes: string[];
	/** Probe-specific overrides */
	overrides: Record<string, Partial<ProbeConfig>>;
}

/**
 * Probe presets configuration
 *
 * Collection of probe presets with active selection.
 */
export interface ProbePresetsConfig {
	/** Currently active preset */
	activePreset: string;
	/** Available presets */
	presets: Record<string, ProbePreset>;
}

/**
 * Gate profile configuration
 *
 * Predefined gate strictness levels.
 */
export interface GateProfile {
	/** Profile name */
	name: string;
	/** Profile description */
	description: string;
	/** Gate settings for this profile */
	gates: GatesConfig;
}

/**
 * Gate profiles configuration
 *
 * Collection of gate profiles with active selection.
 */
export interface GateProfilesConfig {
	/** Currently active profile */
	activeProfile: string;
	/** Available profiles */
	profiles: Record<string, GateProfile>;
}

/**
 * Milhouse configuration
 *
 * Complete configuration for a Milhouse-managed project.
 * This is the main configuration interface used throughout the application.
 */
export interface MilhouseConfig {
	/** Configuration version for migration support */
	version?: string;
	/** Project information */
	project: ProjectInfo;
	/** Shell commands */
	commands: CommandsConfig;
	/** Rules that AI must follow */
	rules: string[];
	/** File/directory boundaries */
	boundaries: BoundariesConfig;
	/** Allowed shell commands */
	allowed_commands: AllowedCommandsConfig;
	/** Probe configurations */
	probes: Record<string, ProbeConfig>;
	/** Execution settings */
	execution: ExecutionConfig;
	/** Quality gates */
	gates: GatesConfig;
	/** Pipeline settings (Milhouse-specific) */
	pipeline?: PipelineConfig;
	/** Run isolation settings (Milhouse-specific) */
	runs?: RunsConfig;
	/** Probe presets (Milhouse-specific) */
	probePresets?: ProbePresetsConfig;
	/** Gate profiles (Milhouse-specific) */
	gateProfiles?: GateProfilesConfig;
}

/**
 * Detected project information
 *
 * Result of automatic project detection.
 */
export interface DetectedProject {
	/** Project name (from package.json or directory name) */
	name: string;
	/** Primary programming language */
	language: string;
	/** Detected framework(s) */
	framework: string;
	/** Command to run tests */
	testCmd: string;
	/** Command to run linting */
	lintCmd: string;
	/** Command to build the project */
	buildCmd: string;
}
