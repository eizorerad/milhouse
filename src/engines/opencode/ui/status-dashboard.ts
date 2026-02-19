/**
 * Status Dashboard Module
 *
 * Provides a real-time status dashboard for monitoring multiple running agents.
 * Shows issue status, task progress, token usage, and attach commands.
 *
 * @module engines/opencode/ui/status-dashboard
 * @since 1.0.0
 */

import pc from "picocolors";

// ============================================================================
// Types
// ============================================================================

/**
 * Status of an individual agent
 */
export interface AgentStatus {
	/** Issue ID being processed */
	issueId: string;
	/** Current execution status */
	status: "waiting" | "running" | "completed" | "error";
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Total number of tasks */
	tasksTotal: number;
	/** Input tokens used */
	inputTokens: number;
	/** Output tokens used */
	outputTokens: number;
	/** Port the server is running on */
	port: number;
	/** Error message if status is 'error' */
	error?: string;
	/** Start time for duration calculation */
	startTime?: number;
}

/**
 * Dashboard configuration options
 */
export interface DashboardOptions {
	/** Whether to show token usage */
	showTokens?: boolean;
	/** Whether to show attach commands */
	showAttachCommands?: boolean;
	/** Minimum width for the dashboard */
	minWidth?: number;
	/** Maximum width for the dashboard */
	maxWidth?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Box drawing characters for the dashboard
 */
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeRight: "├",
	teeLeft: "┤",
	teeDown: "┬",
	teeUp: "┴",
	cross: "┼",
} as const;

/**
 * Status indicators
 */
const STATUS_ICONS = {
	waiting: "○",
	running: "●",
	completed: "✓",
	error: "✗",
} as const;

/**
 * Default column widths
 */
const DEFAULT_COLUMNS: Record<string, number> = {
	issue: 12,
	status: 11,
	tasks: 8,
	tokens: 12,
	port: 6,
	attach: 12,
};

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
 * Format token count with 'k' suffix for thousands
 *
 * @param tokens - Number of tokens
 * @returns Formatted string (e.g., "12.5k" or "500")
 *
 * @example
 * ```typescript
 * formatTokens(12500);  // "12.5k"
 * formatTokens(500);    // "500"
 * formatTokens(0);      // "-"
 * ```
 */
export function formatTokens(tokens: number): string {
	if (tokens === 0) {
		return "-";
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return String(tokens);
}

/**
 * Format input/output tokens as a combined string
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Formatted string (e.g., "12.5k/8.2k")
 */
export function formatTokenPair(inputTokens: number, outputTokens: number): string {
	if (inputTokens === 0 && outputTokens === 0) {
		return "-";
	}
	return `${formatTokens(inputTokens)}/${formatTokens(outputTokens)}`;
}

/**
 * Pad or truncate string to exact width
 */
function padString(str: string, width: number, align: "left" | "right" | "center" = "left"): string {
	// Strip ANSI codes for length calculation
	const plainStr = str.replace(/\x1b\[[0-9;]*m/g, "");
	const len = plainStr.length;

	if (len >= width) {
		// Truncate if too long
		if (len > width) {
			return str.slice(0, width - 1) + "…";
		}
		return str;
	}

	const padding = width - len;
	switch (align) {
		case "right":
			return " ".repeat(padding) + str;
		case "center": {
			const leftPad = Math.floor(padding / 2);
			const rightPad = padding - leftPad;
			return " ".repeat(leftPad) + str + " ".repeat(rightPad);
		}
		default:
			return str + " ".repeat(padding);
	}
}

/**
 * Create a horizontal line for the table
 */
function createHorizontalLine(
	widths: number[],
	left: string,
	middle: string,
	right: string,
	line: string,
): string {
	const segments = widths.map((w) => line.repeat(w + 2));
	return left + segments.join(middle) + right;
}

/**
 * Get status icon
 */
function getStatusIcon(status: AgentStatus["status"]): string {
	return STATUS_ICONS[status] ?? "○";
}

/**
 * Get status text with color
 */
function getStatusText(status: AgentStatus["status"]): string {
	const icon = getStatusIcon(status);
	const text = status.charAt(0).toUpperCase() + status.slice(1);

	if (!supportsColor()) {
		return `${icon} ${text}`;
	}

	switch (status) {
		case "waiting":
			return `${pc.dim(icon)} ${pc.dim(text)}`;
		case "running":
			return `${pc.green(icon)} ${pc.green(text)}`;
		case "completed":
			return `${pc.cyan(icon)} ${pc.cyan(text)}`;
		case "error":
			return `${pc.red(icon)} ${pc.red(text)}`;
		default:
			return `${icon} ${text}`;
	}
}

// ============================================================================
// Dashboard State Management
// ============================================================================

/**
 * Internal state for tracking agents
 */
const agentStates = new Map<string, AgentStatus>();

/**
 * Update the status of a specific agent
 *
 * @param issueId - Issue ID to update
 * @param status - Partial status update
 *
 * @example
 * ```typescript
 * updateAgentStatus('ISSUE-001', { status: 'running', tasksCompleted: 2 });
 * ```
 */
export function updateAgentStatus(issueId: string, status: Partial<AgentStatus>): void {
	const existing = agentStates.get(issueId);
	if (existing) {
		agentStates.set(issueId, { ...existing, ...status });
	} else {
		// Create new entry with defaults
		agentStates.set(issueId, {
			issueId,
			status: "waiting",
			tasksCompleted: 0,
			tasksTotal: 0,
			inputTokens: 0,
			outputTokens: 0,
			port: 0,
			...status,
		});
	}
}

/**
 * Get all agent statuses
 */
export function getAllAgentStatuses(): AgentStatus[] {
	return Array.from(agentStates.values());
}

/**
 * Clear all agent statuses
 */
export function clearAgentStatuses(): void {
	agentStates.clear();
}

// ============================================================================
// Display Functions
// ============================================================================

/**
 * Display the status dashboard
 *
 * Shows a table with all running agents and their current status.
 *
 * @param agents - Array of agent status objects
 * @param options - Dashboard display options
 *
 * @example
 * ```typescript
 * displayStatusDashboard([
 *   { issueId: 'ISSUE-001', status: 'running', tasksCompleted: 2, tasksTotal: 5, inputTokens: 12500, outputTokens: 8200, port: 4096 },
 *   { issueId: 'ISSUE-002', status: 'running', tasksCompleted: 1, tasksTotal: 3, inputTokens: 8100, outputTokens: 5400, port: 4097 },
 *   { issueId: 'ISSUE-003', status: 'waiting', tasksCompleted: 0, tasksTotal: 4, inputTokens: 0, outputTokens: 0, port: 4098 },
 * ]);
 * // Output:
 * // ┌─────────────────────────────────────────────────────────────────────────────┐
 * // │ MILHOUSE AGENT STATUS                                                        │
 * // ├─────────────────────────────────────────────────────────────────────────────┤
 * // │ Issue        │ Status      │ Tasks    │ Tokens      │ Port  │ Attach       │
 * // ├─────────────────────────────────────────────────────────────────────────────┤
 * // │ ISSUE-001    │ ● Running   │ 2/5      │ 12.5k/8.2k  │ 4096  │ attach :4096 │
 * // │ ISSUE-002    │ ● Running   │ 1/3      │ 8.1k/5.4k   │ 4097  │ attach :4097 │
 * // │ ISSUE-003    │ ○ Waiting   │ 0/4      │ -           │ 4098  │ attach :4098 │
 * // └─────────────────────────────────────────────────────────────────────────────┘
 * ```
 */
export function displayStatusDashboard(
	agents: AgentStatus[],
	options: DashboardOptions = {},
): void {
	const { showTokens = true, showAttachCommands = true, minWidth = 60, maxWidth = 100 } = options;

	if (agents.length === 0) {
		console.log(pc.dim("  No agents to display."));
		return;
	}

	// Calculate column widths based on content
	const columns = { ...DEFAULT_COLUMNS };

	// Adjust issue column width based on longest issue ID
	const maxIssueLen = Math.max(...agents.map((a) => a.issueId.length));
	columns.issue = Math.max(columns.issue, maxIssueLen);

	// Build column list based on options
	const columnList: Array<{ key: keyof typeof columns; header: string }> = [
		{ key: "issue", header: "Issue" },
		{ key: "status", header: "Status" },
		{ key: "tasks", header: "Tasks" },
	];

	if (showTokens) {
		columnList.push({ key: "tokens", header: "Tokens" });
	}

	columnList.push({ key: "port", header: "Port" });

	if (showAttachCommands) {
		columnList.push({ key: "attach", header: "Attach" });
	}

	const widths = columnList.map((c) => columns[c.key]);

	// Calculate total width
	const totalWidth = widths.reduce((sum, w) => sum + w + 3, 0) + 1;
	const constrainedWidth = Math.min(Math.max(totalWidth, minWidth), maxWidth);

	// Header
	const title = "MILHOUSE AGENT STATUS";
	console.log(createHorizontalLine(widths, BOX.topLeft, BOX.teeDown, BOX.topRight, BOX.horizontal));
	console.log(
		`${BOX.vertical} ${supportsColor() ? pc.bold(title) : title}${" ".repeat(Math.max(0, constrainedWidth - title.length - 4))} ${BOX.vertical}`,
	);
	console.log(createHorizontalLine(widths, BOX.teeRight, BOX.cross, BOX.teeLeft, BOX.horizontal));

	// Column headers
	const headerRow = columnList
		.map((c, i) => ` ${padString(c.header, widths[i])} `)
		.join(BOX.vertical);
	console.log(`${BOX.vertical}${headerRow}${BOX.vertical}`);
	console.log(createHorizontalLine(widths, BOX.teeRight, BOX.cross, BOX.teeLeft, BOX.horizontal));

	// Data rows
	for (const agent of agents) {
		const cells: string[] = [];

		for (const col of columnList) {
			let value: string;
			const width = columns[col.key];

			switch (col.key) {
				case "issue":
					value = agent.issueId;
					break;
				case "status":
					value = getStatusText(agent.status);
					break;
				case "tasks":
					value = `${agent.tasksCompleted}/${agent.tasksTotal}`;
					break;
				case "tokens":
					value = formatTokenPair(agent.inputTokens, agent.outputTokens);
					break;
				case "port":
					value = String(agent.port);
					break;
				case "attach":
					value = `attach :${agent.port}`;
					break;
				default:
					value = "";
			}

			cells.push(` ${padString(value, width)} `);
		}

		console.log(`${BOX.vertical}${cells.join(BOX.vertical)}${BOX.vertical}`);
	}

	// Footer
	console.log(
		createHorizontalLine(widths, BOX.bottomLeft, BOX.teeUp, BOX.bottomRight, BOX.horizontal),
	);
}

/**
 * Display a compact single-line status for all agents
 *
 * Useful for progress updates without redrawing the full dashboard.
 *
 * @param agents - Array of agent status objects
 * @returns Formatted status line
 */
export function formatCompactStatus(agents: AgentStatus[]): string {
	const running = agents.filter((a) => a.status === "running").length;
	const completed = agents.filter((a) => a.status === "completed").length;
	const failed = agents.filter((a) => a.status === "error").length;
	const total = agents.length;

	const parts: string[] = [];

	if (running > 0) {
		parts.push(supportsColor() ? pc.green(`●${running}`) : `●${running}`);
	}
	if (completed > 0) {
		parts.push(supportsColor() ? pc.cyan(`✓${completed}`) : `✓${completed}`);
	}
	if (failed > 0) {
		parts.push(supportsColor() ? pc.red(`✗${failed}`) : `✗${failed}`);
	}

	const statusStr = parts.length > 0 ? parts.join(" ") : "○0";
	return `[${statusStr}/${total}]`;
}

/**
 * Display a summary of agent execution results
 *
 * @param agents - Array of agent status objects
 */
export function displayAgentSummary(agents: AgentStatus[]): void {
	const completed = agents.filter((a) => a.status === "completed");
	const failed = agents.filter((a) => a.status === "error");
	const total = agents.length;

	const totalInputTokens = agents.reduce((sum, a) => sum + a.inputTokens, 0);
	const totalOutputTokens = agents.reduce((sum, a) => sum + a.outputTokens, 0);
	const totalTasks = agents.reduce((sum, a) => sum + a.tasksTotal, 0);
	const completedTasks = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);

	console.log("");
	console.log(pc.bold("  Agent Execution Summary:"));
	console.log(`    ${pc.green("✓")} Completed: ${completed.length}/${total} agents`);

	if (failed.length > 0) {
		console.log(`    ${pc.red("✗")} Failed:    ${failed.length}/${total} agents`);
		for (const agent of failed) {
			console.log(`      - ${agent.issueId}: ${agent.error ?? "Unknown error"}`);
		}
	}

	console.log(`    Tasks:     ${completedTasks}/${totalTasks}`);
	console.log(`    Tokens:    ${formatTokenPair(totalInputTokens, totalOutputTokens)}`);
	console.log("");
}

/**
 * Create a progress bar string
 *
 * @param current - Current progress value
 * @param total - Total value
 * @param width - Width of the progress bar in characters
 * @returns Formatted progress bar string
 */
export function createProgressBar(current: number, total: number, width = 20): string {
	if (total === 0) {
		return pc.dim("░".repeat(width));
	}

	const filled = Math.round((current / total) * width);
	const empty = width - filled;
	const percent = Math.round((current / total) * 100);

	const bar = supportsColor()
		? pc.green("█".repeat(filled)) + pc.dim("░".repeat(empty))
		: "█".repeat(filled) + "░".repeat(empty);

	return `${bar} ${percent}%`;
}
