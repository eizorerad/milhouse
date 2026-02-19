/**
 * Attach Instructions Display Module
 *
 * Provides formatted output for tmux mode attach instructions.
 * Shows server URLs, attach commands, and tmux session information.
 *
 * @module engines/opencode/ui/attach-instructions
 * @since 1.0.0
 */

import pc from "picocolors";

// ============================================================================
// Types
// ============================================================================

/**
 * Information about a running OpenCode server
 */
export interface ServerInfo {
	/** Issue ID being processed */
	issueId: string;
	/** Port the server is running on */
	port: number;
	/** Tmux session name */
	sessionName: string;
	/** Current status of the server */
	status: "starting" | "running" | "completed" | "error";
	/** Server URL (computed from port) */
	url?: string;
	/** Error message if status is 'error' */
	error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Box drawing characters for UI
 */
const BOX = {
	topLeft: "╔",
	topRight: "╗",
	bottomLeft: "╚",
	bottomRight: "╝",
	horizontal: "═",
	vertical: "║",
	teeRight: "├",
	teeLeft: "┤",
	teeDown: "┬",
	teeUp: "┴",
	cross: "┼",
	lightHorizontal: "─",
	lightVertical: "│",
	lightTopLeft: "┌",
	lightTopRight: "┐",
	lightBottomLeft: "└",
	lightBottomRight: "┘",
} as const;

/**
 * Default header width for the tmux mode banner
 */
const HEADER_WIDTH = 79;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if terminal supports colors
 */
function supportsColor(): boolean {
	return process.stdout.isTTY ?? false;
}

/**
 * Get terminal width or default
 */
function getTerminalWidth(): number {
	return process.stdout.columns ?? 80;
}

/**
 * Create a horizontal line with specified character
 */
function horizontalLine(char: string, width: number): string {
	return char.repeat(width);
}

/**
 * Center text within a given width
 */
function centerText(text: string, width: number): string {
	const textLength = text.replace(/\x1b\[[0-9;]*m/g, "").length; // Strip ANSI codes for length
	const padding = Math.max(0, Math.floor((width - textLength) / 2));
	return " ".repeat(padding) + text;
}

/**
 * Get server URL from port
 */
function getServerUrl(port: number): string {
	return `http://localhost:${port}`;
}

// ============================================================================
// Display Functions
// ============================================================================

/**
 * Display the tmux mode header banner
 *
 * Shows a prominent banner indicating tmux mode is enabled.
 *
 * @example
 * ```typescript
 * displayTmuxModeHeader();
 * // Output:
 * // ╔═══════════════════════════════════════════════════════════════════════════════╗
 * // ║                         TMUX MODE ENABLED                                      ║
 * // ╚═══════════════════════════════════════════════════════════════════════════════╝
 * ```
 */
export function displayTmuxModeHeader(): void {
	const width = Math.min(getTerminalWidth() - 2, HEADER_WIDTH);
	const innerWidth = width - 2;

	const title = "TMUX MODE ENABLED";
	const coloredTitle = supportsColor() ? pc.bold(pc.cyan(title)) : title;

	console.log("");
	console.log(pc.cyan(`${BOX.topLeft}${horizontalLine(BOX.horizontal, innerWidth)}${BOX.topRight}`));
	console.log(pc.cyan(`${BOX.vertical}${centerText(coloredTitle, innerWidth)}${BOX.vertical}`));
	console.log(
		pc.cyan(`${BOX.bottomLeft}${horizontalLine(BOX.horizontal, innerWidth)}${BOX.bottomRight}`),
	);
	console.log("");
}

/**
 * Display information about running servers
 *
 * Shows a list of all running OpenCode servers with their URLs and attach commands.
 *
 * @param servers - Array of server information objects
 *
 * @example
 * ```typescript
 * displayServerInfo([
 *   { issueId: 'ISSUE-001', port: 4096, sessionName: 'milhouse-ISSUE-001', status: 'running' },
 *   { issueId: 'ISSUE-002', port: 4097, sessionName: 'milhouse-ISSUE-002', status: 'running' },
 * ]);
 * ```
 */
export function displayServerInfo(servers: ServerInfo[]): void {
	if (servers.length === 0) {
		console.log(pc.dim("  No servers running."));
		return;
	}

	console.log(pc.bold("  Agent servers started:"));
	console.log("");

	for (const server of servers) {
		const url = server.url ?? getServerUrl(server.port);
		const statusIcon = getStatusIcon(server.status);
		const statusColor = getStatusColor(server.status);

		console.log(`  ${statusColor(`${statusIcon} Issue ${server.issueId}`)}: ${pc.cyan(url)}`);
		console.log(`    ${pc.dim("Attach:")} opencode attach ${url}`);
		console.log(`    ${pc.dim("Tmux:")}   tmux attach -t ${server.sessionName}`);

		if (server.status === "error" && server.error) {
			console.log(`    ${pc.red("Error:")}  ${server.error}`);
		}

		console.log("");
	}
}

/**
 * Display attach instructions for all servers
 *
 * Shows comprehensive instructions for attaching to running servers,
 * including individual attach commands and a combined tmux layout command.
 *
 * @param servers - Array of server information objects
 *
 * @example
 * ```typescript
 * displayAttachInstructions([
 *   { issueId: 'ISSUE-001', port: 4096, sessionName: 'milhouse-ISSUE-001', status: 'running' },
 * ]);
 * ```
 */
export function displayAttachInstructions(servers: ServerInfo[]): void {
	displayTmuxModeHeader();
	displayServerInfo(servers);

	if (servers.length > 1) {
		console.log(pc.bold("  Or attach all in tmux:"));
		console.log("");
		console.log(pc.dim(displayTmuxLayoutCommand(servers)));
	}

	console.log(horizontalLine("═", Math.min(getTerminalWidth() - 2, HEADER_WIDTH)));
	console.log("");
}

/**
 * Generate a tmux layout command for multiple servers
 *
 * Creates a shell script that sets up a tmux session with split panes
 * for each running server.
 *
 * @param servers - Array of server information objects
 * @returns Multi-line shell command string
 *
 * @example
 * ```typescript
 * const cmd = displayTmuxLayoutCommand([
 *   { issueId: 'ISSUE-001', port: 4096, sessionName: 'milhouse-ISSUE-001', status: 'running' },
 *   { issueId: 'ISSUE-002', port: 4097, sessionName: 'milhouse-ISSUE-002', status: 'running' },
 * ]);
 * console.log(cmd);
 * // Output:
 * //     tmux new-session -d -s milhouse-agents
 * //     tmux split-window -h
 * //     tmux send-keys -t 0 "opencode attach http://localhost:4096" Enter
 * //     tmux send-keys -t 1 "opencode attach http://localhost:4097" Enter
 * //     tmux attach -t milhouse-agents
 * ```
 */
export function displayTmuxLayoutCommand(servers: ServerInfo[]): string {
	if (servers.length === 0) {
		return "";
	}

	const lines: string[] = [];
	const sessionName = "milhouse-agents";

	// Create new session
	lines.push(`    tmux new-session -d -s ${sessionName}`);

	// Add split windows for additional servers
	for (let i = 1; i < servers.length; i++) {
		// Alternate between horizontal and vertical splits for better layout
		const splitType = i % 2 === 1 ? "-h" : "-v";
		lines.push(`    tmux split-window ${splitType}`);
	}

	// Send attach commands to each pane
	for (let i = 0; i < servers.length; i++) {
		const server = servers[i];
		const url = server.url ?? getServerUrl(server.port);
		lines.push(`    tmux send-keys -t ${i} "opencode attach ${url}" Enter`);
	}

	// Attach to the session
	lines.push(`    tmux attach -t ${sessionName}`);

	return lines.join("\n");
}

/**
 * Get status icon for server status
 */
function getStatusIcon(status: ServerInfo["status"]): string {
	switch (status) {
		case "starting":
			return "○";
		case "running":
			return "●";
		case "completed":
			return "✓";
		case "error":
			return "✗";
		default:
			return "○";
	}
}

/**
 * Get color function for server status
 */
function getStatusColor(status: ServerInfo["status"]): (text: string) => string {
	if (!supportsColor()) {
		return (text: string) => text;
	}

	switch (status) {
		case "starting":
			return pc.yellow;
		case "running":
			return pc.green;
		case "completed":
			return pc.cyan;
		case "error":
			return pc.red;
		default:
			return pc.dim;
	}
}

/**
 * Display a compact server status line
 *
 * Shows a single-line status for a server, useful for progress updates.
 *
 * @param server - Server information object
 * @returns Formatted status line string
 */
export function formatServerStatusLine(server: ServerInfo): string {
	const url = server.url ?? getServerUrl(server.port);
	const statusIcon = getStatusIcon(server.status);
	const statusColor = getStatusColor(server.status);

	return `${statusColor(statusIcon)} ${server.issueId}: ${pc.dim(url)}`;
}

/**
 * Display completion summary for tmux mode
 *
 * Shows a summary after all servers have completed execution.
 *
 * @param servers - Array of server information objects
 */
export function displayTmuxCompletionSummary(servers: ServerInfo[]): void {
	const completed = servers.filter((s) => s.status === "completed").length;
	const failed = servers.filter((s) => s.status === "error").length;
	const total = servers.length;

	console.log("");
	console.log(pc.bold("  Tmux Mode Summary:"));
	console.log(`    ${pc.green("✓")} Completed: ${completed}/${total}`);

	if (failed > 0) {
		console.log(`    ${pc.red("✗")} Failed:    ${failed}/${total}`);
	}

	console.log("");

	// Show preserved sessions
	const runningSessions = servers.filter((s) => s.status !== "error");
	if (runningSessions.length > 0) {
		console.log(pc.dim("  Tmux sessions preserved for inspection:"));
		for (const server of runningSessions) {
			console.log(pc.dim(`    tmux attach -t ${server.sessionName}`));
		}
		console.log("");
		console.log(pc.dim("  To kill all sessions: tmux kill-server"));
	}

	console.log("");
}
