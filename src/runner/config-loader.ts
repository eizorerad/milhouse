/**
 * Config loader — merges .milhouse/config.ts + CLI flags into ResolvedConfig
 *
 * Precedence: CLI flags > .milhouse/config.ts > defaults
 *
 * Internally delegates to the unified config loader (src/config/loader.ts)
 * which reads .milhouse/config.ts (primary) or .milhouse/config.yaml (fallback).
 * Then maps the unified Config to the ResolvedConfig interface that PhaseRunner expects.
 */

import type { RuntimeOptions } from "../cli/runtime-options.ts";
import { type ResolvedFullConfig, resolveConfig } from "../config/define.ts";
import { loadUserConfig } from "../config/loader.ts";
import type { CostConfig, ReportConfig, ResolvedConfig } from "./types.ts";

/**
 * Map unified Config → ResolvedConfig (the flat interface PhaseRunner expects)
 */
function mapToResolvedConfig(cfg: ResolvedFullConfig): ResolvedConfig {
	return {
		engine: cfg.engine,
		model: cfg.model,
		phases: Object.fromEntries(
			Object.entries(cfg.phases)
				.filter(([_, p]) => p.model !== cfg.model)
				.map(([name, p]) => [name, { model: p.model }]),
		),
		workers: cfg.phases.exec.workers,
		cost: cfg.cost as CostConfig,
		report: cfg.report as ReportConfig,
		skipTests: cfg.skipTests,
		skipLint: cfg.skipLint,
		autoCommit: cfg.execution.autoCommit,
		createPr: cfg.execution.createPr,
		isolate: cfg.execution.mode === "worktree",
		skipMerge: cfg.execution.skipMerge,
		verbose: false,
		dryRun: false,
		failFast: cfg.failFast,
		maxRetries: cfg.phases.exec.retries,
		baseBranch: "",
		draftPr: cfg.execution.draftPr,
		maxValidationRetries: cfg.phases.validate.retries,
		retryUnvalidated: true,
		tmux: cfg.tmux.enabled,
		tmuxAutoAttach: cfg.tmux.autoAttach,
		autoInstall: true,
		unsafeDoDChecks: false,
		execByIssue: cfg.execution.mode !== "in-place",
	};
}

/**
 * Apply CLI options as overrides (highest precedence)
 */
function applyCLIOverrides(config: ResolvedConfig, cli: RuntimeOptions): ResolvedConfig {
	const result = { ...config };

	// String/number overrides — only apply when explicitly set
	if (cli.aiEngine && cli.aiEngine !== "claude") result.engine = cli.aiEngine;
	if (cli.modelOverride) result.model = cli.modelOverride;
	if (cli.workers !== undefined) result.workers = cli.workers;
	else if (cli.maxParallel !== undefined && cli.maxParallel !== 4) result.workers = cli.maxParallel;

	// Boolean overrides — always apply (CLI defaults are meaningful)
	result.skipTests = cli.skipTests;
	result.skipLint = cli.skipLint;
	result.verbose = cli.verbose;
	result.dryRun = cli.dryRun;
	result.maxRetries = cli.maxRetries;
	result.autoCommit = cli.autoCommit;
	result.createPr = cli.createPr;
	result.draftPr = cli.draftPr;
	result.baseBranch = cli.baseBranch;

	// Conditional overrides — only apply when explicitly provided
	if (cli.failFast !== undefined) result.failFast = cli.failFast;
	if (cli.isolate !== undefined) result.isolate = cli.isolate;
	else if (cli.branchPerTask) result.isolate = true;
	if (cli.skipMerge !== undefined) result.skipMerge = cli.skipMerge;
	if (cli.maxValidationRetries !== undefined)
		result.maxValidationRetries = cli.maxValidationRetries;
	if (cli.retryUnvalidated !== undefined) result.retryUnvalidated = cli.retryUnvalidated;
	if (cli.tmux !== undefined) result.tmux = cli.tmux;
	if (cli.tmuxAutoAttach !== undefined) result.tmuxAutoAttach = cli.tmuxAutoAttach;
	if (cli.autoInstall !== undefined) result.autoInstall = cli.autoInstall;
	if (cli.unsafeDoDChecks !== undefined) result.unsafeDoDChecks = cli.unsafeDoDChecks;

	// Optional values — only set when present
	if (cli.runId) result.runId = cli.runId;
	if (cli.scanFocus) result.scanFocus = cli.scanFocus;
	if (cli.issueIds) result.issueIds = cli.issueIds;
	if (cli.excludeIssueIds) result.excludeIssueIds = cli.excludeIssueIds;
	if (cli.severityFilter) result.severityFilter = cli.severityFilter;
	if (cli.minSeverity) result.minSeverity = cli.minSeverity;
	if (cli.execByIssue !== undefined) result.execByIssue = cli.execByIssue;
	if (cli.taskId) result.taskId = cli.taskId;

	return result;
}

/**
 * Load resolved configuration.
 *
 * Reads .milhouse/config.ts (or .yaml fallback), merges with defaults,
 * then applies CLI flag overrides.
 */
export async function loadResolvedConfig(
	workDir: string,
	cliOptions: RuntimeOptions,
): Promise<ResolvedConfig> {
	const userConfig = await loadUserConfig(workDir);
	const resolved = resolveConfig(userConfig);
	const mapped = mapToResolvedConfig(resolved);
	return applyCLIOverrides(mapped, cliOptions);
}

/**
 * Get the resolved config defaults (for testing/reference)
 */
export function getConfigDefaults(): ResolvedConfig {
	return mapToResolvedConfig(resolveConfig({}));
}
