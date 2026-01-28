/**
 * @fileoverview Binary Resolver
 *
 * Resolves the appropriate compiled binary for the current platform.
 * Handles platform detection and binary path construction.
 *
 * @module platform/binary-resolver
 * @since 4.4.0
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	BinaryResolutionResult,
	BinaryResolverOptions,
	NodeArch,
	NodePlatform,
	PlatformConfig,
	SupportedArch,
	SupportedPlatform,
} from "./types.ts";

/**
 * Map Node.js platform names to our standardized names
 */
const PLATFORM_MAP: Record<NodePlatform, SupportedPlatform> = {
	darwin: "darwin",
	linux: "linux",
	win32: "windows",
};

/**
 * Map Node.js architecture names to our standardized names
 */
const ARCH_MAP: Record<NodeArch, SupportedArch> = {
	arm64: "arm64",
	aarch64: "arm64",
	x64: "x64",
	amd64: "x64",
};

/**
 * Detect the current platform configuration
 *
 * @returns Platform configuration for the current system
 */
export function detectPlatform(): PlatformConfig {
	const nodePlatform = process.platform as NodePlatform;
	const nodeArch = process.arch as NodeArch;

	const platform = PLATFORM_MAP[nodePlatform];
	const arch = ARCH_MAP[nodeArch];

	return {
		platform: platform ?? ("unknown" as SupportedPlatform),
		arch: arch ?? ("unknown" as SupportedArch),
		executableExtension: nodePlatform === "win32" ? ".exe" : "",
		isWindows: nodePlatform === "win32",
	};
}

/**
 * Check if the current platform is supported
 *
 * @param config - Platform configuration to check
 * @returns Whether the platform is supported
 */
export function isPlatformSupported(config: PlatformConfig): boolean {
	const validPlatforms: SupportedPlatform[] = ["darwin", "linux", "windows"];
	const validArchs: SupportedArch[] = ["arm64", "x64"];

	return validPlatforms.includes(config.platform) && validArchs.includes(config.arch);
}

/**
 * Construct the binary filename for a given platform
 *
 * @param prefix - Binary name prefix (e.g., "milhouse")
 * @param config - Platform configuration
 * @returns Binary filename (e.g., "milhouse-darwin-arm64")
 */
export function constructBinaryName(prefix: string, config: PlatformConfig): string {
	return `${prefix}-${config.platform}-${config.arch}${config.executableExtension}`;
}

/**
 * Resolve the path to the compiled binary
 *
 * @param options - Resolution options
 * @returns Resolution result with path if found
 */
export function resolveBinary(options: BinaryResolverOptions): BinaryResolutionResult {
	const platform = detectPlatform();

	// Check if platform is supported
	if (!isPlatformSupported(platform)) {
		return {
			found: false,
			platform,
			error: `Unsupported platform: ${platform.platform}-${platform.arch}`,
		};
	}

	// Construct the binary path
	const binaryName = constructBinaryName(options.binaryPrefix, platform);
	const binaryPath = join(options.baseDirectory, options.distDirectory, binaryName);

	// Check if binary exists
	if (!existsSync(binaryPath)) {
		return {
			found: false,
			platform,
			error: `Binary not found: ${binaryPath}`,
		};
	}

	return {
		found: true,
		path: binaryPath,
		platform,
	};
}

/**
 * Get the default binary resolver options
 *
 * @param baseDirectory - Base directory (usually __dirname from bin.js)
 * @returns Default resolver options
 */
export function getDefaultResolverOptions(baseDirectory: string): BinaryResolverOptions {
	return {
		binaryPrefix: "milhouse",
		distDirectory: "dist",
		baseDirectory,
	};
}

/**
 * Format a platform configuration for display
 *
 * @param config - Platform configuration
 * @returns Human-readable platform string
 */
export function formatPlatform(config: PlatformConfig): string {
	return `${config.platform}-${config.arch}`;
}
