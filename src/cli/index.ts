/**
 * @fileoverview Milhouse CLI Module
 *
 * Main entry point for the Milhouse CLI. This module exports all CLI
 * functionality including argument parsing, command execution, and
 * the command tree structure.
 *
 * @module cli
 *
 * @since 4.3.0
 *
 * ## Command Tree Structure
 *
 * Milhouse CLI commands are organized into four groups:
 *
 * ### Core Commands
 * - `init` - Initialize Milhouse configuration
 * - `config` - Show/modify configuration
 *
 * ### Task Commands
 * - `task` - Execute single task (brownfield mode)
 * - `run` - Run full pipeline
 * - `runs` - Manage pipeline runs
 *
 * ### Pipeline Commands
 * - `scan` - Scan for issues (Lead Investigator)
 * - `validate` - Validate issues with probes
 * - `plan` - Generate WBS plans
 * - `consolidate` - Merge into Execution Plan
 * - `exec` - Execute tasks
 * - `verify` - Run verification gates
 *
 * ### Utility Commands
 * - `export` - Export state to md/json
 *
 * @example
 * ```typescript
 * import { parseArgs, printHelp, MILHOUSE_BRANDING } from "./cli";
 *
 * const parsed = parseArgs(process.argv);
 *
 * if (parsed.initMode) {
 *   console.log(`Initializing ${MILHOUSE_BRANDING.name}...`);
 * }
 * ```
 */

// ============================================================================
// Types (exported first to establish type definitions)
// ============================================================================
export {
	// Version and branding
	MILHOUSE_CLI_VERSION,
	MILHOUSE_BRANDING,
	MILHOUSE_PHASES,
	type MilhousePhase,
	// Command status and results
	type CommandStatus,
	type CommandResult,
	type CoreCommandResult,
	type TaskCommandResult,
	type PipelineCommandResult,
	type ScanCommandResult,
	type ValidateCommandResult,
	type PlanCommandResult,
	type ConsolidateCommandResult,
	type ExecCommandResult,
	type VerifyCommandResult,
	type VerificationIssue,
	type ExportCommandResult,
	type RunsCommandResult,
	type RunInfo,
	// CLI context
	type CLIContext,
	// Command tree
	type CommandGroup,
	type CommandMeta,
	COMMAND_TREE,
	getPipelineCommands,
	getCommandMeta,
	getCommandsByGroup,
} from "./types.ts";

// ============================================================================
// Argument Parsing
// ============================================================================
export {
	createProgram,
	parseArgs,
	printVersion,
	printHelp,
	type ParsedArgs,
} from "./args.ts";

// ============================================================================
// Commands (explicit exports to avoid conflicts)
// ============================================================================

// Core commands
export { runInit } from "./commands/init.ts";
export { showConfig, addRule } from "./commands/config.ts";

// Task commands
export { runTask } from "./commands/task.ts";
export { runPipelineV2, runLoop } from "./commands/run.ts";
export { runsCommand } from "./commands/runs.ts";

// Pipeline commands (thin wrappers around PhaseRunner)
export { runScanPipeline } from "./commands/pipeline/scan.ts";
export { runValidatePipeline } from "./commands/pipeline/validate.ts";
export { runPlanPipeline } from "./commands/pipeline/plan.ts";
export { runConsolidatePipeline } from "./commands/pipeline/consolidate.ts";
export { runVerifyPipeline } from "./commands/pipeline/verify.ts";

// Exec command (stays specialized, not in PhaseRunner)
export {
	runExec,
	buildExecutorPrompt,
	getReadyTasksForRun,
	type ExecResult,
} from "./commands/exec.ts";

// Utility commands
export { runExport, parseFormats } from "./commands/export.ts";

// ============================================================================
// Command Groups (for organized imports)
// ============================================================================
export * as pipelineCommands from "./commands/pipeline/index.ts";
