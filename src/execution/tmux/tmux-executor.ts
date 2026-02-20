/**
 * Shared Tmux Executor Module
 *
 * Extracts tmux session lifecycle management from issue-executor into
 * a shared module. Wraps engines/tmux primitives with execution-specific
 * setup/teardown logic used by the exec phase.
 *
 * The exec phase creates tmux sessions for each parallel agent so users
 * can observe execution in real-time. This module centralises:
 * - Tmux availability checks and installation
 * - Session creation for issue execution
 * - Graceful cleanup of servers and sessions
 * - Signal handler registration for SIGINT/SIGTERM
 *
 * @module execution/tmux/tmux-executor
 * @since 0.2.0
 */

import {
	OpencodeServerExecutor,
	PortManager,
	type ServerInfo,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	displayTmuxModeHeader,
	getMessageOptionsForPhase,
} from "../../engines/opencode/index.ts";
import {
	TmuxSessionManager,
	ensureTmuxInstalled,
	getInstallationInstructions,
} from "../../engines/tmux/index.ts";
import { logDebug, logInfo, logSuccess, logWarn } from "../../ui/logger.ts";
import type { IssueGroup } from "../issue-executor.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for initialising tmux mode in execution
 */
export interface TmuxModeOptions {
	/** Prefix for tmux session names (default: "milhouse") */
	sessionPrefix?: string;
	/** Show attach command in output */
	showAttachCommand?: boolean;
	/** Automatically attach to tmux session */
	autoAttach?: boolean;
}

/**
 * Information about a running OpenCode server for tmux mode.
 *
 * Tracks everything needed to observe and clean up a single
 * agent's tmux session + OpenCode server pair.
 */
export interface TmuxServerInfo {
	/** Issue ID */
	issueId: string;
	/** Server port */
	port: number;
	/** Server URL */
	url: string;
	/** Tmux session name */
	tmuxSession: string;
	/** Attach command */
	attachCommand: string;
	/** OpenCode server executor */
	executor: OpencodeServerExecutor;
}

/**
 * Result of tmux mode initialisation
 */
export interface TmuxModeInit {
	/** Whether tmux mode is available and ready */
	available: boolean;
	/** The tmux session manager (null if not available) */
	manager: TmuxSessionManager | null;
}

/**
 * Result of executing an issue in tmux mode
 */
export interface TmuxExecResult {
	/** Whether execution succeeded */
	success: boolean;
	/** Input tokens consumed */
	inputTokens: number;
	/** Output tokens consumed */
	outputTokens: number;
	/** Server info for cleanup */
	serverInfo: TmuxServerInfo;
	/** Error message if failed */
	error?: string;
}

// ============================================================================
// Initialisation
// ============================================================================

/**
 * Initialise tmux mode: check availability, install if needed, create manager.
 *
 * Returns a TmuxModeInit with `available: false` if tmux cannot be used
 * (e.g. Windows, missing package manager). Callers should fall back to
 * standard execution in that case.
 *
 * @param options - Tmux mode configuration
 * @returns Init result with manager (or null)
 */
export async function initTmuxMode(options: TmuxModeOptions = {}): Promise<TmuxModeInit> {
	const tmuxResult = await ensureTmuxInstalled({ autoInstall: true, verbose: true });

	if (!tmuxResult.installed) {
		logWarn("tmux is not available and could not be installed automatically.");
		if (tmuxResult.error) {
			logInfo(tmuxResult.error);
		}
		logInfo("Falling back to standard execution.");
		logInfo("");
		logInfo(getInstallationInstructions());
		return { available: false, manager: null };
	}

	if (tmuxResult.installedNow) {
		logSuccess(
			`tmux ${tmuxResult.version ?? "unknown"} was installed successfully via ${tmuxResult.method}`,
		);
	} else {
		logDebug(`tmux ${tmuxResult.version ?? "unknown"} is already installed`);
	}

	const manager = new TmuxSessionManager({
		sessionPrefix: options.sessionPrefix ?? "milhouse",
		verbose: false,
	});

	logInfo("Tmux mode enabled - OpenCode servers will be started with TUI attachment");
	return { available: true, manager };
}

/**
 * Check whether tmux is available on this system.
 *
 * Thin wrapper over engines/tmux for use by callers that only need
 * an availability check without full initialisation.
 */
export async function isTmuxAvailable(): Promise<boolean> {
	const manager = new TmuxSessionManager();
	return manager.isTmuxAvailable();
}

// ============================================================================
// Display helpers
// ============================================================================

/**
 * Convert TmuxServerInfo to the UI-layer ServerInfo for display
 */
export function toServerInfo(
	server: TmuxServerInfo,
	status: ServerInfo["status"] = "running",
): ServerInfo {
	return {
		issueId: server.issueId,
		port: server.port,
		sessionName: server.tmuxSession,
		status,
		url: server.url,
	};
}

/**
 * Display tmux mode header before execution starts.
 */
export function showTmuxHeader(): void {
	displayTmuxModeHeader();
	logInfo("  Servers will be started for each issue. Attach commands will be shown below.");
	console.log("");
}

/**
 * Display attach instructions for all running servers
 */
export function showAttachInstructions(servers: TmuxServerInfo[]): void {
	const serverInfos: ServerInfo[] = servers.map((s) => toServerInfo(s, "running"));
	displayAttachInstructions(serverInfos);
}

/**
 * Display completion summary for all servers
 */
export function showCompletionSummary(
	servers: TmuxServerInfo[],
	getStatus: (server: TmuxServerInfo) => ServerInfo["status"],
): void {
	const serverInfos: ServerInfo[] = servers.map((server) =>
		toServerInfo(server, getStatus(server)),
	);
	displayTmuxCompletionSummary(serverInfos);
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute an issue using tmux mode with OpenCode server.
 *
 * This function:
 * 1. Starts an OpenCode server for the issue
 * 2. Creates a tmux session with `opencode attach` command
 * 3. Sends the prompt via the Server API
 * 4. Waits for completion
 * 5. Returns the result (with server info for later cleanup)
 *
 * @param issueGroup - The issue to execute
 * @param worktreeDir - Working directory (worktree) for this agent
 * @param prompt - The full prompt to send
 * @param tmuxManager - The tmux session manager
 * @param options - Execution options
 * @returns Execution result with token counts and server info
 */
export async function executeIssueTmuxMode(
	issueGroup: IssueGroup,
	worktreeDir: string,
	prompt: string,
	tmuxManager: TmuxSessionManager,
	options: {
		showAttachCommand?: boolean;
		modelOverride?: string;
	},
): Promise<TmuxExecResult> {
	const executor = new OpencodeServerExecutor({
		autoInstall: true,
		verbose: false,
	});

	let serverInfo: TmuxServerInfo | null = null;

	try {
		// Start the OpenCode server
		const port = await executor.startServer(worktreeDir);
		const url = `http://localhost:${port}`;

		// Create the session FIRST via the API so we have the session ID
		const session = await executor.createSession({
			title: `Milhouse: ${issueGroup.issueId}`,
		});

		// Create tmux session with opencode attach
		const sessionName = tmuxManager.buildSessionName(issueGroup.issueId);
		const attachCmd = `opencode attach ${url} -s ${session.id}`;

		// Kill any existing session with the same name before creating a new one
		await tmuxManager.killSessionIfExists(issueGroup.issueId);

		const tmuxResult = await tmuxManager.createSession({
			name: issueGroup.issueId,
			command: attachCmd,
			workDir: worktreeDir,
		});

		if (!tmuxResult.success) {
			logWarn(`Failed to create tmux session: ${tmuxResult.error}`);
		}

		serverInfo = {
			issueId: issueGroup.issueId,
			port,
			url,
			tmuxSession: sessionName,
			attachCommand: tmuxManager.getAttachCommand(sessionName),
			executor,
		};

		// Show attach instructions if requested
		if (options.showAttachCommand) {
			logInfo(`  Issue ${issueGroup.issueId}: ${url}`);
			logInfo(`    Attach: opencode attach ${url} -s ${session.id}`);
			logInfo(`    Tmux:   ${serverInfo.attachCommand}`);
		}

		// Send the prompt and wait for completion
		const response = await executor.sendMessage(
			session.id,
			prompt,
			getMessageOptionsForPhase("exec", options.modelOverride),
		);

		const inputTokens = response.info.inputTokens ?? 0;
		const outputTokens = response.info.outputTokens ?? 0;

		return {
			success: true,
			inputTokens,
			outputTokens,
			serverInfo,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			inputTokens: 0,
			outputTokens: 0,
			serverInfo: serverInfo ?? {
				issueId: issueGroup.issueId,
				port: 0,
				url: "",
				tmuxSession: "",
				attachCommand: "",
				executor,
			},
			error: errorMessage,
		};
	}
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup tmux mode resources (servers and sessions).
 *
 * Stops all OpenCode servers and optionally kills the tmux sessions.
 * By default sessions are preserved so users can still attach and inspect.
 *
 * @param servers - Server info array to clean up
 * @param tmuxManager - The tmux session manager
 * @param killSessions - Whether to also kill the tmux sessions (default: false)
 */
export async function cleanupTmuxResources(
	servers: TmuxServerInfo[],
	tmuxManager: TmuxSessionManager,
	killSessions = false,
): Promise<void> {
	for (const server of servers) {
		try {
			await server.executor.stopServer();
			logDebug(`Stopped OpenCode server for ${server.issueId}`);
		} catch (error) {
			logWarn(`Failed to stop server for ${server.issueId}: ${error}`);
		}

		if (killSessions) {
			try {
				await tmuxManager.killSession(server.issueId);
				logDebug(`Killed tmux session for ${server.issueId}`);
			} catch (error) {
				logWarn(`Failed to kill tmux session for ${server.issueId}: ${error}`);
			}
		}
	}

	// Release all ports
	PortManager.releaseAllPorts();
}

// ============================================================================
// Signal Handlers
// ============================================================================

/**
 * Register SIGINT/SIGTERM handlers for graceful tmux cleanup.
 *
 * Returns the handler references so the caller can remove them later
 * with `removeSignalHandlers`.
 *
 * @param servers - Mutable array — the handlers read it at signal time
 * @param tmuxManager - The tmux session manager
 * @returns Handler functions to pass to removeSignalHandlers
 */
export function registerSignalHandlers(
	servers: TmuxServerInfo[],
	tmuxManager: TmuxSessionManager,
): { onSigInt: () => Promise<void>; onSigTerm: () => Promise<void> } {
	const cleanup = async () => {
		if (servers.length > 0) {
			logInfo("\nCleaning up tmux resources...");
			await cleanupTmuxResources(servers, tmuxManager, true);
		}
	};

	const onSigInt = async () => {
		await cleanup();
		process.exit(130);
	};
	const onSigTerm = async () => {
		await cleanup();
		process.exit(143);
	};

	process.on("SIGINT", onSigInt);
	process.on("SIGTERM", onSigTerm);

	return { onSigInt, onSigTerm };
}

/**
 * Remove previously registered signal handlers.
 *
 * @param handlers - The handler references returned by registerSignalHandlers
 */
export function removeSignalHandlers(handlers: {
	onSigInt: () => Promise<void>;
	onSigTerm: () => Promise<void>;
}): void {
	process.off("SIGINT", handlers.onSigInt);
	process.off("SIGTERM", handlers.onSigTerm);
}
