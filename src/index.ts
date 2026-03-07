#!/usr/bin/env bun
/**
 * Milhouse v0.3 — CLI entry point.
 *
 * Usage:
 *   milhouse "fix auth bugs"           # Full pipeline with scope
 *   milhouse --run                      # Full pipeline
 *   milhouse --scan --scope "bugs"      # Single phase
 *   milhouse --resume                   # Resume from last checkpoint
 *   milhouse --report                   # Show report for latest run
 *   milhouse --resolve                  # AI merge resolver for failed branches
 *   milhouse --init                     # Initialize project
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_TEMPLATE, loadConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import { formatReportMarkdown, formatReportTerminal, generateReport } from "./report.ts";
import { runResolve } from "./resolve.ts";
import { RunStore } from "./state.ts";
import type { Phase } from "./types.ts";
import { log, setVerbose } from "./ui.ts";

async function main(): Promise<void> {
	const { values: opts, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			// Pipeline
			run: { type: "boolean", default: false },
			resume: { type: "boolean", default: false },
			resolve: { type: "boolean", default: false },
			init: { type: "boolean", default: false },
			report: { type: "boolean", default: false },
			"list-runs": { type: "boolean", default: false },
			clean: { type: "boolean", default: false },
			days: { type: "string" },
			// Individual phases
			scan: { type: "boolean", default: false },
			validate: { type: "boolean", default: false },
			plan: { type: "boolean", default: false },
			consolidate: { type: "boolean", default: false },
			exec: { type: "boolean", default: false },
			verify: { type: "boolean", default: false },
			// Options
			scope: { type: "string" },
			workers: { type: "string" },
			model: { type: "string" },
			engine: { type: "string" },
			"run-id": { type: "string" },
			format: { type: "string" }, // "md" | "terminal"
			verbose: { type: "boolean", short: "v", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
		strict: false,
	});

	if (opts.verbose) setVerbose(true);

	if (opts.help) {
		printHelp();
		return;
	}

	// --init
	if (opts.init) {
		await initProject();
		return;
	}

	// --report
	if (opts.report) {
		await showReport(opts["run-id"] as string | undefined, opts.format as string | undefined);
		return;
	}

	// --resolve
	if (opts.resolve) {
		const workDir = process.cwd();
		const config = await loadConfig(workDir);
		await runResolve(config);
		return;
	}

	// --list-runs
	if (opts["list-runs"]) {
		const runs = RunStore.listRuns(process.cwd());
		if (runs.length === 0) {
			console.log("No runs found. Start with: milhouse --run");
		} else {
			const pad = (s: string, n: number) => s.padEnd(n);
			console.log(
				`${pad("ID", 30)} ${pad("Status", 12)} ${pad("Phase", 16)} ${pad("Scope", 20)} Created`,
			);
			console.log("-".repeat(100));
			for (const run of runs) {
				console.log(
					`${pad(run.id, 30)} ${pad(run.status ?? "unknown", 12)} ${pad(run.phase, 16)} ${pad(run.scope ?? "-", 20)} ${run.created_at}`,
				);
			}
		}
		return;
	}

	// --clean
	if (opts.clean) {
		const days = typeof opts.days === "string" ? Number.parseInt(opts.days, 10) : 30;
		const result = RunStore.cleanRuns(process.cwd(), days);
		if (result.removed.length === 0) {
			console.log("No runs to clean.");
		} else {
			console.log(`Removed ${result.removed.length} run(s):`);
			for (const id of result.removed) console.log(`  - ${id}`);
		}
		console.log(`${result.kept} run(s) remaining.`);
		return;
	}

	const workDir = process.cwd();
	const scope = opts.scope ?? (positionals.join(" ") || undefined);

	// Build CLI overrides
	const overrides: Record<string, unknown> = {};
	if (opts.engine && typeof opts.engine === "string") overrides.engine = opts.engine;
	if (opts.model && typeof opts.model === "string") overrides.model = opts.model;
	if (opts.workers && typeof opts.workers === "string") {
		const w = Number.parseInt(opts.workers, 10);
		if (!Number.isNaN(w)) overrides.phases = { exec: { workers: w } };
	}

	const config = await loadConfig(workDir, overrides);

	// Single phase mode
	const phaseFlags: Phase[] = ["scan", "validate", "plan", "consolidate", "exec", "verify"];
	const selectedPhase = phaseFlags.find((p) => opts[p as keyof typeof opts]);
	if (selectedPhase) {
		config.pipeline = [selectedPhase];
	}

	await runPipeline(config, {
		scope: typeof scope === "string" ? scope : undefined,
		resume: opts.resume === true,
		runId: typeof opts["run-id"] === "string" ? opts["run-id"] : undefined,
	});
}

async function showReport(runId?: string, format?: string): Promise<void> {
	const workDir = process.cwd();
	const store = runId ? RunStore.byId(workDir, runId) : RunStore.latest(workDir);

	if (!store) {
		log.error("No runs found. Start with: milhouse --run");
		return;
	}

	const report = generateReport(store);

	if (format === "md" || format === "markdown") {
		console.log(formatReportMarkdown(report));
	} else {
		console.log(formatReportTerminal(report));
	}
}

async function initProject(): Promise<void> {
	const dir = join(process.cwd(), ".milhouse");
	const configPath = join(dir, "config.ts");

	if (existsSync(configPath)) {
		log.warn(".milhouse/config.ts already exists");
		return;
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(configPath, CONFIG_TEMPLATE);
	log.success("Created .milhouse/config.ts");
}

function printHelp(): void {
	console.log(`
milhouse v0.3 — Correctness-first AI coding orchestrator

Usage:
  milhouse "fix auth bugs"              Full pipeline with scope
  milhouse --run                        Full pipeline
  milhouse --scan --scope "bugs"        Single phase
  milhouse --resume                     Resume from checkpoint
  milhouse --resolve                    AI merge resolver for failed branches
  milhouse --report                     Show latest run report
  milhouse --report --format md         Report as markdown
  milhouse --list-runs                  List all runs with status
  milhouse --clean                      Remove old completed/failed runs
  milhouse --clean --days 7             Clean runs older than 7 days
  milhouse --init                       Initialize project

Pipeline:
  scan → validate → plan → consolidate → exec → verify

Options:
  --scope <text>      Focus area for scan
  --engine <name>     AI engine (claude, gemini, aider)
  --model <name>      Model override
  --workers <n>       Parallel workers for exec
  --run-id <id>       Specific run ID
  --format <fmt>      Report format: terminal (default) | md
  --days <n>          Max age in days for --clean (default: 30)
  -v, --verbose       Verbose output
  -h, --help          Show help
`);
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
