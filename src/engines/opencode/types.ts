/**
 * OpenCode Server API Types
 *
 * TypeScript interfaces for the OpenCode Server HTTP API.
 * Based on the OpenAPI 3.1 specification from https://opencode.ai/docs/server
 *
 * @see https://opencode.ai/docs/server
 */

// ============================================================================
// Session Types
// ============================================================================

/**
 * Represents an OpenCode session.
 *
 * Sessions are the primary unit of interaction with OpenCode.
 * Each session maintains its own conversation history and state.
 */
export interface Session {
	/** Unique session identifier */
	id: string;
	/** Optional session title */
	title?: string;
	/** Parent session ID (for forked sessions) */
	parentID?: string;
	/** ISO 8601 timestamp when the session was created */
	createdAt: string;
	/** ISO 8601 timestamp when the session was last updated */
	updatedAt: string;
	/** Share ID if the session is shared */
	shareID?: string;
	/** Summary of the session (if summarized) */
	summary?: string;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
	/** Parent session ID to fork from */
	parentID?: string;
	/** Initial session title */
	title?: string;
}

/**
 * Options for updating a session.
 */
export interface UpdateSessionOptions {
	/** New session title */
	title?: string;
}

/**
 * Session status information.
 */
export interface SessionStatus {
	/** Current status of the session */
	status: "idle" | "running" | "error";
	/** ISO 8601 timestamp of last activity */
	lastActivity?: string;
	/** Error message if status is 'error' */
	error?: string;
}

/**
 * Map of session IDs to their status.
 */
export interface SessionStatusMap {
	[sessionId: string]: SessionStatus;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Message metadata.
 */
export interface Message {
	/** Unique message identifier */
	id: string;
	/** Role of the message sender */
	role: "user" | "assistant";
	/** Number of input tokens used */
	inputTokens?: number;
	/** Number of output tokens generated */
	outputTokens?: number;
	/** ISO 8601 timestamp when the message was created */
	createdAt?: string;
}

/**
 * A part of a message (text, tool use, or tool result).
 */
export interface Part {
	/** Type of the part */
	type: "text" | "tool_use" | "tool_result" | "image" | "file";
	/** Text content (for text parts) */
	text?: string;
	/** Tool name (for tool_use parts) */
	name?: string;
	/** Tool input (for tool_use parts) */
	input?: unknown;
	/** Tool call ID (for tool_use and tool_result parts) */
	toolCallId?: string;
	/** Tool result content (for tool_result parts) */
	content?: unknown;
	/** Whether the tool call errored (for tool_result parts) */
	isError?: boolean;
}

/**
 * A message with its parts.
 */
export interface MessageResponse {
	/** Message metadata */
	info: Message;
	/** Message parts (content) */
	parts: Part[];
}

/**
 * Model specification for API requests.
 * The OpenCode Server API expects model as an object with providerID and modelID.
 */
export interface ModelSpec {
	/** Provider ID (e.g., "anthropic", "amazon-bedrock", "openai") */
	providerID: string;
	/** Model ID (e.g., "claude-sonnet-4-5", "anthropic.claude-opus-4-5-20251101-v1:0") */
	modelID: string;
}

/**
 * Options for sending a message.
 */
export interface SendMessageOptions {
	/** Message ID to continue from */
	messageID?: string;
	/** Model to use (overrides session default) - object with providerID and modelID */
	model?: ModelSpec;
	/** Agent to use */
	agent?: string;
	/** If true, don't trigger AI response */
	noReply?: boolean;
	/** System prompt override */
	system?: string;
	/** Tools to enable/disable */
	tools?: string[];
	/** Message parts to send */
	parts: Part[];
}

/**
 * Options for executing a slash command.
 */
export interface ExecuteCommandOptions {
	/** Message ID to continue from */
	messageID?: string;
	/** Agent to use */
	agent?: string;
	/** Model to use */
	model?: string;
	/** Command name (without slash) */
	command: string;
	/** Command arguments */
	arguments: string;
}

/**
 * Options for running a shell command.
 */
export interface RunShellOptions {
	/** Agent to use */
	agent: string;
	/** Model to use */
	model?: string;
	/** Shell command to run */
	command: string;
}

// ============================================================================
// File and Diff Types
// ============================================================================

/**
 * Represents a file diff from a session.
 */
export interface FileDiff {
	/** File path relative to project root */
	path: string;
	/** Unified diff content */
	diff: string;
	/** Number of lines added */
	additions: number;
	/** Number of lines deleted */
	deletions: number;
}

/**
 * File node in the file tree.
 */
export interface FileNode {
	/** File or directory name */
	name: string;
	/** Full path */
	path: string;
	/** Whether this is a directory */
	isDirectory: boolean;
	/** Child nodes (for directories) */
	children?: FileNode[];
}

/**
 * File content response.
 */
export interface FileContent {
	/** File path */
	path: string;
	/** File content */
	content: string;
	/** File encoding */
	encoding?: string;
}

/**
 * File status information.
 */
export interface FileStatus {
	/** File path */
	path: string;
	/** Git status (modified, added, deleted, etc.) */
	status: string;
}

// ============================================================================
// Todo Types
// ============================================================================

/**
 * A todo item from the agent's task list.
 */
export interface Todo {
	/** Unique todo identifier */
	id: string;
	/** Todo text/description */
	text: string;
	/** Whether the todo is completed */
	completed: boolean;
	/** Optional parent todo ID */
	parentId?: string;
}

// ============================================================================
// Project Types
// ============================================================================

/**
 * Project information.
 */
export interface Project {
	/** Project identifier */
	id: string;
	/** Project name */
	name: string;
	/** Project root path */
	path: string;
	/** Whether this is the current project */
	isCurrent?: boolean;
}

/**
 * Current path information.
 */
export interface PathInfo {
	/** Current working directory */
	cwd: string;
	/** Project root path */
	root: string;
}

/**
 * VCS (Version Control System) information.
 */
export interface VcsInfo {
	/** VCS type (git, etc.) */
	type: string;
	/** Current branch */
	branch?: string;
	/** Remote URL */
	remote?: string;
	/** Whether there are uncommitted changes */
	dirty?: boolean;
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * AI provider information.
 */
export interface Provider {
	/** Provider identifier */
	id: string;
	/** Provider display name */
	name: string;
	/** Available models */
	models: ProviderModel[];
	/** Whether the provider is connected */
	connected?: boolean;
}

/**
 * Model information from a provider.
 */
export interface ProviderModel {
	/** Model identifier */
	id: string;
	/** Model display name */
	name: string;
	/** Maximum context length */
	contextLength?: number;
}

/**
 * Provider authentication method.
 */
export interface ProviderAuthMethod {
	/** Authentication type */
	type: "api_key" | "oauth" | "browser";
	/** Display name */
	name: string;
	/** Description */
	description?: string;
}

/**
 * OAuth authorization response.
 */
export interface ProviderAuthAuthorization {
	/** Authorization URL to redirect to */
	url: string;
	/** State parameter for CSRF protection */
	state: string;
}

// ============================================================================
// Config Types
// ============================================================================

/**
 * OpenCode configuration.
 */
export interface Config {
	/** Default provider ID */
	provider?: string;
	/** Default model ID */
	model?: string;
	/** Theme name */
	theme?: string;
	/** Auto-approve tools */
	autoApprove?: boolean;
	/** Additional configuration options */
	[key: string]: unknown;
}

/**
 * Config providers response.
 */
export interface ConfigProviders {
	/** Available providers */
	providers: Provider[];
	/** Default models by provider */
	default: { [providerId: string]: string };
}

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Agent information.
 */
export interface Agent {
	/** Agent identifier */
	id: string;
	/** Agent display name */
	name: string;
	/** Agent description */
	description?: string;
	/** System prompt */
	systemPrompt?: string;
}

// ============================================================================
// Command Types
// ============================================================================

/**
 * Slash command information.
 */
export interface Command {
	/** Command name (without slash) */
	name: string;
	/** Command description */
	description: string;
	/** Command arguments schema */
	arguments?: CommandArgument[];
}

/**
 * Command argument definition.
 */
export interface CommandArgument {
	/** Argument name */
	name: string;
	/** Argument description */
	description?: string;
	/** Whether the argument is required */
	required?: boolean;
	/** Argument type */
	type?: string;
}

// ============================================================================
// Health and Status Types
// ============================================================================

/**
 * Server health check response.
 */
export interface HealthResponse {
	/** Whether the server is healthy */
	healthy: boolean;
	/** Server version */
	version: string;
}

/**
 * LSP server status.
 */
export interface LSPStatus {
	/** Language ID */
	language: string;
	/** Server name */
	name: string;
	/** Whether the server is running */
	running: boolean;
	/** Error message if not running */
	error?: string;
}

/**
 * Formatter status.
 */
export interface FormatterStatus {
	/** Language ID */
	language: string;
	/** Formatter name */
	name: string;
	/** Whether the formatter is available */
	available: boolean;
}

/**
 * MCP server status.
 */
export interface MCPStatus {
	/** Server name */
	name: string;
	/** Whether the server is connected */
	connected: boolean;
	/** Available tools */
	tools?: string[];
	/** Error message if not connected */
	error?: string;
}

/**
 * Map of MCP server names to their status.
 */
export interface MCPStatusMap {
	[name: string]: MCPStatus;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Server-sent event from the event stream.
 */
export interface ServerEvent {
	/** Event type */
	type: string;
	/** Event properties */
	properties: Record<string, unknown>;
	/** ISO 8601 timestamp */
	timestamp?: string;
}

/**
 * Event types emitted by the server.
 */
export type EventType =
	| "server.connected"
	| "session.created"
	| "session.updated"
	| "session.deleted"
	| "message.created"
	| "message.updated"
	| "message.completed"
	| "tool.started"
	| "tool.completed"
	| "file.changed"
	| "error";

// ============================================================================
// TUI Control Types
// ============================================================================

/**
 * Toast notification options.
 */
export interface ToastOptions {
	/** Toast title */
	title?: string;
	/** Toast message */
	message: string;
	/** Toast variant */
	variant: "info" | "success" | "warning" | "error";
}

/**
 * TUI control request.
 */
export interface TUIControlRequest {
	/** Request type */
	type: string;
	/** Request payload */
	payload?: unknown;
}

/**
 * TUI control response.
 */
export interface TUIControlResponse {
	/** Response body */
	body: unknown;
}

// ============================================================================
// Search Types
// ============================================================================

/**
 * Text search match.
 */
export interface SearchMatch {
	/** File path */
	path: string;
	/** Matching lines */
	lines: string;
	/** Line number */
	line_number: number;
	/** Absolute offset in file */
	absolute_offset: number;
	/** Submatches within the line */
	submatches: SearchSubmatch[];
}

/**
 * Submatch within a search result.
 */
export interface SearchSubmatch {
	/** Match text */
	match: string;
	/** Start offset within the line */
	start: number;
	/** End offset within the line */
	end: number;
}

/**
 * Symbol search result.
 */
export interface Symbol {
	/** Symbol name */
	name: string;
	/** Symbol kind (function, class, variable, etc.) */
	kind: string;
	/** File path */
	path: string;
	/** Line number */
	line: number;
	/** Column number */
	column: number;
}

// ============================================================================
// Tool Types (Experimental)
// ============================================================================

/**
 * Tool IDs response.
 */
export interface ToolIDs {
	/** List of available tool IDs */
	ids: string[];
}

/**
 * Tool definition with JSON schema.
 */
export interface Tool {
	/** Tool name */
	name: string;
	/** Tool description */
	description: string;
	/** JSON schema for tool input */
	inputSchema: Record<string, unknown>;
}

/**
 * Tool list response.
 */
export interface ToolList {
	/** Available tools */
	tools: Tool[];
}

// ============================================================================
// Permission Types
// ============================================================================

/**
 * Permission request from the agent.
 */
export interface PermissionRequest {
	/** Permission request ID */
	id: string;
	/** Permission type */
	type: string;
	/** Description of what's being requested */
	description: string;
	/** Additional context */
	context?: Record<string, unknown>;
}

/**
 * Permission response options.
 */
export interface PermissionResponse {
	/** Whether to allow the action */
	response: "allow" | "deny";
	/** Whether to remember this decision */
	remember?: boolean;
}

// ============================================================================
// Fork and Revert Types
// ============================================================================

/**
 * Options for forking a session.
 */
export interface ForkSessionOptions {
	/** Message ID to fork from */
	messageID?: string;
}

/**
 * Options for reverting a message.
 */
export interface RevertMessageOptions {
	/** Message ID to revert */
	messageID: string;
	/** Part ID to revert (optional, reverts entire message if not specified) */
	partID?: string;
}

// ============================================================================
// Summarize Types
// ============================================================================

/**
 * Options for summarizing a session.
 */
export interface SummarizeOptions {
	/** Provider ID to use for summarization */
	providerID: string;
	/** Model ID to use for summarization */
	modelID: string;
}

// ============================================================================
// Init Types
// ============================================================================

/**
 * Options for initializing a session (creating AGENTS.md).
 */
export interface InitSessionOptions {
	/** Message ID to use as context */
	messageID: string;
	/** Provider ID to use */
	providerID: string;
	/** Model ID to use */
	modelID: string;
}

// ============================================================================
// Log Types
// ============================================================================

/**
 * Log entry for the logging endpoint.
 */
export interface LogEntry {
	/** Service name */
	service: string;
	/** Log level */
	level: "debug" | "info" | "warn" | "error";
	/** Log message */
	message: string;
	/** Additional data */
	extra?: Record<string, unknown>;
}

// ============================================================================
// MCP Server Types
// ============================================================================

/**
 * Options for adding an MCP server dynamically.
 */
export interface AddMCPServerOptions {
	/** Server name */
	name: string;
	/** Server configuration */
	config: MCPServerConfig;
}

/**
 * MCP server configuration.
 */
export interface MCPServerConfig {
	/** Command to run the server */
	command: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * API error response.
 */
export interface APIError {
	/** Error message */
	message: string;
	/** Error code */
	code?: string;
	/** Additional error details */
	details?: Record<string, unknown>;
}

/**
 * Server executor error.
 */
export class OpencodeServerError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly statusCode?: number,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "OpencodeServerError";
	}
}
