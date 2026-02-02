/**
 * OpenCode UI Module
 *
 * Provides user interface components for tmux mode, including:
 * - Attach instructions display
 * - Status dashboard for monitoring agents
 *
 * @module engines/opencode/ui
 * @since 1.0.0
 */

// ============================================================================
// Attach Instructions
// ============================================================================

export {
	displayTmuxModeHeader,
	displayServerInfo,
	displayAttachInstructions,
	displayTmuxLayoutCommand,
	formatServerStatusLine,
	displayTmuxCompletionSummary,
} from "./attach-instructions";

export type { ServerInfo } from "./attach-instructions";

// ============================================================================
// Status Dashboard
// ============================================================================

export {
	displayStatusDashboard,
	updateAgentStatus,
	getAllAgentStatuses,
	clearAgentStatuses,
	formatTokens,
	formatTokenPair,
	formatCompactStatus,
	displayAgentSummary,
	createProgressBar,
} from "./status-dashboard";

export type { AgentStatus, DashboardOptions } from "./status-dashboard";
