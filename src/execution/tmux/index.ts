/**
 * Execution Tmux Module
 *
 * Shared tmux session lifecycle for the exec phase.
 * Wraps engines/tmux primitives with execution-specific logic.
 *
 * @module execution/tmux
 * @since 0.2.0
 */

export {
	// Types
	type TmuxModeOptions,
	type TmuxServerInfo,
	type TmuxModeInit,
	type TmuxExecResult,
	// Initialisation
	initTmuxMode,
	isTmuxAvailable,
	// Display helpers
	toServerInfo,
	showTmuxHeader,
	showAttachInstructions,
	showCompletionSummary,
	// Execution
	executeIssueTmuxMode,
	// Cleanup
	cleanupTmuxResources,
	// Signal handlers
	registerSignalHandlers,
	removeSignalHandlers,
} from "./tmux-executor.ts";
