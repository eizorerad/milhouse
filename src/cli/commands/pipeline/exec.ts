/**
 * @fileoverview Milhouse Exec Command
 *
 * Handles the --exec command to execute tasks from the Execution Plan
 * using Executor (EX) agents.
 *
 * @module cli/commands/pipeline/exec
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Execute all pending tasks
 * milhouse --exec
 *
 * # Execute in parallel
 * milhouse --exec --parallel
 *
 * # Execute specific task
 * milhouse --exec --task-id T-xxx
 * ```
 */

// Re-export from the original exec command
// The original command already uses Milhouse branding
export {
	runExec,
	buildExecutorPrompt,
	getReadyTasks,
	type ExecResult,
} from "../exec.ts";
