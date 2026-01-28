/**
 * Custom error classes for state management
 *
 * These errors provide context-rich information for debugging
 * and proper error handling throughout the state management system.
 *
 * @module state/errors
 */

/**
 * Base class for all state-related errors
 */
export class StateError extends Error {
	/** The file path that caused the error (if applicable) */
	public readonly filePath?: string;
	/** The operation that was being performed */
	public readonly operation: string;
	/** Additional context for debugging */
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		options: {
			operation: string;
			filePath?: string;
			context?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "StateError";
		this.operation = options.operation;
		this.filePath = options.filePath;
		this.context = options.context;
	}

	/**
	 * Get a formatted error message with context
	 */
	toDetailedString(): string {
		const parts = [this.message];
		if (this.filePath) {
			parts.push(`  File: ${this.filePath}`);
		}
		parts.push(`  Operation: ${this.operation}`);
		if (this.context) {
			parts.push(`  Context: ${JSON.stringify(this.context)}`);
		}
		if (this.cause) {
			parts.push(`  Cause: ${this.cause}`);
		}
		return parts.join("\n");
	}
}

/**
 * Error thrown when JSON parsing fails for a state file
 *
 * This typically occurs when:
 * - The file contains invalid JSON syntax
 * - The file is corrupted
 * - The file encoding is incorrect
 */
export class StateParseError extends StateError {
	/** The raw content that failed to parse (truncated for safety) */
	public readonly rawContent?: string;

	constructor(
		message: string,
		options: {
			filePath: string;
			rawContent?: string;
			cause?: Error;
		},
	) {
		super(message, {
			operation: "parse",
			filePath: options.filePath,
			cause: options.cause,
		});
		this.name = "StateParseError";
		// Truncate raw content to avoid huge error messages
		this.rawContent = options.rawContent?.slice(0, 500);
	}
}

/**
 * Error thrown when a file lock cannot be acquired
 *
 * This typically occurs when:
 * - Another process holds the lock
 * - Lock timeout is exceeded
 * - File system permissions prevent locking
 */
export class StateLockError extends StateError {
	/** The lock file path */
	public readonly lockPath?: string;
	/** How long we waited for the lock (ms) */
	public readonly waitTimeMs?: number;

	constructor(
		message: string,
		options: {
			filePath: string;
			lockPath?: string;
			waitTimeMs?: number;
			cause?: Error;
		},
	) {
		super(message, {
			operation: "lock",
			filePath: options.filePath,
			context: {
				lockPath: options.lockPath,
				waitTimeMs: options.waitTimeMs,
			},
			cause: options.cause,
		});
		this.name = "StateLockError";
		this.lockPath = options.lockPath;
		this.waitTimeMs = options.waitTimeMs;
	}
}

/**
 * Error thrown when a required state file is not found
 *
 * This typically occurs when:
 * - The file has not been created yet
 * - The file was deleted
 * - The path is incorrect
 */
export class StateNotFoundError extends StateError {
	/** Expected file type (e.g., "issues", "tasks", "run-meta") */
	public readonly fileType?: string;

	constructor(
		message: string,
		options: {
			filePath: string;
			fileType?: string;
		},
	) {
		super(message, {
			operation: "read",
			filePath: options.filePath,
			context: { fileType: options.fileType },
		});
		this.name = "StateNotFoundError";
		this.fileType = options.fileType;
	}
}

/**
 * Error thrown when schema validation fails
 *
 * This typically occurs when:
 * - The JSON structure doesn't match the expected schema
 * - Required fields are missing
 * - Field types are incorrect
 */
export class StateValidationError extends StateError {
	/** The validation errors from Zod or similar */
	public readonly validationErrors?: string[];

	constructor(
		message: string,
		options: {
			filePath: string;
			validationErrors?: string[];
			cause?: Error;
		},
	) {
		super(message, {
			operation: "validate",
			filePath: options.filePath,
			context: { validationErrors: options.validationErrors },
			cause: options.cause,
		});
		this.name = "StateValidationError";
		this.validationErrors = options.validationErrors;
	}
}

/**
 * Error thrown when a write operation fails
 *
 * This typically occurs when:
 * - Disk is full
 * - Permission denied
 * - Directory doesn't exist
 */
export class StateWriteError extends StateError {
	constructor(
		message: string,
		options: {
			filePath: string;
			cause?: Error;
		},
	) {
		super(message, {
			operation: "write",
			filePath: options.filePath,
			cause: options.cause,
		});
		this.name = "StateWriteError";
	}
}

/**
 * Log a state error with context (non-throwing)
 *
 * Use this for recoverable errors where you want to log but continue.
 *
 * @param error - The error to log
 * @param level - Log level ("debug" | "warn" | "error")
 */
export function logStateError(
	error: StateError | Error,
	level: "debug" | "warn" | "error" = "warn",
): void {
	const message =
		error instanceof StateError ? error.toDetailedString() : error.message;

	// Use console for now - can be replaced with proper logger
	switch (level) {
		case "debug":
			console.debug(`[STATE DEBUG] ${message}`);
			break;
		case "warn":
			console.warn(`[STATE WARN] ${message}`);
			break;
		case "error":
			console.error(`[STATE ERROR] ${message}`);
			break;
	}
}
