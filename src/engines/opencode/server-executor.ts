/**
 * OpenCode Server Executor
 *
 * Manages OpenCode server lifecycle and provides HTTP API access.
 * This is the main class for interacting with OpenCode in server mode.
 *
 * @see https://opencode.ai/docs/server
 */

import type { Subprocess } from "bun";
import { logger } from "../../observability/logger";
import { ensureOpencodeInstalled } from "./installer";
import { PortManager } from "./port-manager";
import type {
	Session,
	CreateSessionOptions,
	UpdateSessionOptions,
	SessionStatus,
	SessionStatusMap,
	MessageResponse,
	SendMessageOptions,
	Part,
	FileDiff,
	Todo,
	HealthResponse,
	ForkSessionOptions,
	RevertMessageOptions,
	SummarizeOptions,
	InitSessionOptions,
	ExecuteCommandOptions,
	RunShellOptions,
	OpencodeServerError,
	ModelSpec,
} from "./types";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration options for the OpenCode server executor.
 */
export interface OpencodeServerConfig {
	/** Port to run the server on (auto-assigned if not specified) */
	port?: number;
	/** Hostname to bind to */
	hostname?: string;
	/** Server startup timeout in milliseconds */
	startupTimeout?: number;
	/** Health check interval in milliseconds */
	healthCheckInterval?: number;
	/** Maximum health check retries */
	maxHealthCheckRetries?: number;
	/** Server password for authentication */
	password?: string;
	/** Server username for authentication */
	username?: string;
	/** Whether to auto-install OpenCode if not found */
	autoInstall?: boolean;
	/** Minimum required OpenCode version */
	minVersion?: string;
	/** Enable verbose logging */
	verbose?: boolean;
	/**
	 * Request timeout in milliseconds for API calls.
	 * This is especially important for long-running AI operations like sendMessage().
	 * Default: 15 minutes (900000ms) to accommodate complex AI tasks.
	 */
	requestTimeout?: number;
	/**
	 * Enable YOLO mode (auto-approve all permission prompts).
	 * When enabled, OpenCode will not ask for permission to execute commands,
	 * read/write files, or perform other operations.
	 * 
	 * WARNING: This is dangerous and should only be used in trusted environments
	 * or automated pipelines where you trust the AI's actions.
	 * 
	 * @default true - Enabled by default for automated pipeline usage
	 */
	yolo?: boolean;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<OpencodeServerConfig, "port" | "password" | "username">> = {
	hostname: "127.0.0.1",
	startupTimeout: 30000, // 30 seconds
	healthCheckInterval: 500, // 500ms
	maxHealthCheckRetries: 60, // 30 seconds total
	autoInstall: true,
	minVersion: "0.1.48",
	verbose: false,
	requestTimeout: 900000, // 15 minutes - long timeout for AI operations
	yolo: true, // Auto-approve all permission prompts for automated pipelines
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse a model string into a ModelSpec object.
 * 
 * The model string format is "providerID/modelID", e.g.:
 * - "anthropic/claude-sonnet-4-5"
 * - "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0"
 * - "openai/gpt-4o"
 * 
 * @param modelString - The model string in "providerID/modelID" format
 * @returns ModelSpec object with providerID and modelID
 * @throws Error if the model string is invalid
 */
export function parseModelString(modelString: string): ModelSpec {
	const slashIndex = modelString.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(
			`Invalid model format: "${modelString}". Expected format: "providerID/modelID" (e.g., "anthropic/claude-sonnet-4-5")`
		);
	}
	
	const providerID = modelString.substring(0, slashIndex);
	const modelID = modelString.substring(slashIndex + 1);
	
	if (!providerID || !modelID) {
		throw new Error(
			`Invalid model format: "${modelString}". Both providerID and modelID must be non-empty.`
		);
	}
	
	return { providerID, modelID };
}

// ============================================================================
// Server Executor Class
// ============================================================================

/**
 * OpenCode Server Executor.
 *
 * Manages the lifecycle of an OpenCode server instance and provides
 * methods to interact with it via the HTTP API.
 *
 * @example
 * ```typescript
 * const executor = new OpencodeServerExecutor();
 *
 * // Start the server
 * const port = await executor.startServer('/path/to/project');
 * console.log(`Server running on port ${port}`);
 *
 * // Create a session and send a message
 * const session = await executor.createSession();
 * const response = await executor.sendMessage(session.id, 'Hello, OpenCode!');
 * console.log(response.parts);
 *
 * // Stop the server when done
 * await executor.stopServer();
 * ```
 */
export class OpencodeServerExecutor {
	private config: Required<Omit<OpencodeServerConfig, "port" | "password" | "username">> &
		Pick<OpencodeServerConfig, "port" | "password" | "username">;
	private serverProcess: Subprocess | null = null;
	private port: number | null = null;
	private baseUrl: string | null = null;
	private workDir: string | null = null;
	private isRunning = false;

	/**
	 * Create a new OpenCode server executor.
	 *
	 * @param config - Server configuration options
	 */
	constructor(config: OpencodeServerConfig = {}) {
		this.config = {
			...DEFAULT_CONFIG,
			...config,
		};
	}

	// ============================================================================
	// Server Lifecycle
	// ============================================================================

	/**
	 * Start the OpenCode server.
	 *
	 * This method:
	 * 1. Ensures OpenCode is installed (optionally auto-installing)
	 * 2. Acquires an available port
	 * 3. Spawns the `opencode serve` process
	 * 4. Waits for the server to become healthy
	 *
	 * @param workDir - Working directory for the server (project root)
	 * @returns The port the server is running on
	 * @throws Error if the server fails to start
	 *
	 * @example
	 * ```typescript
	 * const port = await executor.startServer('/path/to/project');
	 * console.log(`Server running on http://localhost:${port}`);
	 * ```
	 */
	async startServer(workDir: string): Promise<number> {
		if (this.isRunning) {
			throw new Error("Server is already running. Call stopServer() first.");
		}

		this.workDir = workDir;

		// Ensure OpenCode is installed
		await this.ensureInstalled();

		// Acquire a port
		this.port = await PortManager.acquirePort(this.config.port);
		this.baseUrl = `http://${this.config.hostname}:${this.port}`;

		this.log(`Starting OpenCode server on ${this.baseUrl}...`);

		// Build the command arguments
		const args = ["serve", "--port", String(this.port), "--hostname", this.config.hostname];

		// Build environment variables - filter out undefined values
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
		if (this.config.password) {
			env.OPENCODE_SERVER_PASSWORD = this.config.password;
		}
		if (this.config.username) {
			env.OPENCODE_SERVER_USERNAME = this.config.username;
		}
		// Enable YOLO mode (auto-approve all permission prompts)
		if (this.config.yolo) {
			env.OPENCODE_YOLO = "1";
			this.log("YOLO mode enabled - all permission prompts will be auto-approved");
		}

		// Spawn the server process
		this.serverProcess = Bun.spawn(["opencode", ...args], {
			cwd: workDir,
			env,
			stdout: this.config.verbose ? "inherit" : "pipe",
			stderr: this.config.verbose ? "inherit" : "pipe",
		});

		// Wait for the server to become healthy
		try {
			await this.waitForHealthy();
			this.isRunning = true;
			this.log(`OpenCode server started successfully on port ${this.port}`);
			return this.port;
		} catch (error) {
			// Clean up on failure
			await this.cleanup();
			throw error;
		}
	}

	/**
	 * Stop the OpenCode server.
	 *
	 * Gracefully shuts down the server and releases resources.
	 *
	 * @example
	 * ```typescript
	 * await executor.stopServer();
	 * ```
	 */
	async stopServer(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		this.log("Stopping OpenCode server...");

		// Try graceful shutdown via API first
		try {
			await this.disposeInstance();
		} catch {
			// Ignore errors - we'll kill the process anyway
		}

		await this.cleanup();
		this.log("OpenCode server stopped");
	}

	/**
	 * Clean up server resources.
	 */
	private async cleanup(): Promise<void> {
		// Kill the server process if it's still running
		if (this.serverProcess) {
			try {
				this.serverProcess.kill();
				// Wait for the process to exit
				await Promise.race([
					this.serverProcess.exited,
					new Promise((resolve) => setTimeout(resolve, 5000)),
				]);
			} catch {
				// Ignore errors during cleanup
			}
			this.serverProcess = null;
		}

		// Release the port
		if (this.port !== null) {
			PortManager.releasePort(this.port);
			this.port = null;
		}

		this.baseUrl = null;
		this.isRunning = false;
	}

	/**
	 * Check if the server is currently running.
	 *
	 * @returns true if the server is running
	 */
	isServerRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Get the port the server is running on.
	 *
	 * @returns The port number, or null if not running
	 */
	getPort(): number | null {
		return this.port;
	}

	/**
	 * Get the base URL of the server.
	 *
	 * @returns The base URL, or null if not running
	 */
	getBaseUrl(): string | null {
		return this.baseUrl;
	}

	/**
	 * Get the working directory of the server.
	 *
	 * @returns The working directory, or null if not running
	 */
	getWorkDir(): string | null {
		return this.workDir;
	}

	// ============================================================================
	// Health Check
	// ============================================================================

	/**
	 * Check if the server is healthy.
	 *
	 * @returns true if the server responds to health check
	 *
	 * @example
	 * ```typescript
	 * if (await executor.healthCheck()) {
	 *   console.log('Server is healthy');
	 * }
	 * ```
	 */
	async healthCheck(): Promise<boolean> {
		try {
			const response = await this.get<HealthResponse>("/global/health");
			return response.healthy === true;
		} catch {
			return false;
		}
	}

	/**
	 * Get detailed health information.
	 *
	 * @returns Health response with version information
	 */
	async getHealth(): Promise<HealthResponse> {
		return this.get<HealthResponse>("/global/health");
	}

	/**
	 * Wait for the server to become healthy.
	 */
	private async waitForHealthy(): Promise<void> {
		const startTime = Date.now();
		let retries = 0;

		while (retries < this.config.maxHealthCheckRetries) {
			// Check if the process has exited
			if (this.serverProcess && this.serverProcess.exitCode !== null) {
				let stderr = "Unknown error";
				if (
					this.serverProcess.stderr &&
					typeof this.serverProcess.stderr !== "number" &&
					"getReader" in this.serverProcess.stderr
				) {
					try {
						stderr = await new Response(this.serverProcess.stderr).text();
					} catch {
						// Ignore errors reading stderr
					}
				}
				throw new Error(`OpenCode server process exited unexpectedly: ${stderr}`);
			}

			// Try health check
			if (await this.healthCheck()) {
				return;
			}

			// Check timeout
			if (Date.now() - startTime > this.config.startupTimeout) {
				throw new Error(
					`OpenCode server failed to start within ${this.config.startupTimeout}ms`,
				);
			}

			// Wait before retrying
			await new Promise((resolve) => setTimeout(resolve, this.config.healthCheckInterval));
			retries++;
		}

		throw new Error(
			`OpenCode server failed to become healthy after ${retries} retries`,
		);
	}

	// ============================================================================
	// Session Management
	// ============================================================================

	/**
	 * Create a new session.
	 *
	 * @param options - Session creation options
	 * @returns The created session
	 *
	 * @example
	 * ```typescript
	 * const session = await executor.createSession({ title: 'My Task' });
	 * console.log(`Created session: ${session.id}`);
	 * ```
	 */
	async createSession(options?: CreateSessionOptions): Promise<Session> {
		return this.post<Session>("/session", options ?? {});
	}

	/**
	 * List all sessions.
	 *
	 * @returns Array of sessions
	 */
	async listSessions(): Promise<Session[]> {
		return this.get<Session[]>("/session");
	}

	/**
	 * Get a specific session by ID.
	 *
	 * @param sessionId - The session ID
	 * @returns The session
	 */
	async getSession(sessionId: string): Promise<Session> {
		return this.get<Session>(`/session/${sessionId}`);
	}

	/**
	 * Update a session.
	 *
	 * @param sessionId - The session ID
	 * @param options - Update options
	 * @returns The updated session
	 */
	async updateSession(sessionId: string, options: UpdateSessionOptions): Promise<Session> {
		return this.patch<Session>(`/session/${sessionId}`, options);
	}

	/**
	 * Delete a session.
	 *
	 * @param sessionId - The session ID
	 * @returns true if deleted successfully
	 */
	async deleteSession(sessionId: string): Promise<boolean> {
		return this.delete<boolean>(`/session/${sessionId}`);
	}

	/**
	 * Get child sessions of a session.
	 *
	 * @param sessionId - The parent session ID
	 * @returns Array of child sessions
	 */
	async getSessionChildren(sessionId: string): Promise<Session[]> {
		return this.get<Session[]>(`/session/${sessionId}/children`);
	}

	/**
	 * Fork a session at a specific message.
	 *
	 * @param sessionId - The session ID to fork
	 * @param options - Fork options
	 * @returns The new forked session
	 */
	async forkSession(sessionId: string, options?: ForkSessionOptions): Promise<Session> {
		return this.post<Session>(`/session/${sessionId}/fork`, options ?? {});
	}

	/**
	 * Share a session.
	 *
	 * @param sessionId - The session ID
	 * @returns The updated session with share ID
	 */
	async shareSession(sessionId: string): Promise<Session> {
		return this.post<Session>(`/session/${sessionId}/share`, {});
	}

	/**
	 * Unshare a session.
	 *
	 * @param sessionId - The session ID
	 * @returns The updated session
	 */
	async unshareSession(sessionId: string): Promise<Session> {
		return this.delete<Session>(`/session/${sessionId}/share`);
	}

	// ============================================================================
	// Message Operations
	// ============================================================================

	/**
	 * Send a message to a session and wait for the response.
	 *
	 * This is a synchronous operation that blocks until the AI responds.
	 *
	 * @param sessionId - The session ID
	 * @param prompt - The text prompt to send
	 * @param options - Additional message options. If `model` is provided as a string
	 *                  (e.g., "anthropic/claude-sonnet-4-5"), it will be parsed into
	 *                  the required `{ providerID, modelID }` format.
	 * @returns The AI's response
	 *
	 * @example
	 * ```typescript
	 * // Without model override (uses session default)
	 * const response = await executor.sendMessage(sessionId, 'Explain async/await');
	 * 
	 * // With model override
	 * const response = await executor.sendMessage(sessionId, 'Explain async/await', {
	 *   model: 'anthropic/claude-sonnet-4-5'
	 * });
	 * console.log(response.parts.map(p => p.text).join(''));
	 * ```
	 */
	async sendMessage(
		sessionId: string,
		prompt: string,
		options?: {
			messageID?: string;
			/** Model string in "providerID/modelID" format (e.g., "anthropic/claude-sonnet-4-5") */
			model?: string;
			agent?: string;
			noReply?: boolean;
			system?: string;
			tools?: string[];
		},
	): Promise<MessageResponse> {
		const parts: Part[] = [{ type: "text", text: prompt }];
		
		// Build the request body, converting model string to object if provided
		const body: Record<string, unknown> = { parts };
		
		if (options) {
			const { model, ...rest } = options;
			Object.assign(body, rest);
			
			if (model) {
				body.model = parseModelString(model);
			}
		}
		
		return this.post<MessageResponse>(`/session/${sessionId}/message`, body);
	}

	/**
	 * Send a message asynchronously (fire and forget).
	 *
	 * The message is sent but the method returns immediately without
	 * waiting for the AI's response. Use `getSessionStatus()` to poll
	 * for completion and `getMessages()` to retrieve the response.
	 *
	 * @param sessionId - The session ID
	 * @param prompt - The text prompt to send
	 * @param options - Additional message options. If `model` is provided as a string
	 *                  (e.g., "anthropic/claude-sonnet-4-5"), it will be parsed into
	 *                  the required `{ providerID, modelID }` format.
	 *
	 * @example
	 * ```typescript
	 * await executor.sendMessageAsync(sessionId, 'Long running task...', {
	 *   model: 'amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0'
	 * });
	 *
	 * // Poll for completion
	 * while ((await executor.getSessionStatus(sessionId)).status === 'running') {
	 *   await sleep(1000);
	 * }
	 *
	 * // Get the response
	 * const messages = await executor.getMessages(sessionId);
	 * ```
	 */
	async sendMessageAsync(
		sessionId: string,
		prompt: string,
		options?: {
			messageID?: string;
			/** Model string in "providerID/modelID" format (e.g., "anthropic/claude-sonnet-4-5") */
			model?: string;
			agent?: string;
			noReply?: boolean;
			system?: string;
			tools?: string[];
		},
	): Promise<void> {
		const parts: Part[] = [{ type: "text", text: prompt }];
		
		// Build the request body, converting model string to object if provided
		const body: Record<string, unknown> = { parts };
		
		if (options) {
			const { model, ...rest } = options;
			Object.assign(body, rest);
			
			if (model) {
				body.model = parseModelString(model);
			}
		}
		
		await this.post<void>(`/session/${sessionId}/prompt_async`, body);
	}

	/**
	 * Send a raw message with custom parts.
	 *
	 * @param sessionId - The session ID
	 * @param options - Full message options including parts
	 * @returns The AI's response
	 */
	async sendRawMessage(sessionId: string, options: SendMessageOptions): Promise<MessageResponse> {
		return this.post<MessageResponse>(`/session/${sessionId}/message`, options);
	}

	/**
	 * Get all messages in a session.
	 *
	 * @param sessionId - The session ID
	 * @param limit - Maximum number of messages to return
	 * @returns Array of messages with their parts
	 */
	async getMessages(sessionId: string, limit?: number): Promise<MessageResponse[]> {
		const query = limit ? `?limit=${limit}` : "";
		return this.get<MessageResponse[]>(`/session/${sessionId}/message${query}`);
	}

	/**
	 * Get a specific message by ID.
	 *
	 * @param sessionId - The session ID
	 * @param messageId - The message ID
	 * @returns The message with its parts
	 */
	async getMessage(sessionId: string, messageId: string): Promise<MessageResponse> {
		return this.get<MessageResponse>(`/session/${sessionId}/message/${messageId}`);
	}

	/**
	 * Execute a slash command.
	 *
	 * @param sessionId - The session ID
	 * @param options - Command execution options
	 * @returns The command response
	 */
	async executeCommand(sessionId: string, options: ExecuteCommandOptions): Promise<MessageResponse> {
		return this.post<MessageResponse>(`/session/${sessionId}/command`, options);
	}

	/**
	 * Run a shell command.
	 *
	 * @param sessionId - The session ID
	 * @param options - Shell command options
	 * @returns The command response
	 */
	async runShell(sessionId: string, options: RunShellOptions): Promise<MessageResponse> {
		return this.post<MessageResponse>(`/session/${sessionId}/shell`, options);
	}

	/**
	 * Revert a message.
	 *
	 * @param sessionId - The session ID
	 * @param options - Revert options
	 * @returns true if reverted successfully
	 */
	async revertMessage(sessionId: string, options: RevertMessageOptions): Promise<boolean> {
		return this.post<boolean>(`/session/${sessionId}/revert`, options);
	}

	/**
	 * Restore all reverted messages in a session.
	 *
	 * @param sessionId - The session ID
	 * @returns true if restored successfully
	 */
	async unrevertMessages(sessionId: string): Promise<boolean> {
		return this.post<boolean>(`/session/${sessionId}/unrevert`, {});
	}

	// ============================================================================
	// Status and Control
	// ============================================================================

	/**
	 * Get the status of all sessions.
	 *
	 * @returns Map of session IDs to their status
	 */
	async getAllSessionStatus(): Promise<SessionStatusMap> {
		return this.get<SessionStatusMap>("/session/status");
	}

	/**
	 * Get the status of a specific session.
	 *
	 * @param sessionId - The session ID
	 * @returns The session status
	 */
	async getSessionStatus(sessionId: string): Promise<SessionStatus> {
		const statusMap = await this.getAllSessionStatus();
		const status = statusMap[sessionId];
		if (!status) {
			return { status: "idle" };
		}
		return status;
	}

	/**
	 * Abort a running session.
	 *
	 * @param sessionId - The session ID
	 * @returns true if aborted successfully
	 *
	 * @example
	 * ```typescript
	 * // Abort a long-running task
	 * await executor.abortSession(sessionId);
	 * ```
	 */
	async abortSession(sessionId: string): Promise<boolean> {
		return this.post<boolean>(`/session/${sessionId}/abort`, {});
	}

	/**
	 * Summarize a session.
	 *
	 * @param sessionId - The session ID
	 * @param options - Summarization options
	 * @returns true if summarization started
	 */
	async summarizeSession(sessionId: string, options: SummarizeOptions): Promise<boolean> {
		return this.post<boolean>(`/session/${sessionId}/summarize`, options);
	}

	/**
	 * Initialize a session (create AGENTS.md).
	 *
	 * @param sessionId - The session ID
	 * @param options - Initialization options
	 * @returns true if initialization started
	 */
	async initSession(sessionId: string, options: InitSessionOptions): Promise<boolean> {
		return this.post<boolean>(`/session/${sessionId}/init`, options);
	}

	// ============================================================================
	// Session Data
	// ============================================================================

	/**
	 * Get the file diff for a session.
	 *
	 * Returns all file changes made during the session.
	 *
	 * @param sessionId - The session ID
	 * @param messageId - Optional message ID to get diff up to
	 * @returns Array of file diffs
	 *
	 * @example
	 * ```typescript
	 * const diffs = await executor.getSessionDiff(sessionId);
	 * for (const diff of diffs) {
	 *   console.log(`${diff.path}: +${diff.additions} -${diff.deletions}`);
	 * }
	 * ```
	 */
	async getSessionDiff(sessionId: string, messageId?: string): Promise<FileDiff[]> {
		const query = messageId ? `?messageID=${messageId}` : "";
		return this.get<FileDiff[]>(`/session/${sessionId}/diff${query}`);
	}

	/**
	 * Get the todo list for a session.
	 *
	 * Returns the agent's task list for the session.
	 *
	 * @param sessionId - The session ID
	 * @returns Array of todo items
	 *
	 * @example
	 * ```typescript
	 * const todos = await executor.getSessionTodo(sessionId);
	 * const completed = todos.filter(t => t.completed).length;
	 * console.log(`Progress: ${completed}/${todos.length}`);
	 * ```
	 */
	async getSessionTodo(sessionId: string): Promise<Todo[]> {
		return this.get<Todo[]>(`/session/${sessionId}/todo`);
	}

	// ============================================================================
	// Instance Control
	// ============================================================================

	/**
	 * Dispose the server instance.
	 *
	 * This triggers a graceful shutdown of the server.
	 *
	 * @returns true if disposed successfully
	 */
	async disposeInstance(): Promise<boolean> {
		return this.post<boolean>("/instance/dispose", {});
	}

	// ============================================================================
	// Installation
	// ============================================================================

	/**
	 * Ensure OpenCode is installed.
	 *
	 * @throws Error if OpenCode is not installed and auto-install fails
	 */
	private async ensureInstalled(): Promise<void> {
		const result = await ensureOpencodeInstalled({
			autoInstall: this.config.autoInstall,
			minVersion: this.config.minVersion,
			verbose: this.config.verbose,
		});

		if (!result.installed) {
			throw new Error(result.error ?? "OpenCode is not installed");
		}

		if (result.installedNow) {
			this.log(`OpenCode ${result.version} installed via ${result.method}`);
		}
	}

	// ============================================================================
	// HTTP Client
	// ============================================================================

	/**
	 * Make a GET request to the server.
	 */
	private async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	/**
	 * Make a POST request to the server.
	 */
	private async post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	/**
	 * Make a PATCH request to the server.
	 */
	private async patch<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("PATCH", path, body);
	}

	/**
	 * Make a DELETE request to the server.
	 */
	private async delete<T>(path: string): Promise<T> {
		return this.request<T>("DELETE", path);
	}

	/**
	 * Make an HTTP request to the server.
	 */
	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		if (!this.baseUrl) {
			throw new Error("Server is not running. Call startServer() first.");
		}

		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		// Add basic auth if configured
		if (this.config.password) {
			const username = this.config.username ?? "opencode";
			const credentials = Buffer.from(`${username}:${this.config.password}`).toString("base64");
			headers.Authorization = `Basic ${credentials}`;
		}

		// Create abort controller for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort();
		}, this.config.requestTimeout);

		const options: RequestInit = {
			method,
			headers,
			signal: controller.signal,
		};

		if (body !== undefined) {
			options.body = JSON.stringify(body);
		}

		try {
			const response = await fetch(url, options);

			// Handle 204 No Content
			if (response.status === 204) {
				return undefined as T;
			}

			// Handle errors
			if (!response.ok) {
				const errorText = await response.text();
				let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.message ?? errorMessage;
				} catch {
					if (errorText) {
						errorMessage = errorText;
					}
				}
				throw new Error(errorMessage);
			}

			// Parse JSON response
			const text = await response.text();
			if (!text) {
				return undefined as T;
			}

			try {
				return JSON.parse(text) as T;
			} catch {
				throw new Error(`Invalid JSON response: ${text}`);
			}
		} catch (error) {
			// Handle abort/timeout errors
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`The operation timed out.`);
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ============================================================================
	// Logging
	// ============================================================================

	/**
	 * Log a message if verbose mode is enabled.
	 */
	private log(message: string): void {
		if (this.config.verbose) {
			logger.info(`[OpenCode] ${message}`);
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new OpenCode server executor with default configuration.
 *
 * @param config - Optional configuration overrides
 * @returns A new server executor instance
 *
 * @example
 * ```typescript
 * const executor = createOpencodeExecutor({ verbose: true });
 * ```
 */
export function createOpencodeExecutor(config?: OpencodeServerConfig): OpencodeServerExecutor {
	return new OpencodeServerExecutor(config);
}
