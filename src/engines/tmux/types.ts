/**
 * Tmux Session Management Types
 *
 * TypeScript interfaces for tmux session management in milhouse.
 * Used for creating and managing tmux sessions for OpenCode server observation.
 *
 * @module engines/tmux/types
 * @since 1.0.0
 */

// ============================================================================
// Session Types
// ============================================================================

/**
 * Represents a tmux session.
 */
export interface TmuxSession {
	/** Session name */
	name: string;
	/** Session ID (e.g., "$0", "$1") */
	id: string;
	/** Number of windows in the session */
	windows: number;
	/** Whether a client is attached to the session */
	attached: boolean;
	/** When the session was created */
	created: Date;
	/** Session width in characters */
	width?: number;
	/** Session height in characters */
	height?: number;
}

/**
 * Represents a tmux window within a session.
 */
export interface TmuxWindow {
	/** Window name */
	name: string;
	/** Window index (0-based) */
	index: number;
	/** Whether this is the active window */
	active: boolean;
	/** Number of panes in the window */
	panes: number;
	/** Window layout (e.g., "main-horizontal", "tiled") */
	layout?: string;
}

/**
 * Represents a tmux pane within a window.
 */
export interface TmuxPane {
	/** Pane index (0-based) */
	index: number;
	/** Whether this is the active pane */
	active: boolean;
	/** Pane width in characters */
	width: number;
	/** Pane height in characters */
	height: number;
	/** Current working directory of the pane */
	cwd?: string;
	/** Command running in the pane */
	command?: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration options for the TmuxSessionManager.
 */
export interface TmuxConfig {
	/**
	 * Prefix for session names.
	 * @default "milhouse"
	 */
	sessionPrefix?: string;

	/**
	 * Whether to automatically attach to created sessions.
	 * @default false
	 */
	autoAttach?: boolean;

	/**
	 * Default split layout for windows.
	 * @default "horizontal"
	 */
	splitLayout?: "horizontal" | "vertical" | "tiled";

	/**
	 * Default working directory for new sessions.
	 */
	defaultWorkDir?: string;

	/**
	 * Whether to enable verbose logging.
	 * @default false
	 */
	verbose?: boolean;
}

/**
 * Default configuration values.
 */
export const DEFAULT_TMUX_CONFIG: Required<Omit<TmuxConfig, "defaultWorkDir">> = {
	sessionPrefix: "milhouse",
	autoAttach: false,
	splitLayout: "horizontal",
	verbose: false,
};

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of a tmux operation.
 */
export interface TmuxResult<T = void> {
	/** Whether the operation succeeded */
	success: boolean;
	/** Result data (if successful) */
	data?: T;
	/** Error message (if failed) */
	error?: string;
	/** Exit code from tmux command */
	exitCode?: number;
}

/**
 * Result of creating a session.
 */
export interface CreateSessionResult {
	/** Session name */
	sessionName: string;
	/** Session ID */
	sessionId: string;
	/** Command to attach to the session */
	attachCommand: string;
}

// ============================================================================
// Command Types
// ============================================================================

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
	/** Session name (will be prefixed with sessionPrefix) */
	name: string;
	/** Initial command to run in the session */
	command?: string;
	/** Working directory for the session */
	workDir?: string;
	/** Window name */
	windowName?: string;
	/** Whether to detach after creation */
	detached?: boolean;
	/** Environment variables to set */
	env?: Record<string, string>;
}

/**
 * Options for creating a new window.
 */
export interface CreateWindowOptions {
	/** Session name */
	session: string;
	/** Window name */
	name: string;
	/** Command to run in the window */
	command?: string;
	/** Working directory */
	workDir?: string;
}

/**
 * Options for splitting a window.
 */
export interface SplitWindowOptions {
	/** Session name */
	session: string;
	/** Split direction */
	direction: "h" | "v";
	/** Command to run in the new pane */
	command?: string;
	/** Target pane (default: current) */
	target?: string;
	/** Percentage size of the new pane */
	percentage?: number;
}

/**
 * Options for sending keys to a pane.
 */
export interface SendKeysOptions {
	/** Session name */
	session: string;
	/** Keys to send */
	keys: string;
	/** Target pane (default: current) */
	target?: string;
	/** Whether to send keys literally (no special key parsing) */
	literal?: boolean;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown by tmux operations.
 */
export class TmuxError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly exitCode?: number,
		public readonly stderr?: string,
	) {
		super(message);
		this.name = "TmuxError";
	}
}

/**
 * Error codes for tmux operations.
 */
export const TmuxErrorCodes = {
	/** tmux is not installed */
	NOT_INSTALLED: "TMUX_NOT_INSTALLED",
	/** Session already exists */
	SESSION_EXISTS: "SESSION_EXISTS",
	/** Session not found */
	SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
	/** Window not found */
	WINDOW_NOT_FOUND: "WINDOW_NOT_FOUND",
	/** Pane not found */
	PANE_NOT_FOUND: "PANE_NOT_FOUND",
	/** Command execution failed */
	COMMAND_FAILED: "COMMAND_FAILED",
	/** Invalid session name */
	INVALID_NAME: "INVALID_NAME",
} as const;

export type TmuxErrorCode = (typeof TmuxErrorCodes)[keyof typeof TmuxErrorCodes];
