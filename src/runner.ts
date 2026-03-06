/**
 * Runner — execute one phase: load items → parallel AI calls → parse → save.
 * Handles retry, concurrency, worktrees (for exec), and cost tracking.
 * Shows live spinner/progress during AI calls.
 */

import pLimit from "p-limit";
import { addTokens } from "./cost.ts";
import { execute } from "./engine.ts";
import { cleanupWorktree, createWorktree, mergeCompletedBranches } from "./git.ts";
import type { RunStore } from "./state.ts";
import type { Config, EngineResult, IssueGroup, PhaseConfig, PhaseResult, RunCost } from "./types.ts";
import { ParallelSpinner, Spinner, log } from "./ui.ts";

/**
 * Run a single phase with parallel execution, retry, and live progress.
 */
export async function runPhase<TItem, TResult>(
	phase: PhaseConfig<TItem, TResult>,
	store: RunStore,
	config: Config,
	runCost: RunCost,
): Promise<PhaseResult<TResult>[]> {
	const startTime = Date.now();
	const phaseOpts = config.phases[phase.name];
	const workers = phaseOpts?.workers ?? 1;
	const maxRetries = phaseOpts?.retries ?? 2;
	const model = phaseOpts?.model ?? config.model;

	// 1. Load items
	const items = await phase.loadItems(store, config);
	if (items.length === 0) {
		log.warn(`[${phase.name}] No items to process`);
		return [];
	}

	log.info(`[${phase.name}] ${items.length} item(s), ${workers} worker(s)`);

	// 2. Execute with live UI
	const limit = pLimit(workers);
	const isExec = phase.name === "exec";
	const isSingle = items.length === 1;

	// Choose spinner type based on item count
	const spinner = isSingle
		? new Spinner(`${phase.name} -- processing...`)
		: null;
	const parallel = !isSingle
		? new ParallelSpinner(Math.min(workers, items.length), items.length, phase.name)
		: null;

	// Start the spinner
	if (spinner) spinner.start();
	if (parallel) parallel.start();

	const results = await Promise.all(
		items.map((item, idx) =>
			limit(async (): Promise<PhaseResult<TResult>> => {
				const itemId = getItemId(item, idx);
				const slot = parallel?.acquireSlot(itemId);

				// For exec phase: create worktree
				let workDir = store.workDir;
				if (isExec) {
					try {
						if (parallel && slot != null) parallel.updateSlot(slot, "worktree");
						if (spinner) spinner.update(`${phase.name} -- creating worktree...`);
						workDir = await createWorktree(item as unknown as IssueGroup, store.workDir);
					} catch (err) {
						if (parallel && slot != null) parallel.releaseSlot(slot);
						return {
							item,
							result: undefined as unknown as TResult,
							success: false,
							error: `Worktree failed: ${err instanceof Error ? err.message : String(err)}`,
							tokens: { response: "", inputTokens: 0, outputTokens: 0 },
						};
					}
				}

				// Retry loop
				let lastError = "";
				for (let attempt = 0; attempt <= maxRetries; attempt++) {
					try {
						if (parallel && slot != null) {
							parallel.updateSlot(slot, attempt > 0 ? `retry ${attempt}` : "running");
						}
						if (spinner) {
							spinner.update(
								attempt > 0
									? `${phase.name} -- retry ${attempt}/${maxRetries}...`
									: `${phase.name} -- running AI...`,
							);
						}

						const prompt = phase.buildPrompt(item, store, config);
						const aiResult: EngineResult = await execute(prompt, workDir, config, {
							model,
							jsonSchema: phase.schema,
							maxTurns: phase.maxTurns,
							timeout: phase.timeout,
						});

						// Track cost
						addTokens(runCost, aiResult.inputTokens, aiResult.outputTokens, config);

						if (parallel && slot != null) parallel.updateSlot(slot, "parsing");
						if (spinner) spinner.update(`${phase.name} -- parsing response...`);

						const parsed = phase.parseResponse(aiResult.response, item);

						// Cleanup worktree on success
						if (isExec) {
							if (parallel && slot != null) parallel.updateSlot(slot, "cleanup");
							await cleanupWorktree(workDir, store.workDir);
						}

						if (parallel && slot != null) parallel.releaseSlot(slot);

						return {
							item,
							result: parsed,
							success: true,
							tokens: aiResult,
						};
					} catch (err) {
						lastError = err instanceof Error ? err.message : String(err);
						log.warn(`[${phase.name}] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${lastError.slice(0, 200)}`);
						if (attempt < maxRetries) {
							await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
						}
					}
				}

				// All retries failed — cleanup worktree
				if (isExec) {
					await cleanupWorktree(workDir, store.workDir).catch(() => {});
				}

				if (parallel && slot != null) parallel.releaseSlot(slot);

				return {
					item,
					result: undefined as unknown as TResult,
					success: false,
					error: lastError,
					tokens: { response: "", inputTokens: 0, outputTokens: 0 },
				};
			}),
		),
	);

	// 3. Stop spinner with result
	const succeeded = results.filter((r) => r.success).length;
	const duration = Date.now() - startTime;

	if (spinner) {
		if (succeeded > 0) spinner.success(`${phase.name} complete (${succeeded}/${results.length})`);
		else spinner.fail(`${phase.name} failed`);
	}
	if (parallel) {
		if (succeeded > 0) parallel.success(`${phase.name} complete`);
		else parallel.fail(`${phase.name} failed`);
	}

	// 4. For exec: merge completed branches
	if (isExec) {
		await mergeCompletedBranches(results, store.workDir);
	}

	// 5. Save results
	await phase.saveResults(results, store);

	// 6. Summary line
	log.summary(succeeded, results.length, runCost.totalCost, duration);

	return results;
}

/** Extract a short identifier from an item for spinner display */
function getItemId(item: unknown, index: number): string {
	if (typeof item === "object" && item !== null) {
		const obj = item as Record<string, unknown>;
		// Issue
		if (typeof obj.id === "string") return obj.id;
		// IssueGroup
		if (typeof obj.issueId === "string") return obj.issueId;
		// ScanInput
		if (typeof obj.scope === "string") return `scope-${index}`;
	}
	return `item-${index}`;
}
