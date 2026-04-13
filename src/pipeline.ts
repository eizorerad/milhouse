/**
 * Pipeline - loop over phases with budget checking.
 */

import { formatCost, isBudgetExceeded } from "./cost.ts";
import { consolidatePhase } from "./phases/consolidate.ts";
import { execPhase } from "./phases/exec.ts";
import { planPhase } from "./phases/plan.ts";
import { scanPhase } from "./phases/scan.ts";
import { validatePhase } from "./phases/validate.ts";
import { verifyPhase } from "./phases/verify.ts";
import { preflight } from "./preflight.ts";
import { runPhase } from "./runner.ts";
import { RunStore } from "./state.ts";
import type { Config, Phase, PhaseConfig } from "./types.ts";
import { log, printBanner } from "./ui.ts";

const ALL_PHASES: Record<string, PhaseConfig> = {
	scan: scanPhase,
	validate: validatePhase,
	plan: planPhase,
	consolidate: consolidatePhase,
	exec: execPhase,
	verify: verifyPhase,
};

export interface PipelineOptions {
	scope?: string;
	resume?: boolean;
	runId?: string;
}

function getPhasesToRun(pipeline: Phase[], lastCompletedPhase?: Phase): Phase[] {
	if (!lastCompletedPhase) return pipeline;
	const lastCompletedIndex = pipeline.indexOf(lastCompletedPhase);
	if (lastCompletedIndex === -1) return pipeline;
	return pipeline.slice(lastCompletedIndex + 1);
}

export async function runPipeline(config: Config, opts: PipelineOptions = {}): Promise<void> {
	const workDir = process.cwd();
	printBanner();

	try {
		await preflight(config, workDir);
	} catch (err) {
		log.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	let store: RunStore;
	if (opts.resume) {
		const existing =
			opts.runId && !RunStore.exists(workDir, opts.runId)
				? null
				: opts.runId
					? RunStore.byId(workDir, opts.runId)
					: RunStore.latest(workDir);
		if (!existing) {
			log.error("No runs found to resume. Start with: milhouse --run");
			process.exit(1);
		}
		store = existing;
		log.info(`Resuming run ${store.runId}`);
	} else {
		store = RunStore.create(workDir, opts.scope);
		log.info(`New run: ${store.runId}`);
	}

	const cost = store.loadCost();
	const meta = store.loadMeta();
	const phasesToRun = opts.resume
		? getPhasesToRun(config.pipeline, meta.last_completed_phase)
		: config.pipeline;

	log.info(`Pipeline: ${config.pipeline.join(" -> ")}`);
	if (config.cost.budget > 0) {
		log.info(`Budget: $${config.cost.budget}`);
	}

	if (opts.resume && phasesToRun.length === 0) {
		log.success(`Run ${store.runId} is already complete.`);
		return;
	}

	for (const phaseName of phasesToRun) {
		if (isBudgetExceeded(cost, config)) {
			log.warn(`Budget $${config.cost.budget} exceeded (${formatCost(cost)}). Stopping.`);
			store.stopRun(phaseName, "stopped");
			return;
		}

		const phase = ALL_PHASES[phaseName];
		if (!phase) {
			log.warn(`Unknown phase: ${phaseName}, skipping`);
			continue;
		}

		log.phase(phaseName);
		store.startPhase(phaseName);

		const results = await runPhase(phase, store, config, cost);
		store.saveCost(cost);

		const anySuccess = results.some((result) => result.success);
		if (results.length === 0) {
			store.stopRun(phaseName, "stopped");
			return;
		}
		if (!anySuccess && config.failFast) {
			log.error(`Phase "${phaseName}" failed. Stopping (failFast).`);
			store.stopRun(phaseName, "failed");
			return;
		}

		store.completePhase(phaseName);
	}

	store.completeRun();
	log.success(`Pipeline complete. ${formatCost(cost)}`);
}
