/**
 * OpenCode Engine Module
 *
 * This module provides OpenCode-specific functionality for milhouse,
 * including auto-installation, server management, and tmux integration.
 *
 * @see https://opencode.ai/docs
 */

// ============================================================================
// Installer
// ============================================================================

export {
	OpencodeInstaller,
	ensureOpencodeInstalled,
	getInstallationInstructions,
} from "./installer";

export type { InstallMethod, InstallResult, InstallerOptions } from "./installer";

// ============================================================================
// Types
// ============================================================================

export type {
	// Session types
	Session,
	CreateSessionOptions,
	UpdateSessionOptions,
	SessionStatus,
	SessionStatusMap,
	// Message types
	Message,
	Part,
	MessageResponse,
	SendMessageOptions,
	ExecuteCommandOptions,
	RunShellOptions,
	ModelSpec,
	// File types
	FileDiff,
	FileNode,
	FileContent,
	FileStatus,
	// Todo types
	Todo,
	// Project types
	Project,
	PathInfo,
	VcsInfo,
	// Provider types
	Provider,
	ProviderModel,
	ProviderAuthMethod,
	ProviderAuthAuthorization,
	// Config types
	Config,
	ConfigProviders,
	// Agent types
	Agent,
	// Command types
	Command,
	CommandArgument,
	// Health types
	HealthResponse,
	LSPStatus,
	FormatterStatus,
	MCPStatus,
	MCPStatusMap,
	// Event types
	ServerEvent,
	EventType,
	// TUI types
	ToastOptions,
	TUIControlRequest,
	TUIControlResponse,
	// Search types
	SearchMatch,
	SearchSubmatch,
	Symbol,
	// Tool types
	ToolIDs,
	Tool,
	ToolList,
	// Permission types
	PermissionRequest,
	PermissionResponse,
	// Fork/Revert types
	ForkSessionOptions,
	RevertMessageOptions,
	// Other types
	SummarizeOptions,
	InitSessionOptions,
	LogEntry,
	AddMCPServerOptions,
	MCPServerConfig,
	APIError,
} from "./types";

export { OpencodeServerError } from "./types";

// ============================================================================
// Port Manager
// ============================================================================

export { PortManager } from "./port-manager";

// ============================================================================
// Server Executor
// ============================================================================

export { OpencodeServerExecutor, createOpencodeExecutor, parseModelString } from "./server-executor";

export type { OpencodeServerConfig } from "./server-executor";

// ============================================================================
// UI Components
// ============================================================================

export {
	// Attach Instructions
	displayTmuxModeHeader,
	displayServerInfo,
	displayAttachInstructions,
	displayTmuxLayoutCommand,
	formatServerStatusLine,
	displayTmuxCompletionSummary,
	// Status Dashboard
	displayStatusDashboard,
	updateAgentStatus,
	getAllAgentStatuses,
	clearAgentStatuses,
	formatTokens,
	formatTokenPair,
	formatCompactStatus,
	displayAgentSummary,
	createProgressBar,
} from "./ui";

export type { ServerInfo, AgentStatus, DashboardOptions } from "./ui";

// ============================================================================
// Autonomy Configuration
// ============================================================================

export {
	// System prompts
	AUTONOMY_SYSTEM_PROMPT,
	ANALYSIS_SYSTEM_PROMPT,
	EXECUTION_SYSTEM_PROMPT,
	// Tool sets
	READ_ONLY_TOOLS,
	EXECUTION_TOOLS,
	// Helper functions
	getSystemPromptForPhase,
	getToolsForPhase,
	isAnalysisPhase,
	getMessageOptionsForPhase,
	mergeWithAutonomyConfig,
} from "./autonomy-config";

export type { PipelinePhase, AutonomyMessageOptions } from "./autonomy-config";
