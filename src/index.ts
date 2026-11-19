#!/usr/bin/env bun
/** Milhouse CLI entry point. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { CONFIG_TEMPLATE, ConfigError, loadConfig, stepHarness } from "./config.ts";
import { repoRoot } from "./git.ts";
import { acquireLock } from "./lock.ts";
import { runPipeline } from "./pipeline.ts";
import { formatReport, generateReport } from "./report.ts";
import { RunStore, STATE_DIR, ensureIgnoreFile } from "./state.ts";
import {
	type AgentStep,
	type Config,
	HARNESS_NAMES,
	type HarnessName,
	PHASES,
	type Phase,
} from "./types.ts";
import { log, printBanner, setVerbose } from "./ui.ts";
import { errorMessage } from "./util.ts";
import { cleanupRun } from "./worktree.ts";

const HELP = `milhouse v${pkg.version} - correctness-first AI coding orchestrator (drives Claude Code or Codex)

Usage:
  milhouse "fix auth bugs"        Run the whole pipeline; the text is the scope
  milhouse --run                  Run the whole pipeline
  milhouse --resume               Continue the latest run (--run-id <id> for another one)
  milhouse --scan|--validate|--plan|--consolidate|--exec|--merge
                                  Run one phase (all but --scan continue the latest run)
  milhouse --report [--format md] Show a run report
  milhouse --list-runs            List runs
  milhouse --clean [--days 30]    Delete finished runs older than N days
  milhouse init                   Create .milhouse/config.ts without running agents (also: --init)

Options:
  --scope <text>   What to look for (same as the positional text)
  --workers <n>    Parallel agents for validate and plan
  --harness <name> Agent for every step: claude or codex
  --model <name>   Model for every step (of the steps' harness)
  --run-id <id>    Pick the run for --resume, --report and single phases
  -v, --verbose    Debug output
  -V, --version    Print the version
  -h, --help       Print this help

Pipeline: scan -> validate -> plan -> consolidate -> exec -> merge
Automatic merge needs a passing build, lint or test. Unchecked work waits for an explicit --merge.`;

const flag = { type: "boolean", default: false } as const;

const OPTIONS = {
	run: flag,
	resume: flag,
	init: flag,
	report: flag,
	"list-runs": flag,
	clean: flag,
	scan: flag,
	validate: flag,
	plan: flag,
	consolidate: flag,
	exec: flag,
	merge: flag,
	days: { type: "string" },
	scope: { type: "string" },
	workers: { type: "string" },
	harness: { type: "string" },
	model: { type: "string" },
	"run-id": { type: "string" },
	format: { type: "string" },
	verbose: { type: "boolean", short: "v", default: false },
	version: { type: "boolean", short: "V", default: false },
	help: { type: "boolean", short: "h", default: false },
} as const;

class UsageError extends Error {}

function positiveInt(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
	return n;
}

function parseHarness(value: string | undefined): HarnessName | undefined {
	if (value === undefined) return undefined;
	if (!(HARNESS_NAMES as readonly string[]).includes(value)) {
		throw new UsageError(`--harness must be one of: ${HARNESS_NAMES.join(", ")}`);
	}
	return value as HarnessName;
}

/** --workers as a config override: it only affects the steps that run in parallel. */
function workerOverrides(workers: number | undefined): Record<string, unknown> {
	return workers ? { phases: { validate: { workers }, plan: { workers } } } : {};
}

/**
 * --harness runs every step on that harness, whatever the config says. A model that was named for another
 * harness is dropped: Codex would not understand a Claude alias, nor Claude a Codex model.
 */
function withHarness(config: Config, harness: HarnessName): Config {
	const phases = Object.fromEntries(
		Object.entries(config.phases).map(([step, options]) => {
			const was = options.harness || config.harness;
			return [step, { ...options, harness, model: was === harness ? options.model : "" }];
		}),
	) as Config["phases"];
	return { ...config, harness, model: config.harness === harness ? config.model : "", phases };
}

/**
 * --model beats the per-step models too, but only for steps on the global harness: a step that runs
 * on the other one (a Codex reviewer, say) would not understand a Claude model name.
 */
function withModel(config: Config, model: string): Config {
	const phases = Object.fromEntries(
		Object.entries(config.phases).map(([step, options]) => [
			step,
			stepHarness(config, step as AgentStep) === config.harness ? { ...options, model } : options,
		]),
	) as Config["phases"];
	return { ...config, model, phases };
}

function initProject(workDir: string): void {
	const configPath = join(workDir, STATE_DIR, "config.ts");
	mkdirSync(join(workDir, STATE_DIR), { recursive: true });
	ensureIgnoreFile(workDir);
	if (existsSync(configPath)) {
		log.warn(`${configPath} already exists`);
		return;
	}
	writeFileSync(configPath, CONFIG_TEMPLATE);
	log.success(
		`Created ${STATE_DIR}/config.ts. Set commands.test/lint/build so exec can check its work.`,
	);
}

function selectRun(workDir: string, runId?: string): RunStore {
	const store = runId ? RunStore.byId(workDir, runId) : RunStore.latest(workDir);
	if (!store) throw new UsageError("There are no runs yet. Start one with: milhouse --run");
	return store;
}

function listRuns(workDir: string): void {
	const runs = RunStore.list(workDir);
	if (runs.length === 0) console.log("No runs yet.");
	for (const run of runs)
		console.log(`${run.id}  ${run.status.padEnd(9)} ${run.phase.padEnd(12)} ${run.scope ?? "-"}`);
}

/** Removes old finished runs. Returns the exit code: 1 when a run had to be kept. */
async function cleanRuns(workDir: string, days: string | undefined): Promise<number> {
	if (!existsSync(join(workDir, STATE_DIR, "runs"))) {
		console.log("Nothing to clean.");
		return 0;
	}
	// Under the lock: a milhouse that resumes one of these runs must not find it half removed.
	const release = acquireLock(workDir);
	// cleanupRun first: the records go only once nothing of the run is left. Unmerged work is kept.
	const { removed, kept } = await RunStore.clean(
		workDir,
		positiveInt(days, "--days") ?? 30,
		cleanupRun,
	).finally(release);
	console.log(
		removed.length > 0
			? `Removed ${removed.length} run(s):\n${removed.join("\n")}`
			: "Nothing to clean.",
	);
	for (const { id, reason } of kept) log.warn(`${id} was kept: ${reason}`);
	return kept.length > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	const workDir = await repoRoot(process.cwd()); // works from any subdirectory
	setVerbose(values.verbose);

	const phaseFlags = PHASES.filter((phase) => values[phase]);
	if (phaseFlags.length > 1) throw new UsageError(`Pick one phase, got: ${phaseFlags.join(", ")}`);
	const only: Phase | undefined = phaseFlags[0];
	const scope = values.scope ?? (positionals.join(" ").trim() || undefined);
	const runMode = values.run || values.resume || only;
	const management = values.report || values["list-runs"] || values.clean;
	// Reserve the single word "init" only in place of an implicit run. For example, --scan init still has a scope.
	const implicit =
		!runMode && !management && values["run-id"] === undefined && values.scope === undefined;
	const init = values.init || (implicit && positionals.length === 1 && positionals[0] === "init");

	if (values.version) {
		console.log(pkg.version);
		return 0;
	}
	if (values.help || !(runMode || scope || init || management)) {
		console.log(HELP);
		return 0;
	}

	if (init) {
		initProject(workDir);
		return 0;
	}

	if (values["list-runs"]) {
		listRuns(workDir);
		return 0;
	}
	if (values.report) {
		const format = values.format === "md" ? "md" : "terminal";
		console.log(formatReport(generateReport(selectRun(workDir, values["run-id"])), format));
		return 0;
	}
	if (values.clean) return cleanRuns(workDir, values.days);

	const workers = positiveInt(values.workers, "--workers");
	const harness = parseHarness(values.harness);
	const loaded = await loadConfig(workDir, workerOverrides(workers));
	const chosen = harness ? withHarness(loaded, harness) : loaded;
	const config = values.model ? withModel(chosen, values.model) : chosen;
	printBanner(pkg.version);
	const ok = await runPipeline(config, {
		workDir,
		scope,
		only,
		runId: values["run-id"],
		resume: values.resume || values["run-id"] !== undefined,
	});
	return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		const usage =
			err instanceof UsageError ||
			(err as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS");
		log.error(errorMessage(err));
		if (usage) console.error('Run "milhouse --help" for usage.');
		process.exit(err instanceof ConfigError || usage ? 2 : 1);
	},
);
