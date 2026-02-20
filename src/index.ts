#!/usr/bin/env bun
import { parseArgs } from "./cli/args.ts";
import { addRule, showConfig } from "./cli/commands/config.ts";
import { runExecPipeline } from "./cli/commands/pipeline/exec.ts";
import { parseFormats, runExport } from "./cli/commands/export.ts";
import { runInit } from "./cli/commands/init.ts";
import { runConsolidatePipeline } from "./cli/commands/pipeline/consolidate.ts";
import { runPlanPipeline } from "./cli/commands/pipeline/plan.ts";
import { runScanPipeline } from "./cli/commands/pipeline/scan.ts";
import { runValidatePipeline } from "./cli/commands/pipeline/validate.ts";
import { runVerifyPipeline } from "./cli/commands/pipeline/verify.ts";
import { runReport } from "./cli/commands/report.ts";
import { runPipelineV2 } from "./cli/commands/run.ts";
import { runsCommand } from "./cli/commands/runs.ts";
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
			failFast: _failFast,
			startPhase,
			endPhase,
			runsMode,
			runsSubcommand,
			runsArgs,
		} = parseArgs(process.argv);

		// Handle "milhouse runs" subcommand
		if (runsMode) {
			if (!runsSubcommand) {
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

		// Handle --scan (PhaseRunner)
		if (scanMode) {
			await runScanPipeline(options);
			return;
		}

		// Handle --validate (PhaseRunner)
		if (validateMode) {
			await runValidatePipeline(options);
			return;
		}

		// Handle --plan (PhaseRunner)
		if (planMode) {
			await runPlanPipeline(options);
			return;
		}

		// Handle --consolidate (PhaseRunner)
		if (consolidateMode) {
			await runConsolidatePipeline(options);
			return;
		}

		// Handle --exec (PhaseRunner)
		if (execMode) {
			await runExecPipeline(options);
			return;
		}

		// Handle --verify (PhaseRunner)
		if (verifyMode) {
			await runVerifyPipeline(options);
			return;
		}

		// Handle --export
		if (exportMode) {
			await runExport(options, { formats: parseFormats(exportFormat) });
			return;
		}

		// Handle --run (new pipeline orchestrator)
		if (runMode || resumeMode) {
			await runPipelineV2(options, {
				startPhase,
				endPhase,
				resume: resumeMode,
				force: forceMode,
			});
			return;
		}

		// Command aliases (e.g., "milhouse scan" as alias for "milhouse --scan")
		if (task) {
			const commandAliases: Record<string, () => Promise<unknown>> = {
				scan: () => runScanPipeline(options),
				validate: () => runValidatePipeline(options),
				plan: () => runPlanPipeline(options),
				consolidate: () => runConsolidatePipeline(options),
				exec: () => runExecPipeline(options),
				verify: () => runVerifyPipeline(options),
				report: () => runReport(options),
				init: () => runInit(),
				config: () => showConfig(),
			};

			const aliasHandler = commandAliases[task.toLowerCase()];
			if (aliasHandler) {
				await aliasHandler();
				return;
			}

			// Any other text → run full pipeline with it as scope
			options.scanFocus = task;
		}

		// Default: run full pipeline
		await runPipelineV2(options, {
			startPhase,
			endPhase,
			resume: resumeMode,
			force: forceMode,
		});
	} catch (error) {
		logError(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

main();
