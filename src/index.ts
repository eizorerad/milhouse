#!/usr/bin/env bun
/** Milhouse CLI entry point. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { CONFIG_TEMPLATE, ConfigError, DEFAULTS, loadConfig } from "./config.ts";
import { repoRoot } from "./git.ts";
import { cleanupRun } from "./phases/merge.ts";
import { runPipeline } from "./pipeline.ts";
import { formatReport, generateReport } from "./report.ts";
import { RunStore, STATE_DIR, ensureIgnoreFile } from "./state.ts";
import { PHASES, type Phase } from "./types.ts";
import { log, printBanner, setVerbose } from "./ui.ts";
import { errorMessage } from "./util.ts";

const HELP = `milhouse v${pkg.version} — correctness-first AI coding orchestrator (runs on Claude Code)

Usage:
  milhouse "fix auth bugs"        Run the whole pipeline; the text is the scope
  milhouse --run                  Run the whole pipeline
  milhouse --resume               Continue the latest run (--run-id <id> for another one)
  milhouse --scan|--validate|--plan|--consolidate|--exec|--merge
                                  Run one phase (all but --scan continue the latest run)
  milhouse --report [--format md] Show a run report
  milhouse --list-runs            List runs
  milhouse --clean [--days 30]    Delete finished runs older than N days
  milhouse --init                 Create .milhouse/config.ts

Options:
  --scope <text>   What to look for (same as the positional text)
  --workers <n>    Parallel agents for validate and plan
  --model <name>   Claude model for every step
  --run-id <id>    Pick the run for --resume, --report and single phases
  -v, --verbose    Debug output
  -V, --version    Print the version
  -h, --help       Print this help

Pipeline: scan -> validate -> plan -> consolidate -> exec -> merge
exec implements one issue at a time in a worktree and accepts it only after the checks and the review pass.`;

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

/** CLI flags as config overrides. --model beats the per-step models too; --workers only affects parallel steps. */
function cliOverrides(
	model: string | undefined,
	workers: number | undefined,
): Record<string, unknown> {
	if (!model && !workers) return {};
	const phases = Object.fromEntries(
		Object.entries(DEFAULTS.phases).map(([step, options]) => [
			step,
			{
				...(model && { model }),
				...(workers && options.workers !== undefined && { workers }),
			},
		]),
	);
	return { ...(model && { model }), phases };
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
	const runIntent = Boolean(values.run || values.resume || only || scope);

	if (values.version) {
		console.log(pkg.version);
		return 0;
	}
	if (
		values.help ||
		!(runIntent || values.init || values.report || values["list-runs"] || values.clean)
	) {
		console.log(HELP);
		return 0;
	}

	if (values.init) {
		initProject(workDir);
		return 0;
	}

	if (values["list-runs"]) {
		const runs = RunStore.list(workDir);
		if (runs.length === 0) console.log("No runs yet.");
		for (const run of runs)
			console.log(`${run.id}  ${run.status.padEnd(9)} ${run.phase.padEnd(12)} ${run.scope ?? "-"}`);
		return 0;
	}
	if (values.report) {
		const format = values.format === "md" ? "md" : "terminal";
		console.log(formatReport(generateReport(selectRun(workDir, values["run-id"])), format));
		return 0;
	}
	if (values.clean) {
		const removed = RunStore.clean(workDir, positiveInt(values.days, "--days") ?? 30);
		for (const id of removed) await cleanupRun(new RunStore(workDir, id)); // unmerged work is kept
		console.log(
			removed.length > 0
				? `Removed ${removed.length} run(s):\n${removed.join("\n")}`
				: "Nothing to clean.",
		);
		return 0;
	}

	const workers = positiveInt(values.workers, "--workers");
	const config = await loadConfig(workDir, cliOverrides(values.model, workers));
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
