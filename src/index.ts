#!/usr/bin/env bun
import { parseArgs } from "./cli/args.ts";
import { addRule, showConfig } from "./cli/commands/config.ts";
import { runConsolidate } from "./cli/commands/consolidate.ts";
import { runExec } from "./cli/commands/exec.ts";
import { parseFormats, runExport } from "./cli/commands/export.ts";
import { runInit } from "./cli/commands/init.ts";
import { runPlan } from "./cli/commands/plan.ts";
import { runLoop, runPipelineMode } from "./cli/commands/run.ts";
import { runsCommand } from "./cli/commands/runs.ts";
import { runScan } from "./cli/commands/scan.ts";
import { runTask } from "./cli/commands/task.ts";
import { runValidate } from "./cli/commands/validate.ts";
import { runVerify } from "./cli/commands/verify.ts";
import type { PipelinePhase } from "./execution/pipeline.ts";
import { logError } from "./ui/logger.ts";

async function main(): Promise<void> {
	try {
		const {
			options,
			task,
			initMode,
			showConfig: showConfigMode,
			addRule: rule,
			scanMode,
			validateMode,
			planMode,
			consolidateMode,
			execMode,
			verifyMode,
			exportMode,
			exportFormat,
			runMode,
			resumeMode,
			forceMode,
			failFast,
			startPhase,
			endPhase,
			runsMode,
			runsSubcommand,
			runsArgs,
		} = parseArgs(process.argv);

		// Handle "milhouse runs" subcommand
		if (runsMode) {
			if (!runsSubcommand) {
				// Default to list
				await runsCommand("list", runsArgs, { workDir: process.cwd() });
			} else {
				await runsCommand(runsSubcommand, runsArgs, { workDir: process.cwd() });
			}
			return;
		}

		// Handle --init
		if (initMode) {
			await runInit();
			return;
		}

		// Handle --config
		if (showConfigMode) {
			await showConfig();
			return;
		}

		// Handle --add-rule
		if (rule) {
			await addRule(rule);
			return;
		}

		// Handle --scan
		if (scanMode) {
			await runScan(options);
			return;
		}

		// Handle --validate
		if (validateMode) {
			await runValidate(options);
			return;
		}

		// Handle --plan
		if (planMode) {
			await runPlan(options);
			return;
		}

		// Handle --consolidate
		if (consolidateMode) {
			await runConsolidate(options);
			return;
		}

		// Handle --exec
		if (execMode) {
			await runExec(options);
			return;
		}

		// Handle --verify
		if (verifyMode) {
			await runVerify(options);
			return;
		}

		// Handle --export
		if (exportMode) {
			await runExport(options, { formats: parseFormats(exportFormat) });
			return;
		}

		// Handle --run (full pipeline mode)
		if (runMode || resumeMode) {
			await runPipelineMode(options, {
				startPhase: startPhase as PipelinePhase | undefined,
				endPhase: endPhase as PipelinePhase | undefined,
				resume: resumeMode,
				force: forceMode,
				failFast,
			});
			return;
		}

		// Single task mode (brownfield)
		// Note: Check for command aliases first (scan, validate, plan, etc.)
		if (task) {
			// Handle command aliases (e.g., "milhouse scan" as alias for "milhouse --scan")
			const commandAliases: Record<string, () => Promise<unknown>> = {
				scan: () => runScan(options),
				validate: () => runValidate(options),
				plan: () => runPlan(options),
				consolidate: () => runConsolidate(options),
				exec: () => runExec(options),
				verify: () => runVerify(options),
				init: () => runInit(),
				config: () => showConfig(),
			};

			const aliasHandler = commandAliases[task.toLowerCase()];
			if (aliasHandler) {
				await aliasHandler();
				return;
			}

			// Otherwise, treat as a single task (brownfield mode)
			await runTask(task, options);
			return;
		}

		// PRD loop mode (legacy)
		await runLoop(options);
	} catch (error) {
		logError(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

main();
