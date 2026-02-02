/**
 * Tmux Session Management Module
 *
 * This module provides tmux session management for milhouse,
 * enabling interactive observation of OpenCode server execution.
 *
 * @module engines/tmux
 * @since 1.0.0
 */

// ============================================================================
// Types
// ============================================================================

export type {
	// Session types
	TmuxSession,
	TmuxWindow,
	TmuxPane,
	// Configuration types
	TmuxConfig,
	// Result types
	TmuxResult,
	CreateSessionResult,
	// Options types
	CreateSessionOptions,
	CreateWindowOptions,
	SplitWindowOptions,
	SendKeysOptions,
	// Error types
	TmuxErrorCode,
} from "./types";

export {
	DEFAULT_TMUX_CONFIG,
	TmuxError,
	TmuxErrorCodes,
} from "./types";

// ============================================================================
// Session Manager
// ============================================================================

export {
	TmuxSessionManager,
	createTmuxManager,
	isTmuxAvailable,
} from "./session-manager";

// ============================================================================
// Installer
// ============================================================================

export type {
	TmuxInstallMethod,
	TmuxInstallResult,
	TmuxInstallerOptions,
	LinuxDistro,
	LinuxDistroInfo,
} from "./installer";

export {
	TmuxInstaller,
	ensureTmuxInstalled,
	getInstallationInstructions,
} from "./installer";
