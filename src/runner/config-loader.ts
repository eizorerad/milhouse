/**
 * Config loader -- merges defaults + config.yml + CLI flags into ResolvedConfig
 *
 * Precedence: CLI flags > config.yml > defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RuntimeOptions } from "../cli/runtime-options.ts";
import { logInfo } from "../ui/logger.ts";
import type { CostConfig, ReportConfig, ResolvedConfig } from "./types.ts";

/** Default cost configuration */
const DEFAULT_COST: CostConfig = {
	inputPerMillion: 5,
	outputPerMillion: 25,
	budgetLimit: 0, // unlimited
};

/** Default report configuration */
const DEFAULT_REPORT: ReportConfig = {
	enabled: true,
	format: "json",
	autoGenerate: true,
};

/** Default resolved config values */
const DEFAULTS: ResolvedConfig = {
	engine: "claude",
	model: "opus",
	phases: {},
	workers: 5,
	cost: DEFAULT_COST,
	report: DEFAULT_REPORT,
	skipTests: false,
	skipLint: false,
	skipProbes: false,
	autoCommit: true,
	createPr: false,
	isolate: false,
	skipMerge: false,
	verbose: false,
	dryRun: false,
	failFast: false,
	maxRetries: 3,
	baseBranch: "",
	draftPr: false,
	maxValidationRetries: 2,
	retryUnvalidated: true,
	tmux: false,
	tmuxAutoAttach: false,
	autoInstall: true,
	unsafeDoDChecks: false,
};

/**
 * Deep merge two objects (target is overwritten by source where source has values)
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
	const result = { ...target };
	for (const key of Object.keys(source) as Array<keyof T>) {
		const srcVal = source[key];
		const tgtVal = target[key];
		if (
			srcVal !== undefined &&
			srcVal !== null &&
			typeof srcVal === "object" &&
			!Array.isArray(srcVal) &&
			typeof tgtVal === "object" &&
			tgtVal !== null &&
			!Array.isArray(tgtVal)
		) {
			(result as Record<string, unknown>)[key as string] = deepMerge(
				tgtVal as Record<string, unknown>,
				srcVal as Record<string, unknown>,
			);
		} else if (srcVal !== undefined) {
			(result as Record<string, unknown>)[key as string] = srcVal;
		}
	}
	return result;
}

/**
 * Load and parse .milhouse/config.yaml if it exists
 */
function loadYamlConfig(workDir: string): Record<string, unknown> | null {
	const paths = [
		join(workDir, ".milhouse", "config.yaml"),
		join(workDir, ".milhouse", "config.yml"),
	];

	for (const configPath of paths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				const parsed = parseYaml(content);
				return typeof parsed === "object" && parsed !== null
					? (parsed as Record<string, unknown>)
					: null;
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Map YAML config keys to ResolvedConfig structure
 */
function mapYamlToResolved(
	yaml: Record<string, unknown>,
): Partial<ResolvedConfig> {
	const result: Partial<ResolvedConfig> = {};

	if (yaml.engine) result.engine = String(yaml.engine);
	if (yaml.model) result.model = String(yaml.model);
	if (yaml.workers) result.workers = Number(yaml.workers);

	// Per-phase model overrides
	if (yaml.phases && typeof yaml.phases === "object") {
		result.phases = {};
		for (const [phase, config] of Object.entries(
			yaml.phases as Record<string, unknown>,
		)) {
			if (typeof config === "object" && config !== null) {
				const phaseConfig = config as Record<string, unknown>;
				result.phases[phase] = {};
				if (phaseConfig.model) {
					result.phases[phase].model = String(phaseConfig.model);
				}
			} else if (typeof config === "string") {
				// Shorthand: phases.scan: sonnet
				result.phases[phase] = { model: config };
			}
		}
	}

	// Cost config
	if (yaml.cost && typeof yaml.cost === "object") {
		const costYaml = yaml.cost as Record<string, unknown>;
		result.cost = {
			inputPerMillion: Number(
				costYaml.input_per_million ??
					costYaml.inputPerMillion ??
					DEFAULT_COST.inputPerMillion,
			),
			outputPerMillion: Number(
				costYaml.output_per_million ??
					costYaml.outputPerMillion ??
					DEFAULT_COST.outputPerMillion,
			),
			budgetLimit: Number(
				costYaml.budget_limit ??
					costYaml.budgetLimit ??
					DEFAULT_COST.budgetLimit,
			),
		};
	}

	// Report config
	if (yaml.report && typeof yaml.report === "object") {
		const reportYaml = yaml.report as Record<string, unknown>;
		result.report = {
			enabled: reportYaml.enabled !== false,
			format:
				(reportYaml.format as ReportConfig["format"]) ??
				DEFAULT_REPORT.format,
			autoGenerate:
				reportYaml.auto_generate !== false &&
				reportYaml.autoGenerate !== false,
		};
	}

	// Skip options
	if (yaml.skip_tests !== undefined)
		result.skipTests = Boolean(yaml.skip_tests);
	if (yaml.skip_lint !== undefined) result.skipLint = Boolean(yaml.skip_lint);
	if (yaml.skip_probes !== undefined)
		result.skipProbes = Boolean(yaml.skip_probes);

	// Exec options
	if (yaml.exec && typeof yaml.exec === "object") {
		const execYaml = yaml.exec as Record<string, unknown>;
		if (execYaml.auto_commit !== undefined)
			result.autoCommit = Boolean(execYaml.auto_commit);
		if (execYaml.create_pr !== undefined)
			result.createPr = Boolean(execYaml.create_pr);
		if (execYaml.isolate !== undefined)
			result.isolate = Boolean(execYaml.isolate);
		if (execYaml.skip_merge !== undefined)
			result.skipMerge = Boolean(execYaml.skip_merge);
	}

	return result;
}

/**
 * Apply CLI options as overrides (highest precedence)
 */
function applyCLIOverrides(
	config: ResolvedConfig,
	cli: RuntimeOptions,
): ResolvedConfig {
	const result = { ...config };

	if (cli.aiEngine && cli.aiEngine !== "claude") result.engine = cli.aiEngine;
	if (cli.modelOverride) result.model = cli.modelOverride;
	if (cli.workers !== undefined) result.workers = cli.workers;
	else if (cli.maxParallel !== undefined && cli.maxParallel !== 4)
		result.workers = cli.maxParallel;

	result.skipTests = cli.skipTests;
	result.skipLint = cli.skipLint;
	if (cli.skipProbes !== undefined) result.skipProbes = cli.skipProbes;

	result.verbose = cli.verbose;
	result.dryRun = cli.dryRun;
	if (cli.failFast !== undefined) result.failFast = cli.failFast;
	result.maxRetries = cli.maxRetries;

	result.autoCommit = cli.autoCommit;
	result.createPr = cli.createPr;
	result.draftPr = cli.draftPr;
	result.baseBranch = cli.baseBranch;
	if (cli.isolate !== undefined) result.isolate = cli.isolate;
	else if (cli.branchPerTask) result.isolate = true;
	if (cli.skipMerge !== undefined) result.skipMerge = cli.skipMerge;

	if (cli.runId) result.runId = cli.runId;
	if (cli.scanFocus) result.scanFocus = cli.scanFocus;
	if (cli.issueIds) result.issueIds = cli.issueIds;
	if (cli.excludeIssueIds) result.excludeIssueIds = cli.excludeIssueIds;

	if (cli.maxValidationRetries !== undefined)
		result.maxValidationRetries = cli.maxValidationRetries;
	if (cli.retryUnvalidated !== undefined)
		result.retryUnvalidated = cli.retryUnvalidated;

	if (cli.tmux !== undefined) result.tmux = cli.tmux;
	if (cli.tmuxAutoAttach !== undefined)
		result.tmuxAutoAttach = cli.tmuxAutoAttach;
	if (cli.autoInstall !== undefined) result.autoInstall = cli.autoInstall;
	if (cli.unsafeDoDChecks !== undefined)
		result.unsafeDoDChecks = cli.unsafeDoDChecks;

	return result;
}

/**
 * Load resolved configuration
 *
 * Merges: defaults -> config.yml -> CLI flags
 * CLI flags always win.
 *
 * @param workDir - Working directory containing .milhouse/
 * @param cliOptions - CLI runtime options
 * @returns Fully resolved configuration
 */
export function loadResolvedConfig(
	workDir: string,
	cliOptions: RuntimeOptions,
): ResolvedConfig {
	// Start with defaults
	let config: ResolvedConfig = {
		...DEFAULTS,
		cost: { ...DEFAULT_COST },
		report: { ...DEFAULT_REPORT },
	};

	// Merge config.yml (if exists)
	const yaml = loadYamlConfig(workDir);
	if (yaml) {
		const yamlConfig = mapYamlToResolved(yaml);
		config = deepMerge(config, yamlConfig);
	} else {
		logInfo("No .milhouse/config.yaml found, using defaults. Run \"milhouse --init\" to configure.");
	}

	// CLI flags override everything
	config = applyCLIOverrides(config, cliOptions);

	return config;
}

/**
 * Get the resolved config defaults (for testing/reference)
 */
export function getConfigDefaults(): ResolvedConfig {
	return {
		...DEFAULTS,
		cost: { ...DEFAULT_COST },
		report: { ...DEFAULT_REPORT },
	};
}
