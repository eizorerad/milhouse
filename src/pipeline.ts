/**
 * Pipeline — loop over phases with budget checking.
 */

import { formatCost, isBudgetExceeded } from "./cost.ts";
import { scanPhase } from "./phases/scan.ts";
import { validatePhase } from "./phases/validate.ts";
import { planPhase } from "./phases/plan.ts";
import { consolidatePhase } from "./phases/consolidate.ts";
import { execPhase } from "./phases/exec.ts";
import { verifyPhase } from "./phases/verify.ts";
import { runPhase } from "./runner.ts";
import { RunStore } from "./state.ts";
import type { Config, PhaseConfig } from "./types.ts";
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

export async function runPipeline(config: Config, opts: PipelineOptions = {}): Promise<void> {
	const workDir = process.cwd();

	// Resolve or create run
	let store: RunStore;
	if (opts.resume) {
		const existing = opts.runId
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

	printBanner();
	log.info(`Pipeline: ${config.pipeline.join(" → ")}`);
	if (config.cost.budget > 0) {
		log.info(`Budget: $${config.cost.budget}`);
	}

	for (const phaseName of config.pipeline) {
		// Budget gate
		if (isBudgetExceeded(cost, config)) {
			log.warn(`Budget $${config.cost.budget} exceeded (${formatCost(cost)}). Stopping.`);
			break;
		}

		const phase = ALL_PHASES[phaseName];
		if (!phase) {
			log.warn(`Unknown phase: ${phaseName}, skipping`);
			continue;
		}

		log.phase(phaseName);
		store.updatePhase(phaseName);

		const results = await runPhase(phase, store, config, cost);
		store.saveCost(cost);

		// Stop if no results or all failed (and failFast)
		const anySuccess = results.some((r) => r.success);
		if (results.length === 0 || (!anySuccess && config.failFast)) {
			if (!anySuccess && results.length > 0) {
				log.error(`Phase "${phaseName}" failed. Stopping (failFast).`);
			}
			break;
		}
	}

	store.updatePhase("completed");
	log.success(`Pipeline complete. ${formatCost(cost)}`);
}
