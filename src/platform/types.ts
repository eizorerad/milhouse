/**
 * @fileoverview Platform Types
 *
 * Type definitions for platform detection and binary resolution.
 * These types enable cross-platform support for the Milhouse CLI.
 *
 * @module platform/types
 * @since 4.4.0
 */

/**
 * Supported operating systems
 */
export type SupportedPlatform = "darwin" | "linux" | "windows";

/**
 * Supported CPU architectures
 */
export type SupportedArch = "arm64" | "x64";

/**
 * Node.js process.platform values mapped to our platform names
 */
export type NodePlatform = "darwin" | "linux" | "win32";

/**
 * Node.js process.arch values mapped to our arch names
 */
export type NodeArch = "arm64" | "aarch64" | "x64" | "amd64";

/**
 * Platform configuration for binary resolution
 */
export interface PlatformConfig {
	/** Operating system name */
	platform: SupportedPlatform;
	/** CPU architecture */
	arch: SupportedArch;
	/** File extension for executables */
	executableExtension: string;
	/** Whether this is a Windows system */
	isWindows: boolean;
}

/**
 * Binary resolution options
 */
export interface BinaryResolverOptions {
	/** Base name prefix for the binary (e.g., "milhouse") */
	binaryPrefix: string;
	/** Directory containing compiled binaries */
	distDirectory: string;
	/** Base directory for resolution (usually __dirname) */
	baseDirectory: string;
}

/**
 * Result of binary resolution
 */
export interface BinaryResolutionResult {
	/** Whether a binary was found */
	found: boolean;
	/** Full path to the binary (if found) */
	path?: string;
	/** Platform configuration used */
	platform: PlatformConfig;
	/** Error message if resolution failed */
	error?: string;
}

/**
 * Runner options for executing the CLI
 */
export interface RunnerOptions {
	/** Path to compiled binary (if available) */
	compiledBinaryPath?: string;
	/** Path to TypeScript entry point for dev mode */
	devEntryPath: string;
	/** Command line arguments to pass */
	argv: string[];
	/** Working directory for execution */
	cwd: string;
	/** Platform configuration */
	platform: PlatformConfig;
}

/**
 * Result of runner execution
 */
export interface RunnerResult {
	/** Exit code from the process */
	exitCode: number;
	/** Whether execution was successful */
	success: boolean;
	/** Which runner was used */
	runner: "compiled" | "bun" | "tsx" | "none";
	/** Error message if execution failed */
	error?: string;
}

/**
 * Available runtime environments for development mode
 */
export type RuntimeEnvironment = "bun" | "tsx";

/**
 * Cached runtime availability check results
 */
export interface RuntimeCache {
	/** Cached results for runtime availability */
	available: Map<RuntimeEnvironment, boolean>;
	/** Timestamp of last check */
	lastChecked: number;
	/** Cache validity duration in milliseconds */
	cacheDuration: number;
}
