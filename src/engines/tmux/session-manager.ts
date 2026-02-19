/**
 * Tmux Session Manager
 *
 * Manages tmux sessions for OpenCode server observation in milhouse.
 * Provides methods to create, manage, and interact with tmux sessions.
 *
 * @module engines/tmux/session-manager
 * @since 1.0.0
 */

import { logger } from "../../observability/logger";
import {
	DEFAULT_TMUX_CONFIG,
	TmuxError,
	TmuxErrorCodes,
	type CreateSessionOptions,
	type CreateSessionResult,
	type CreateWindowOptions,
	type SendKeysOptions,
	type SplitWindowOptions,
	type TmuxConfig,
	type TmuxPane,
	type TmuxResult,
	type TmuxSession,
	type TmuxWindow,
} from "./types";
import { ensureTmuxInstalled, getInstallationInstructions, type TmuxInstallerOptions } from "./installer";

// ============================================================================
// TmuxSessionManager Class
// ============================================================================

/**
 * Manages tmux sessions for OpenCode server observation.
 *
 * This class provides methods to:
 * - Create and manage tmux sessions
 * - Create windows and panes
 * - Send keys to panes
 * - List and query sessions
 *
 * @example
 * ```typescript
 * const manager = new TmuxSessionManager({ sessionPrefix: 'milhouse' });
 *
 * // Check if tmux is available
 * if (await manager.isTmuxAvailable()) {
 *   // Create a session with opencode attach
 *   const result = await manager.createSession({
 *     name: 'issue-001',
 *     command: 'opencode attach http://localhost:4096',
 *   });
 *
 *   console.log(`Attach: ${result.attachCommand}`);
 * }
 * ```
 */
export class TmuxSessionManager {
	private config: Required<Omit<TmuxConfig, "defaultWorkDir">> &
		Pick<TmuxConfig, "defaultWorkDir">;

	/**
	 * Create a new TmuxSessionManager.
	 *
	 * @param config - Configuration options
	 */
	constructor(config: TmuxConfig = {}) {
		this.config = {
			...DEFAULT_TMUX_CONFIG,
			...config,
		};
	}

	// ============================================================================
	// Availability Check
	// ============================================================================

	/**
	 * Check if tmux is available on the system.
	 *
	 * @returns true if tmux is installed and accessible
	 *
	 * @example
	 * ```typescript
	 * if (await manager.isTmuxAvailable()) {
	 *   console.log('tmux is available');
	 * }
	 * ```
	 */
	async isTmuxAvailable(): Promise<boolean> {
		try {
			const result = await this.runTmuxCommand(["-V"]);
			return result.success;
		} catch {
			return false;
		}
	}

	/**
	 * Get the tmux version.
	 *
	 * @returns The tmux version string, or null if not available
	 */
	async getTmuxVersion(): Promise<string | null> {
		try {
			const result = await this.runTmuxCommand(["-V"]);
			if (result.success && result.data) {
				// Parse version from output like "tmux 3.4"
				const match = result.data.match(/tmux\s+(\d+\.\d+[a-z]?)/i);
				return match ? match[1] : result.data.trim();
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Ensure tmux is installed, optionally installing it automatically.
	 *
	 * This method uses the TmuxInstaller to check if tmux is available
	 * and optionally install it if not found.
	 *
	 * @param options - Installation options
	 * @returns Object with installation status and version
	 *
	 * @example
	 * ```typescript
	 * const manager = new TmuxSessionManager();
	 * const result = await manager.ensureInstalled({ autoInstall: true, verbose: true });
	 *
	 * if (result.installed) {
	 *   console.log(`tmux ${result.version} is ready`);
	 *   // Now safe to create sessions
	 *   await manager.createSession({ name: 'my-session', command: '...' });
	 * } else {
	 *   console.error('tmux not available:', result.error);
	 * }
	 * ```
	 */
	async ensureInstalled(options: TmuxInstallerOptions = {}): Promise<{
		installed: boolean;
		version: string | null;
		installedNow: boolean;
		method?: string;
		error?: string;
	}> {
		// Merge options with manager's verbose setting
		const installerOptions: TmuxInstallerOptions = {
			verbose: this.config.verbose,
			...options,
		};

		return ensureTmuxInstalled(installerOptions);
	}

	// ============================================================================
	// Session Lifecycle
	// ============================================================================

	/**
	 * Create a new tmux session.
	 *
	 * @param options - Session creation options
	 * @returns Result with session information
	 *
	 * @example
	 * ```typescript
	 * const result = await manager.createSession({
	 *   name: 'issue-001',
	 *   command: 'opencode attach http://localhost:4096',
	 *   workDir: '/path/to/project',
	 * });
	 *
	 * if (result.success) {
	 *   console.log(`Session created: ${result.data.sessionName}`);
	 *   console.log(`Attach: ${result.data.attachCommand}`);
	 * }
	 * ```
	 */
	async createSession(options: CreateSessionOptions): Promise<TmuxResult<CreateSessionResult>> {
		const sessionName = this.buildSessionName(options.name);

		// Check if session already exists
		if (await this.sessionExists(sessionName)) {
			return {
				success: false,
				error: `Session '${sessionName}' already exists`,
				exitCode: 1,
			};
		}

		// Build the command arguments
		const args = ["new-session", "-d", "-s", sessionName];

		// Add window name if specified
		if (options.windowName) {
			args.push("-n", options.windowName);
		}

		// Add working directory
		const workDir = options.workDir ?? this.config.defaultWorkDir;
		if (workDir) {
			args.push("-c", workDir);
		}

		// Add the command to run
		if (options.command) {
			args.push(options.command);
		}

		// Set environment variables
		const env = options.env ? { ...process.env, ...options.env } : undefined;

		// Create the session
		const result = await this.runTmuxCommand(args, env);

		if (!result.success) {
			return {
				success: false,
				error: result.error ?? "Failed to create session",
				exitCode: result.exitCode,
			};
		}

		// Get the session ID
		const sessionId = await this.getSessionId(sessionName);

		this.log(`Created tmux session: ${sessionName}`);

		return {
			success: true,
			data: {
				sessionName,
				sessionId: sessionId ?? sessionName,
				attachCommand: this.getAttachCommand(sessionName),
			},
		};
	}

	/**
	 * Kill (destroy) a tmux session.
	 *
	 * @param name - Session name (without prefix)
	 * @returns Result of the operation
	 *
	 * @example
	 * ```typescript
	 * await manager.killSession('issue-001');
	 * ```
	 */
	async killSession(name: string): Promise<TmuxResult<string>> {
		const sessionName = this.buildSessionName(name);

		// Check if session exists
		if (!(await this.sessionExists(sessionName))) {
			return {
				success: false,
				error: `Session '${sessionName}' does not exist`,
				exitCode: 1,
			};
		}

		const result = await this.runTmuxCommand(["kill-session", "-t", sessionName]);

		if (result.success) {
			this.log(`Killed tmux session: ${sessionName}`);
		}

		return result;
	}

	/**
	 * Kill a tmux session if it exists, otherwise do nothing.
	 *
	 * This is useful for cleanup before creating a new session with the same name,
	 * especially during retry scenarios where old sessions may still exist.
	 *
	 * @param name - Session name (without prefix)
	 * @returns Result of the operation (success is true even if session didn't exist)
	 *
	 * @example
	 * ```typescript
	 * // Clean up before creating a new session
	 * await manager.killSessionIfExists('issue-001');
	 * await manager.createSession({ name: 'issue-001', command: '...' });
	 * ```
	 */
	async killSessionIfExists(name: string): Promise<TmuxResult<string>> {
		const sessionName = this.buildSessionName(name);

		// Check if session exists
		if (!(await this.sessionExists(sessionName))) {
			// Session doesn't exist, that's fine
			return {
				success: true,
				data: `Session '${sessionName}' does not exist, nothing to kill`,
				exitCode: 0,
			};
		}

		const result = await this.runTmuxCommand(["kill-session", "-t", sessionName]);

		if (result.success) {
			this.log(`Killed existing tmux session: ${sessionName}`);
		}

		return result;
	}

	/**
	 * List all tmux sessions.
	 *
	 * @param filterPrefix - If true, only return sessions with the configured prefix
	 * @returns Array of session information
	 *
	 * @example
	 * ```typescript
	 * const sessions = await manager.listSessions(true);
	 * for (const session of sessions) {
	 *   console.log(`${session.name}: ${session.windows} windows`);
	 * }
	 * ```
	 */
	async listSessions(filterPrefix = false): Promise<TmuxSession[]> {
		const format = "#{session_name}|#{session_id}|#{session_windows}|#{session_attached}|#{session_created}|#{session_width}|#{session_height}";
		const result = await this.runTmuxCommand(["list-sessions", "-F", format]);

		if (!result.success || !result.data) {
			return [];
		}

		const sessions: TmuxSession[] = [];
		const lines = result.data.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [name, id, windows, attached, created, width, height] = line.split("|");

			// Filter by prefix if requested
			if (filterPrefix && !name.startsWith(this.config.sessionPrefix)) {
				continue;
			}

			sessions.push({
				name,
				id,
				windows: Number.parseInt(windows, 10) || 0,
				attached: attached === "1",
				created: new Date(Number.parseInt(created, 10) * 1000),
				width: width ? Number.parseInt(width, 10) : undefined,
				height: height ? Number.parseInt(height, 10) : undefined,
			});
		}

		return sessions;
	}

	/**
	 * Check if a session exists.
	 *
	 * @param name - Session name (with or without prefix)
	 * @returns true if the session exists
	 */
	async sessionExists(name: string): Promise<boolean> {
		const result = await this.runTmuxCommand(["has-session", "-t", name]);
		return result.success;
	}

	// ============================================================================
	// Window Management
	// ============================================================================

	/**
	 * Create a new window in a session.
	 *
	 * @param options - Window creation options
	 * @returns Result of the operation
	 *
	 * @example
	 * ```typescript
	 * await manager.createWindow({
	 *   session: 'milhouse-issue-001',
	 *   name: 'logs',
	 *   command: 'tail -f /var/log/app.log',
	 * });
	 * ```
	 */
	async createWindow(options: CreateWindowOptions): Promise<TmuxResult<string>> {
		const args = ["new-window", "-t", options.session, "-n", options.name];

		if (options.workDir) {
			args.push("-c", options.workDir);
		}

		if (options.command) {
			args.push(options.command);
		}

		const result = await this.runTmuxCommand(args);

		if (result.success) {
			this.log(`Created window '${options.name}' in session '${options.session}'`);
		}

		return result;
	}

	/**
	 * Split a window to create a new pane.
	 *
	 * @param options - Split options
	 * @returns Result of the operation
	 *
	 * @example
	 * ```typescript
	 * await manager.splitWindow({
	 *   session: 'milhouse-issue-001',
	 *   direction: 'h',
	 *   command: 'htop',
	 * });
	 * ```
	 */
	async splitWindow(options: SplitWindowOptions): Promise<TmuxResult<string>> {
		const args = ["split-window"];

		// Add direction flag
		args.push(options.direction === "h" ? "-h" : "-v");

		// Add target
		const target = options.target ?? options.session;
		args.push("-t", target);

		// Add percentage if specified
		if (options.percentage) {
			args.push("-p", String(options.percentage));
		}

		// Add command if specified
		if (options.command) {
			args.push(options.command);
		}

		const result = await this.runTmuxCommand(args);

		if (result.success) {
			this.log(`Split window in session '${options.session}'`);
		}

		return result;
	}

	/**
	 * List windows in a session.
	 *
	 * @param session - Session name
	 * @returns Array of window information
	 */
	async listWindows(session: string): Promise<TmuxWindow[]> {
		const format = "#{window_name}|#{window_index}|#{window_active}|#{window_panes}|#{window_layout}";
		const result = await this.runTmuxCommand(["list-windows", "-t", session, "-F", format]);

		if (!result.success || !result.data) {
			return [];
		}

		const windows: TmuxWindow[] = [];
		const lines = result.data.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [name, index, active, panes, layout] = line.split("|");
			windows.push({
				name,
				index: Number.parseInt(index, 10) || 0,
				active: active === "1",
				panes: Number.parseInt(panes, 10) || 0,
				layout,
			});
		}

		return windows;
	}

	/**
	 * List panes in a window.
	 *
	 * @param session - Session name
	 * @param windowIndex - Window index (optional, defaults to current)
	 * @returns Array of pane information
	 */
	async listPanes(session: string, windowIndex?: number): Promise<TmuxPane[]> {
		const target = windowIndex !== undefined ? `${session}:${windowIndex}` : session;
		const format = "#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_current_path}|#{pane_current_command}";
		const result = await this.runTmuxCommand(["list-panes", "-t", target, "-F", format]);

		if (!result.success || !result.data) {
			return [];
		}

		const panes: TmuxPane[] = [];
		const lines = result.data.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [index, active, width, height, cwd, command] = line.split("|");
			panes.push({
				index: Number.parseInt(index, 10) || 0,
				active: active === "1",
				width: Number.parseInt(width, 10) || 0,
				height: Number.parseInt(height, 10) || 0,
				cwd: cwd || undefined,
				command: command || undefined,
			});
		}

		return panes;
	}

	// ============================================================================
	// Interaction
	// ============================================================================

	/**
	 * Send keys to a tmux pane.
	 *
	 * @param options - Send keys options
	 * @returns Result of the operation
	 *
	 * @example
	 * ```typescript
	 * // Send a command
	 * await manager.sendKeys({
	 *   session: 'milhouse-issue-001',
	 *   keys: 'ls -la',
	 * });
	 *
	 * // Send Enter key
	 * await manager.sendKeys({
	 *   session: 'milhouse-issue-001',
	 *   keys: 'Enter',
	 * });
	 * ```
	 */
	async sendKeys(options: SendKeysOptions): Promise<TmuxResult<string>> {
		const args = ["send-keys"];

		// Add target
		const target = options.target ?? options.session;
		args.push("-t", target);

		// Add literal flag if specified
		if (options.literal) {
			args.push("-l");
		}

		// Add the keys
		args.push(options.keys);

		return this.runTmuxCommand(args);
	}

	/**
	 * Attach to a tmux session.
	 *
	 * Note: This will replace the current process with tmux attach.
	 * Use getAttachCommand() to get the command string instead.
	 *
	 * @param name - Session name (without prefix)
	 * @returns Result of the operation
	 */
	async attachSession(name: string): Promise<TmuxResult<string>> {
		const sessionName = this.buildSessionName(name);

		// Check if session exists
		if (!(await this.sessionExists(sessionName))) {
			return {
				success: false,
				error: `Session '${sessionName}' does not exist`,
				exitCode: 1,
			};
		}

		// Note: This will replace the current process
		const result = await this.runTmuxCommand(["attach-session", "-t", sessionName]);
		return result;
	}

	/**
	 * Get the command to attach to a session.
	 *
	 * @param sessionName - Full session name (with prefix)
	 * @returns The tmux attach command
	 *
	 * @example
	 * ```typescript
	 * const cmd = manager.getAttachCommand('milhouse-issue-001');
	 * console.log(`Run: ${cmd}`);
	 * // Output: "tmux attach -t milhouse-issue-001"
	 * ```
	 */
	getAttachCommand(sessionName: string): string {
		return `tmux attach -t ${sessionName}`;
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

	/**
	 * Build a session name with the configured prefix.
	 *
	 * @param name - Base session name
	 * @returns Full session name with prefix
	 */
	buildSessionName(name: string): string {
		// If name already has the prefix, return as-is
		if (name.startsWith(`${this.config.sessionPrefix}-`)) {
			return name;
		}
		return `${this.config.sessionPrefix}-${name}`;
	}

	/**
	 * Get the session ID for a session name.
	 *
	 * @param sessionName - Session name
	 * @returns Session ID or null if not found
	 */
	private async getSessionId(sessionName: string): Promise<string | null> {
		const result = await this.runTmuxCommand([
			"display-message",
			"-t",
			sessionName,
			"-p",
			"#{session_id}",
		]);

		if (result.success && result.data) {
			return result.data.trim();
		}

		return null;
	}

	/**
	 * Kill all sessions with the configured prefix.
	 *
	 * @returns Number of sessions killed
	 */
	async killAllPrefixedSessions(): Promise<number> {
		const sessions = await this.listSessions(true);
		let killed = 0;

		for (const session of sessions) {
			const result = await this.runTmuxCommand(["kill-session", "-t", session.name]);
			if (result.success) {
				killed++;
				this.log(`Killed session: ${session.name}`);
			}
		}

		return killed;
	}

	// ============================================================================
	// Private Methods
	// ============================================================================

	/**
	 * Run a tmux command.
	 *
	 * @param args - Command arguments
	 * @param env - Optional environment variables
	 * @returns Result of the command
	 */
	private async runTmuxCommand(
		args: string[],
		env?: Record<string, string | undefined>,
	): Promise<TmuxResult<string>> {
		try {
			// Filter out undefined values from env
			const cleanEnv: Record<string, string> = {};
			if (env) {
				for (const [key, value] of Object.entries(env)) {
					if (value !== undefined) {
						cleanEnv[key] = value;
					}
				}
			}

			const proc = Bun.spawn(["tmux", ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: env ? cleanEnv : undefined,
			});

			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();

			if (exitCode === 0) {
				return {
					success: true,
					data: stdout,
					exitCode,
				};
			}

			return {
				success: false,
				error: stderr.trim() || `tmux command failed with exit code ${exitCode}`,
				exitCode,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			// Check if tmux is not installed
			if (message.includes("ENOENT") || message.includes("not found")) {
				return {
					success: false,
					error: "tmux is not installed",
					exitCode: 127,
				};
			}

			return {
				success: false,
				error: message,
				exitCode: 1,
			};
		}
	}

	/**
	 * Log a message if verbose mode is enabled.
	 */
	private log(message: string): void {
		if (this.config.verbose) {
			logger.info(`[Tmux] ${message}`);
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new TmuxSessionManager with default configuration.
 *
 * @param config - Optional configuration overrides
 * @returns A new TmuxSessionManager instance
 *
 * @example
 * ```typescript
 * const manager = createTmuxManager({ sessionPrefix: 'milhouse' });
 * ```
 */
export function createTmuxManager(config?: TmuxConfig): TmuxSessionManager {
	return new TmuxSessionManager(config);
}

/**
 * Check if tmux is available on the system.
 *
 * Convenience function that doesn't require creating a manager instance.
 *
 * @returns true if tmux is installed and accessible
 */
export async function isTmuxAvailable(): Promise<boolean> {
	const manager = new TmuxSessionManager();
	return manager.isTmuxAvailable();
}
