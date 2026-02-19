/**
 * PhaseRunner — the single runner for all pipeline phases
 *
 * Replaces 5 duplicated command files (~5100 lines) with one ~300-line runner.
 * All phases go through the same code path.
 */

import pLimit from "p-limit";
import { createEngine } from "../engines/index.ts";
import type { PipelinePhase } from "../schemas/engine.schema.ts";
import { acquireRunLock } from "../state/run-lock.ts";
import {
	createRun,
	loadRunsIndex,
	updateRunPhaseInMetaWithLock,
} from "../state/runs.ts";
import type { RunPhase } from "../state/types.ts";
import { logInfo, logWarn } from "../ui/logger.ts";
import {
	addPhaseCost,
	BudgetExceededError,
	calculateCost,
	checkBudget,
	createRunCost,
	formatCost,
	formatTokens,
	type RunCost,
} from "./cost.ts";
import type {
	PhaseConfig,
	PhaseContext,
	PhaseItemResult,
	PhaseRunResult,
	ResolvedConfig,
} from "./types.ts";
import { resolvePhaseModel } from "./types.ts";

/** Options for running a phase */
export interface RunPhaseOptions {
	/** Working directory */
	workDir: string;
	/** Resolved config (already merged defaults + yaml + CLI) */
	config: ResolvedConfig;
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
				throw new Error("No runs found. Start with: milhouse --scan --scope \"your scope\"");
			}
			runId = index.runs[index.runs.length - 1].id;
		}
	}

	// 2. Acquire run lock
	const lock = acquireRunLock(runId, phaseConfig.name, workDir);

	try {
		// 3. Create engine
		const engine = await createEngine(config.engine);

		// 4. Resolve model for this phase
		const model = resolvePhaseModel(config, phaseConfig.name);

		// 5. Create phase context
		const ctx: PhaseContext = {
			runId,
			workDir,
			engine,
			config,
			store: {},
		};

		// 6. Update run phase
		const phaseMap: Record<string, RunPhase> = {
			scan: "scan",
			validate: "validate",
			plan: "plan",
			consolidate: "consolidate",
			verify: "verify",
		};
		const currentRunPhase = phaseMap[phaseConfig.name];
		if (currentRunPhase) {
			await updateRunPhaseInMetaWithLock(runId, currentRunPhase, workDir);
		}

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

		// 9. Execute with pool
		let allResults = await executePool(
			phaseConfig,
			items,
			ctx,
			model,
			config,
			runCost,
		);

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

				// Merge retry results (replace old results for retried items)
				const retryItemSet = new Set(retryItems);
				allResults = allResults.filter(r => !retryItemSet.has(r.item as TItem));
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

		// Add to run cost
		addPhaseCost(runCost, phaseConfig.name, totalInput, totalOutput, config.cost);

		// 14. Display summary
		if (phaseConfig.formatSummary) {
			phaseConfig.formatSummary(allResults, ctx);
		} else {
			displayDefaultSummary(phaseConfig.name, allResults, totalInput, totalOutput, config, startTime);
		}

		// 15. Phase transition
		if (phaseConfig.nextPhase) {
			const nextPhase = phaseConfig.nextPhase(allResults, ctx);
			if (nextPhase) {
				await updateRunPhaseInMetaWithLock(runId, nextPhase, workDir);
			}
		}

		const success = allResults.every(r => r.success);
		const phaseCost = runCost.byPhase[phaseConfig.name]?.cost ?? 0;

		return makeResult(
			phaseConfig.name, runId, success, allResults,
			totalInput, totalOutput, phaseCost, startTime,
			{ runId },
		);
	} finally {
		// 16. Release lock
		lock.release();
	}
}

/**
 * Execute items in parallel using p-limit pool
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

	const tasks = items.map(item =>
		limit(async () => {
			// Budget check before each item
			try {
				checkBudget(runCost, config.cost);
			} catch (e) {
				if (e instanceof BudgetExceededError) throw e;
			}

			// beforeItem hook
			let processedItem = item;
			if (phaseConfig.beforeItem) {
				processedItem = await phaseConfig.beforeItem(item, ctx);
			}

			// Build prompt
			const prompt = phaseConfig.buildPrompt(processedItem, ctx);

			// Execute
			try {
				const aiResult = await ctx.engine.execute(prompt, ctx.workDir, {
					jsonSchema: phaseConfig.jsonSchema,
					modelOverride: model,
					runId: ctx.runId,
					agentRole: phaseConfig.role as unknown as import("../schemas/engine.schema.ts").AgentRole,
					pipelinePhase: phaseConfig.name as PipelinePhase,
				});

				if (!aiResult.success) {
					return {
						item: processedItem,
						result: undefined as unknown as TResult,
						success: false,
						error: aiResult.error ?? "AI execution failed",
						inputTokens: aiResult.inputTokens,
						outputTokens: aiResult.outputTokens,
					} satisfies PhaseItemResult<TResult>;
				}

				// Parse response
				const result = phaseConfig.parseResponse(aiResult.response, processedItem, ctx);

				return {
					item: processedItem,
					result,
					success: true,
					inputTokens: aiResult.inputTokens,
					outputTokens: aiResult.outputTokens,
				} satisfies PhaseItemResult<TResult>;
			} catch (error) {
				return {
					item: processedItem,
					result: undefined as unknown as TResult,
					success: false,
					error: error instanceof Error ? error.message : String(error),
					inputTokens: 0,
					outputTokens: 0,
				} satisfies PhaseItemResult<TResult>;
			}
		})
	);

	return Promise.all(tasks);
}

/**
 * Display default summary
 */
function displayDefaultSummary<TResult>(
	phaseName: string,
	results: PhaseItemResult<TResult>[],
	totalInput: number,
	totalOutput: number,
	config: ResolvedConfig,
	startTime: number,
): void {
	const duration = Date.now() - startTime;
	const minutes = Math.floor(duration / 60000);
	const seconds = Math.floor((duration % 60000) / 1000);
	const succeeded = results.filter(r => r.success).length;
	const failed = results.filter(r => !r.success).length;

	const cost = calculateCost({ input: totalInput, output: totalOutput }, config.cost);

	console.log("");
	console.log("══════════════════════════════════════════");
	console.log(`${phaseName.charAt(0).toUpperCase() + phaseName.slice(1)} Summary:`);
	console.log(`  Items:     ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""}`);
	console.log(`  Duration:  ${minutes}m ${seconds}s`);
	console.log(`  Tokens:    ${formatTokens(totalInput)} in / ${formatTokens(totalOutput)} out`);
	console.log(`  Cost:      ${formatCost(cost)}`);
	console.log("══════════════════════════════════════════");
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
