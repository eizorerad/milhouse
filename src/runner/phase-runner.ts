/**
 * PhaseRunner — the single runner for all pipeline phases
 *
 * Replaces 5 duplicated command files (~5100 lines) with one ~300-line runner.
 * All phases go through the same code path.
 */

import pLimit from "p-limit";
import pc from "picocolors";
import { type AgentRole, DEFAULT_AGENT_CONFIGS } from "../agents/types.ts";
import { createEngine } from "../engines/index.ts";
import type { AgentRole as EngineAgentRole, PipelinePhase } from "../schemas/engine.schema.ts";
import { acquireRunLock } from "../state/run-lock.ts";
import { createRun, loadRunsIndex, updateRunPhaseInMetaWithLock } from "../state/runs.ts";
import type { RunPhase } from "../state/types.ts";
import { formatDuration, logInfo, logWarn } from "../ui/logger.ts";
import { DynamicAgentSpinner, ProgressSpinner } from "../ui/spinners.ts";
import { phaseIcons, theme } from "../ui/theme.ts";
import {
	BudgetExceededError,
	type RunCost,
	calculateCost,
	checkBudget,
	createRunCost,
	formatCost,
	formatTokens,
} from "./cost.ts";
import type {
	PhaseConfig,
	PhaseContext,
	PhaseItemResult,
	PhaseRunResult,
	ResolvedConfig,
} from "./types.ts";
import { resolvePhaseModel } from "./types.ts";

/** Map internal abbreviated roles to engine's full role names */
const ROLE_TO_ENGINE: Partial<Record<AgentRole, EngineAgentRole>> = {
	LI: "lead-investigator",
	IV: "validator",
	PL: "planner",
	CDM: "consolidator",
	EX: "executor",
	TV: "verifier",
};

const SEPARATOR = "═".repeat(47);

/** Display phase header before execution */
function displayPhaseHeader(phaseName: string, engineName: string, runId: string): void {
	const phaseKey = phaseName as keyof typeof theme.phase;
	const icon = phaseIcons[phaseKey as keyof typeof phaseIcons] ?? "▸";
	const colored = theme.phase[phaseKey] ? theme.phase[phaseKey](phaseName) : phaseName;

	console.log("");
	console.log(pc.dim(SEPARATOR));
	console.log(
		`${icon}  ${pc.bold(colored)}  ${pc.dim("·")}  ${pc.dim(engineName)}  ${pc.dim("·")}  ${pc.dim(runId)}`,
	);
	console.log(pc.dim(SEPARATOR));
}

/**
 * Display the common stats block used by both formatSummary implementations
 * and displayDefaultSummary. Exported for use by phase configs.
 */
export function displayPhaseSummaryHeader(
	phaseName: string,
	results: PhaseItemResult[],
	totalInput: number,
	totalOutput: number,
	config: ResolvedConfig,
	startTime: number,
): void {
	const duration = Date.now() - startTime;
	const succeeded = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;
	const cost = calculateCost({ input: totalInput, output: totalOutput }, config.cost);

	console.log("");
	console.log(pc.dim(SEPARATOR));

	const phaseKey = phaseName as keyof typeof theme.phase;
	const icon = phaseIcons[phaseKey as keyof typeof phaseIcons] ?? "▸";
	const colored = theme.phase[phaseKey] ? theme.phase[phaseKey](phaseName) : phaseName;
	console.log(`${icon}  ${pc.bold(colored)} Summary`);

	console.log(
		`  Items:     ${pc.green(String(succeeded))} succeeded${failed > 0 ? `, ${pc.red(String(failed))} failed` : ""}`,
	);
	console.log(`  Duration:  ${formatDuration(duration)}`);
	console.log(`  Tokens:    ${formatTokens(totalInput)} in / ${formatTokens(totalOutput)} out`);
	console.log(`  Cost:      ${formatCost(cost)}`);

	const failedItems = results.filter((r) => !r.success && r.error);
	for (const item of failedItems) {
		console.log(`  ${pc.red("Error:")}     ${item.error}`);
	}
}

/** Options for running a phase */
export interface RunPhaseOptions {
	/** Working directory */
	workDir: string;
	/** Resolved config (already merged defaults + yaml + CLI) */
	config: ResolvedConfig;
	/** Unified user config (for rules, prompts, project info) */
	userConfig?: import("../config/define.ts").ResolvedFullConfig;
	/** Existing run ID (if resuming) */
	runId?: string;
	/** Scope for scan (creates new run) */
	scope?: string;
	/** Accumulated cost tracker (for pipeline mode) */
	runCost?: RunCost;
}

/**
 * Run a single phase
 */
export async function runPhase<TItem, TResult>(
	phaseConfig: PhaseConfig<TItem, TResult>,
	options: RunPhaseOptions,
): Promise<PhaseRunResult<TResult>> {
	const startTime = Date.now();
	const { workDir, config } = options;
	const runCost = options.runCost ?? createRunCost();

	// 1. Resolve run
	let runId = options.runId;
	if (!runId) {
		if (phaseConfig.name === "scan") {
			// For scan phase, create a new run
			const run = createRun({ scope: options.scope, workDir });
			runId = run.id;
		} else {
			// For other phases, find the latest run
			const index = loadRunsIndex(workDir);
			if (index.runs.length === 0) {
				throw new Error('No runs found. Start with: milhouse --scan --scope "your scope"');
			}
			runId = index.runs[index.runs.length - 1].id;
		}
	}

	// 2. Acquire run lock
	const lock = acquireRunLock(runId, phaseConfig.name, workDir);

	try {
		// 3. Create engine with concurrency matching worker count
		const engine = await createEngine(config.engine, {
			maxConcurrent: config.workers ?? phaseConfig.defaultParallel,
		});

		// 4. Resolve model for this phase
		const model = resolvePhaseModel(config, phaseConfig.name);

		// 5. Create phase context
		const { loadUserConfig } = await import("../config/loader.ts");
		const { resolveConfig } = await import("../config/define.ts");
		const userConfig = options.userConfig ?? resolveConfig(await loadUserConfig(workDir));

		const ctx: PhaseContext = {
			runId,
			workDir,
			engine,
			config,
			startTime,
			userConfig,
			store: {},
		};

		// 6. Update run phase
		await updateRunPhaseInMetaWithLock(runId, phaseConfig.name as RunPhase, workDir);

		// 7. beforeRun hook
		if (phaseConfig.beforeRun) {
			await phaseConfig.beforeRun(ctx);
		}

		// 8. Load items
		const items = await phaseConfig.loadItems(ctx);
		if (items.length === 0 && phaseConfig.mode === "per-item") {
			logWarn(`No items to process for phase "${phaseConfig.name}"`);
			return makeResult(phaseConfig.name, runId, true, [], 0, 0, 0, startTime, { runId });
		}

		// 8b. Display phase header
		displayPhaseHeader(phaseConfig.name, config.engine, runId);

		// 9. Execute with pool
		let allResults = await executePool(phaseConfig, items, ctx, model, config, runCost);

		// 10. Retry loop (if configured)
		if (phaseConfig.isRetryable && phaseConfig.retryFilter) {
			const maxRounds = phaseConfig.maxRetryRounds ?? 2;
			for (let round = 0; round < maxRounds; round++) {
				const retryItems = phaseConfig.retryFilter(items, allResults);
				if (retryItems.length === 0) break;

				logInfo(`Retry round ${round + 1}: ${retryItems.length} items to retry`);

				const retryResults = await executePool(
					phaseConfig,
					retryItems,
					ctx,
					model,
					config,
					runCost,
				);

				// Merge retry results — replace old results for retried items
				const retryIds = new Set(retryItems.map((i) => getFullItemId(i)));
				allResults = allResults.filter((r) => !retryIds.has(getFullItemId(r.item)));
				allResults.push(...retryResults);
			}
		}

		// 11. Save results
		await phaseConfig.saveResults(allResults, ctx);

		// 12. afterRun hook
		if (phaseConfig.afterRun) {
			await phaseConfig.afterRun(allResults, ctx);
		}

		// 13. Calculate totals
		let totalInput = 0;
		let totalOutput = 0;
		for (const r of allResults) {
			totalInput += r.inputTokens;
			totalOutput += r.outputTokens;
		}

		// Set phase breakdown (totals already updated incrementally in executePool)
		const phaseCost = calculateCost({ input: totalInput, output: totalOutput }, config.cost);
		runCost.byPhase[phaseConfig.name] = { inputTokens: totalInput, outputTokens: totalOutput, cost: phaseCost };
		runCost.inputCost += (totalInput / 1_000_000) * config.cost.inputPerMillion;
		runCost.outputCost += (totalOutput / 1_000_000) * config.cost.outputPerMillion;

		// 14. Display summary
		if (phaseConfig.formatSummary) {
			phaseConfig.formatSummary(allResults, ctx);
		} else {
			displayDefaultSummary(
				phaseConfig.name,
				allResults,
				totalInput,
				totalOutput,
				config,
				startTime,
			);
		}

		// 15. Phase transition
		if (phaseConfig.nextPhase) {
			const nextPhase = phaseConfig.nextPhase(allResults, ctx);
			if (nextPhase) {
				await updateRunPhaseInMetaWithLock(runId, nextPhase, workDir);
			}
		}

		const success = allResults.every((r) => r.success);
		const phaseCost = runCost.byPhase[phaseConfig.name]?.cost ?? 0;

		return makeResult(
			phaseConfig.name,
			runId,
			success,
			allResults,
			totalInput,
			totalOutput,
			phaseCost,
			startTime,
			{ runId },
		);
	} finally {
		// 16. Release lock
		lock.release();
	}
}

/**
 * Get human-readable label for a phase+role (e.g. "Scanning repository")
 */
function getPhaseLabel(phaseConfig: PhaseConfig<unknown, unknown>): string {
	const agentName = DEFAULT_AGENT_CONFIGS[phaseConfig.role as AgentRole]?.name ?? phaseConfig.role;
	const labels: Record<string, string> = {
		scan: "Scanning repository",
		validate: "Validating issues",
		plan: "Planning tasks",
		consolidate: "Consolidating plans",
		verify: "Verifying results",
	};
	return labels[phaseConfig.name] ?? `${agentName} working`;
}

/**
 * Execute a single item against the engine with streaming progress
 */
async function executeItem<TItem, TResult>(
	phaseConfig: PhaseConfig<TItem, TResult>,
	item: TItem,
	ctx: PhaseContext,
	model: string,
	onProgress?: (step: string | import("../engines/base.ts").DetailedStep) => void,
): Promise<PhaseItemResult<TResult>> {
	// beforeItem hook
	let processedItem = item;
	if (phaseConfig.beforeItem) {
		processedItem = await phaseConfig.beforeItem(item, ctx);
	}

	const prompt = phaseConfig.buildPrompt(processedItem, ctx);
	const engineOpts = {
		jsonSchema: phaseConfig.jsonSchema,
		modelOverride: model,
		runId: ctx.runId,
		agentRole: ROLE_TO_ENGINE[phaseConfig.role as AgentRole],
		pipelinePhase: phaseConfig.name as PipelinePhase,
	};

	try {
		// Prefer streaming for real-time progress
		const aiResult = ctx.engine.executeStreaming
			? await ctx.engine.executeStreaming(
					prompt,
					ctx.workDir,
					(step) => onProgress?.(step),
					engineOpts,
				)
			: await ctx.engine.execute(prompt, ctx.workDir, engineOpts);

		if (!aiResult.success) {
			return {
				item: processedItem,
				result: undefined as unknown as TResult,
				success: false,
				error: aiResult.error ?? "AI execution failed",
				inputTokens: aiResult.inputTokens,
				outputTokens: aiResult.outputTokens,
			};
		}

		const result = phaseConfig.parseResponse(aiResult.response, processedItem, ctx);
		return {
			item: processedItem,
			result,
			success: true,
			inputTokens: aiResult.inputTokens,
			outputTokens: aiResult.outputTokens,
		};
	} catch (error) {
		return {
			item: processedItem,
			result: undefined as unknown as TResult,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			inputTokens: 0,
			outputTokens: 0,
		};
	}
}

/**
 * Execute items in parallel using p-limit pool with live TUI progress
 */
async function executePool<TItem, TResult>(
	phaseConfig: PhaseConfig<TItem, TResult>,
	items: TItem[],
	ctx: PhaseContext,
	model: string,
	config: ResolvedConfig,
	runCost: RunCost,
): Promise<PhaseItemResult<TResult>[]> {
	const maxParallel = config.workers ?? phaseConfig.defaultParallel;
	const limit = pLimit(maxParallel);
	const isSingle = items.length === 1;
	const roleName = phaseConfig.role as AgentRole;

	// Single-agent mode: one ProgressSpinner with step tracking
	if (isSingle) {
		const spinner = new ProgressSpinner(getPhaseLabel(phaseConfig), [roleName]);

		try {
			checkBudget(runCost, config.cost);
		} catch (e) {
			if (e instanceof BudgetExceededError) {
				spinner.error("Budget exceeded");
				throw e;
			}
		}

		const result = await executeItem(phaseConfig, items[0], ctx, model, (step) =>
			spinner.updateStep(step),
		);

		// Update runCost incrementally so budget checks see real-time spend
		if (result.inputTokens > 0 || result.outputTokens > 0) {
			const itemCost = calculateCost(
				{ input: result.inputTokens, output: result.outputTokens },
				config.cost,
			);
			runCost.totalCost += itemCost;
			runCost.inputTokens += result.inputTokens;
			runCost.outputTokens += result.outputTokens;
			runCost.totalTokens += result.inputTokens + result.outputTokens;
		}

		const tokenInfo = `${formatTokens(result.inputTokens)} in / ${formatTokens(result.outputTokens)} out`;

		if (result.success) {
			spinner.success(`${getPhaseLabel(phaseConfig)} complete (${tokenInfo})`);
		} else {
			spinner.error(`${getPhaseLabel(phaseConfig)} failed: ${result.error}`);
		}

		return [result];
	}

	// Multi-item mode: DynamicAgentSpinner with slot tracking
	const spinner = new DynamicAgentSpinner(maxParallel, items.length, getPhaseLabel(phaseConfig));

	const tasks = items.map((item, idx) =>
		limit(async () => {
			try {
				checkBudget(runCost, config.cost);
			} catch (e) {
				if (e instanceof BudgetExceededError) {
					spinner.error("Budget exceeded");
					throw e;
				}
			}

			const itemId = getItemId(item, idx);
			const slot = spinner.acquireSlot(itemId);

			const result = await executeItem(phaseConfig, item, ctx, model, (step) => {
				const label = typeof step === "string" ? step : (step.shortDetail ?? step.category);
				spinner.updateSlot(slot, label);
			});

			// Update runCost incrementally so budget checks see real-time spend
			if (result.inputTokens > 0 || result.outputTokens > 0) {
				const itemCost = calculateCost(
					{ input: result.inputTokens, output: result.outputTokens },
					config.cost,
				);
				runCost.totalCost += itemCost;
				runCost.inputTokens += result.inputTokens;
				runCost.outputTokens += result.outputTokens;
				runCost.totalTokens += result.inputTokens + result.outputTokens;
			}

			spinner.releaseSlot(slot, result.success);
			return result;
		}),
	);

	try {
		const results = await Promise.all(tasks);
		const succeeded = results.filter((r) => r.success).length;
		spinner.success(
			`${getPhaseLabel(phaseConfig)} complete (${succeeded}/${results.length} succeeded)`,
		);
		return results;
	} catch (error) {
		spinner.error(`${getPhaseLabel(phaseConfig)} failed`);
		throw error;
	}
}

/** Extract full item ID for deduplication (no truncation) */
function getFullItemId(item: unknown): string {
	if (item && typeof item === "object") {
		const obj = item as Record<string, unknown>;
		if (typeof obj.id === "string") return obj.id;
	}
	return "";
}

/** Extract a short identifier from an item for spinner display */
function getItemId(item: unknown, index: number): string {
	if (item && typeof item === "object") {
		const obj = item as Record<string, unknown>;
		if (typeof obj.id === "string") return obj.id.slice(0, 12);
		if (typeof obj.title === "string") return obj.title.slice(0, 16);
		if (typeof obj.symptom === "string") return obj.symptom.slice(0, 16);
	}
	return `#${index + 1}`;
}

/**
 * Display default summary (used when phase doesn't provide formatSummary)
 */
function displayDefaultSummary<TResult>(
	phaseName: string,
	results: PhaseItemResult<TResult>[],
	totalInput: number,
	totalOutput: number,
	config: ResolvedConfig,
	startTime: number,
): void {
	displayPhaseSummaryHeader(phaseName, results, totalInput, totalOutput, config, startTime);
	console.log(pc.dim(SEPARATOR));
	console.log("");
}

/**
 * Create a PhaseRunResult
 */
function makeResult<TResult>(
	phase: string,
	runId: string,
	success: boolean,
	items: PhaseItemResult<TResult>[],
	totalInput: number,
	totalOutput: number,
	cost: number,
	startTime: number,
	data?: Record<string, unknown>,
): PhaseRunResult<TResult> {
	return {
		phase,
		runId,
		success,
		items,
		totalInputTokens: totalInput,
		totalOutputTokens: totalOutput,
		cost,
		duration: Date.now() - startTime,
		data,
	};
}
