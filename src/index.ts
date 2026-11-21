#!/usr/bin/env bun
/** Milhouse CLI entry point. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import {
	ConfigError,
	DEFAULTS,
	configTemplate,
	loadConfig,
	projectChecksEnabled,
	stepHarness,
} from "./config.ts";
import { detectCommands } from "./detect.ts";
import { HARNESSES } from "./engine.ts";
import { isRepo, repoRoot } from "./git.ts";
import { acquireLock } from "./lock.ts";
import { runPipeline } from "./pipeline.ts";
import { REPORT_FORMATS, type ReportFormat, formatReport, generateReport } from "./report.ts";
import { KEEP_DAYS, RunStore, STATE_DIR, ensureIgnoreFile } from "./state.ts";
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
import { removeRun } from "./worktree.ts";

const HELP = `milhouse v${pkg.version} - correctness-first AI coding orchestrator (drives Claude Code or Codex)

Usage:
  milhouse "fix auth bugs"        Run the whole pipeline; the text is the scope
  milhouse --run                  Run the whole pipeline
  milhouse --resume               Continue the latest run (--run-id <id> for another one)
  milhouse --scan|--validate|--plan|--consolidate|--exec|--merge
                                  Run one phase (all but --scan continue the latest run)
  milhouse --report [--format md|json]
                                  Show a run report: issues, tasks, commits, cost
  milhouse --list-runs            List runs
  milhouse --clean [--days 30] [--all]
                                  Delete finished runs older than N days (--all: stopped and
                                  interrupted ones too); unmerged accepted work is kept
  milhouse init                   Create .milhouse/config.ts without running agents (also: --init)

Options:
  --scope <text>   What to look for (same as the positional text)
  --workers <n>    Parallel agents for validate and plan
  --harness <name> Agent for every step: claude or codex
  --allow-unchecked  Run exec without a build, lint or test command (an agent alone reviews the work)
  --no-baseline    Do not check the starting commit first (when its failure is what the run should fix)
  --budget <usd>   Spending limit of the run, for this command (0 = none)
  --max-tokens <n> The same for the tokens of an agent that reports no dollars (Codex)
  --max-minutes <n>  The longest this command may take
  --model <name>   Model for every step that runs on the global harness
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
	all: flag,
	scan: flag,
	validate: flag,
	plan: flag,
	consolidate: flag,
	exec: flag,
	merge: flag,
	"allow-unchecked": flag,
	"no-baseline": flag,
	budget: { type: "string" },
	"max-tokens": { type: "string" },
	"max-minutes": { type: "string" },
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

function positiveInt(value: string | undefined, name: string, min = 1): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (value.trim() === "" || !Number.isInteger(n) || n < min) {
		throw new UsageError(
			min > 0 ? `${name} must be a positive integer` : `${name} must be an integer of 0 or more`,
		);
	}
	return n;
}

/** A limit given on the command line: a number of 0 or more, where 0 is no limit. */
function limit(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
		throw new UsageError(`${name} must be a number of 0 or more`);
	}
	return n;
}

function parseHarness(value: string | undefined): HarnessName | undefined {
	if (value === undefined) return undefined;
	if (!(HARNESS_NAMES as readonly string[]).includes(value)) {
		throw new UsageError(`--harness must be one of: ${HARNESS_NAMES.join(", ")}`);
	}
	return value as HarnessName;
}

function parseFormat(value: string | undefined): ReportFormat {
	const format = value ?? "terminal";
	if (!(REPORT_FORMATS as readonly string[]).includes(format)) {
		throw new UsageError(`--format must be one of: ${REPORT_FORMATS.join(", ")}`);
	}
	return format as ReportFormat;
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

const commandLines = (commands: Partial<Config["commands"]>): string =>
	Object.entries(commands)
		.map(([slot, command]) => `  ${slot}: ${command}`)
		.join("\n");

/**
 * Write `.milhouse/config.ts` with the commands the project defines and the agent that is installed, unless
 * there is one. The first run of a project does this by itself; `milhouse init` only does it without
 * starting anything. Returns whether the file is new.
 */
function createConfig(workDir: string): boolean {
	const configPath = join(workDir, STATE_DIR, "config.ts");
	mkdirSync(join(workDir, STATE_DIR), { recursive: true });
	ensureIgnoreFile(workDir);
	if (existsSync(configPath)) return false;
	const found = detectCommands(workDir);
	const installed = HARNESS_NAMES.find((name) => Bun.which(HARNESSES[name].binary()));
	const harness = installed ?? DEFAULTS.harness;
	writeFileSync(configPath, configTemplate(found, harness));
	log.success(
		Object.keys(found).length === 0
			? `Created ${STATE_DIR}/config.ts. No build, lint or test command was found in this project: set commands.test (or build, lint) there, so that the work can be checked.`
			: `Created ${STATE_DIR}/config.ts with the commands this project defines. Setup runs when the worktree is made, build, lint and test on every issue; change them there if they are not right:\n${commandLines(found)}`,
	);
	if (harness !== DEFAULTS.harness) {
		log.info(
			`${HARNESSES[DEFAULTS.harness].label} is not installed here, so the config names ${HARNESSES[harness].label} as the agent.`,
		);
	}
	return true;
}

/**
 * A config without a build, lint or test command stops exec. The project may have got one since the file
 * was written, so look again before refusing, and use what is there now.
 */
function withFoundChecks(config: Config, workDir: string): Config {
	if (projectChecksEnabled(config) || !config.gates.dod || config.allowUnchecked) return config;
	const found = detectCommands(workDir);
	if (![found.build, found.lint, found.test].some(Boolean)) return config;
	log.info(
		`${STATE_DIR}/config.ts sets no build, lint or test command. Using what this project defines now; set them there to keep or change them:\n${commandLines(found)}`,
	);
	const setup = config.commands.setup || found.setup || ""; // a setup of the user's own stays
	return { ...config, commands: { ...config.commands, ...found, setup } };
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

/** Removes old finished runs (`all`: whatever their status). Returns the exit code: 1 when a run had to be kept. */
async function cleanRuns(workDir: string, days: string | undefined, all: boolean): Promise<number> {
	if (!existsSync(join(workDir, STATE_DIR, "runs"))) {
		console.log("Nothing to clean.");
		return 0;
	}
	// Under the lock: a milhouse that resumes one of these runs must not find it half removed.
	const release = acquireLock(workDir);
	// removeRun first: the records go only once nothing of the run is left. A run with unmerged work is kept.
	const { removed, kept } = await RunStore.clean(
		workDir,
		positiveInt(days, "--days", 0) ?? KEEP_DAYS,
		removeRun,
		all,
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
	const runMode = values.run || values.resume || only || values["run-id"] !== undefined;
	const asked = (["report", "list-runs", "clean"] as const).filter((name) => values[name]);
	if (asked.length > 1) {
		throw new UsageError(`Pick one of: ${asked.map((name) => `--${name}`).join(", ")}`);
	}
	const management = asked.length > 0;
	// Reserve the single word "init" only in place of an implicit run. For example, --scan init still has a scope.
	const implicit = !runMode && !management && values.scope === undefined;
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
		if (!createConfig(workDir)) log.warn(`${join(workDir, STATE_DIR, "config.ts")} already exists`);
		return 0;
	}

	if (values["list-runs"]) {
		listRuns(workDir);
		return 0;
	}
	if (values.report) {
		const format = parseFormat(values.format);
		console.log(formatReport(generateReport(selectRun(workDir, values["run-id"])), format));
		return 0;
	}
	if (values.clean) return cleanRuns(workDir, values.days, values.all);

	// A run keeps the scope it started with: text given to a command that continues one would be lost unnoticed.
	const continuing = values.resume || values["run-id"] !== undefined || (only && only !== "scan");
	if (continuing && scope !== undefined) {
		throw new UsageError(
			"A run keeps the scope it started with. Leave the text out to continue it, or start a new run without --resume and --run-id.",
		);
	}

	const workers = positiveInt(values.workers, "--workers");
	const harness = parseHarness(values.harness);
	if (await isRepo(workDir)) createConfig(workDir); // the first run sets the project up by itself
	const loaded = await loadConfig(workDir, {
		...workerOverrides(workers),
		...(values["allow-unchecked"] ? { allowUnchecked: true } : {}),
		...(values["no-baseline"] ? { gates: { baseline: false } } : {}),
		budget: limit(values.budget, "--budget"),
		maxTokens: limit(values["max-tokens"], "--max-tokens"),
		maxMinutes: limit(values["max-minutes"], "--max-minutes"),
	});
	const checked = withFoundChecks(loaded, workDir);
	const chosen = harness ? withHarness(checked, harness) : checked;
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
