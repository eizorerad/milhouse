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
import { PHASES, type Phase } from "./types.ts";
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
			"exec-workers": { type: "string" },
			"phase-workers": { type: "string" },
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

	const workDir = process.cwd();
	const scope = opts.scope ?? (positionals.join(" ") || undefined);

	// Build CLI overrides
	const overrides: Record<string, unknown> = {};
	if (opts.engine && typeof opts.engine === "string") overrides.engine = opts.engine;
	if (opts.model && typeof opts.model === "string") overrides.model = opts.model;
	// --exec-workers (preferred) or --workers (deprecated alias)
	const execWorkersRaw = opts["exec-workers"] ?? undefined;
	const workersRaw = opts.workers ?? undefined;
	if (typeof workersRaw === "string" && typeof execWorkersRaw !== "string") {
		log.warn("--workers is deprecated, use --exec-workers instead");
	}
	const effectiveExecWorkers = typeof execWorkersRaw === "string" ? execWorkersRaw : typeof workersRaw === "string" ? workersRaw : undefined;
	if (effectiveExecWorkers) {
		const w = Number.parseInt(effectiveExecWorkers, 10);
		if (!Number.isNaN(w)) overrides.phases = { exec: { workers: w } };
	}

	// --phase-workers validate=8,exec=2,...
	if (typeof opts["phase-workers"] === "string") {
		const phasesOverride = (overrides.phases ?? {}) as Record<string, Record<string, unknown>>;
		for (const pair of opts["phase-workers"].split(",")) {
			const [name, countStr] = pair.split("=");
			if (!PHASES.includes(name as Phase)) {
				log.warn(`--phase-workers: unknown phase "${name}", skipping`);
				continue;
			}
			const count = Number.parseInt(countStr, 10);
			if (Number.isNaN(count)) {
				log.warn(`--phase-workers: invalid count for "${name}", skipping`);
				continue;
			}
			phasesOverride[name] = { ...phasesOverride[name], workers: count };
		}
		overrides.phases = phasesOverride;
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
  -v, --verbose       Verbose output
  -h, --help          Show help
`);
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
