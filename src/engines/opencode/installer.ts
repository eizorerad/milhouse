/**
 * OpenCode Auto-Installation Module
 *
 * Provides automatic detection and installation of OpenCode CLI.
 * Supports multiple installation methods across different platforms.
 *
 * @see https://opencode.ai/docs
 */

import { logger } from "../../observability/logger";

/**
 * Supported installation methods for OpenCode.
 */
export type InstallMethod =
	| "curl"
	| "npm"
	| "bun"
	| "pnpm"
	| "yarn"
	| "homebrew"
	| "aur"
	| "scoop"
	| "choco"
	| "mise"
	| "docker";

/**
 * Result of an installation attempt.
 */
export interface InstallResult {
	/** Whether the installation was successful */
	success: boolean;
	/** The installation method used */
	method: InstallMethod;
	/** The installed version (if successful) */
	version?: string;
	/** Error message (if failed) */
	error?: string;
}

/**
 * Options for the installer.
 */
export interface InstallerOptions {
	/** Minimum required version of OpenCode */
	minVersion?: string;
	/** Preferred installation method */
	preferredMethod?: InstallMethod;
	/** Whether to show installation progress */
	verbose?: boolean;
}

/**
 * Default minimum version requirement.
 * Based on OpenCode Server API requirements.
 */
const DEFAULT_MIN_VERSION = "0.1.48";

/**
 * OpenCode Installer class.
 *
 * Handles detection, version checking, and installation of OpenCode CLI.
 *
 * @example
 * ```typescript
 * const installer = new OpencodeInstaller();
 *
 * // Check if installed
 * if (!await installer.isInstalled()) {
 *   // Install using best available method
 *   const result = await installer.install();
 *   if (result.success) {
 *     console.log(`Installed OpenCode ${result.version} via ${result.method}`);
 *   }
 * }
 * ```
 */
export class OpencodeInstaller {
	private options: InstallerOptions;

	constructor(options: InstallerOptions = {}) {
		this.options = {
			minVersion: DEFAULT_MIN_VERSION,
			verbose: false,
			...options,
		};
	}

	/**
	 * Check if OpenCode is installed and accessible.
	 *
	 * @returns true if OpenCode CLI is available in PATH
	 */
	async isInstalled(): Promise<boolean> {
		try {
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";

			const proc = Bun.spawn([checkCommand, "opencode"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Get the installed OpenCode version.
	 *
	 * @returns Version string (e.g., "0.1.48") or null if not installed
	 */
	async getVersion(): Promise<string | null> {
		try {
			const proc = Bun.spawn(["opencode", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;

			if (exitCode === 0) {
				const output = await new Response(proc.stdout).text();
				// Parse version from output - OpenCode outputs version in format "opencode vX.Y.Z" or just "X.Y.Z"
				const match = output.match(/v?(\d+\.\d+\.\d+)/);
				return match ? match[1] : null;
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Compare two semantic versions.
	 *
	 * @param version - Version to check
	 * @param minimum - Minimum required version
	 * @returns true if version >= minimum
	 */
	meetsMinimumVersion(version: string, minimum?: string): boolean {
		const minVersion = minimum ?? this.options.minVersion ?? DEFAULT_MIN_VERSION;

		const parseVersion = (v: string): number[] => {
			const parts = v.split(".").map(Number);
			// Ensure we have at least 3 parts
			while (parts.length < 3) {
				parts.push(0);
			}
			return parts;
		};

		const [major, minor, patch] = parseVersion(version);
		const [minMajor, minMinor, minPatch] = parseVersion(minVersion);

		if (major !== minMajor) return major > minMajor;
		if (minor !== minMinor) return minor > minMinor;
		return patch >= minPatch;
	}

	/**
	 * Detect the best installation method for the current platform.
	 *
	 * Priority order:
	 * 1. Bun (preferred for this project)
	 * 2. pnpm
	 * 3. npm
	 * 4. Homebrew (macOS/Linux)
	 * 5. AUR (Arch Linux)
	 * 6. Scoop/Chocolatey (Windows)
	 * 7. curl (universal fallback)
	 *
	 * @returns The best available installation method
	 */
	async detectBestMethod(): Promise<InstallMethod> {
		// If user specified a preferred method, check if it's available
		if (this.options.preferredMethod) {
			const isAvailable = await this.isMethodAvailable(this.options.preferredMethod);
			if (isAvailable) {
				return this.options.preferredMethod;
			}
			this.log(
				`Preferred method '${this.options.preferredMethod}' not available, detecting best alternative...`,
			);
		}

		const platform = process.platform;

		// Check for Bun (preferred for this project)
		if (await this.isCommandAvailable("bun")) {
			return "bun";
		}

		// Check for pnpm
		if (await this.isCommandAvailable("pnpm")) {
			return "pnpm";
		}

		// Check for npm
		if (await this.isCommandAvailable("npm")) {
			return "npm";
		}

		// Check for yarn
		if (await this.isCommandAvailable("yarn")) {
			return "yarn";
		}

		// Platform-specific package managers
		if (platform === "darwin" || platform === "linux") {
			// Check for Homebrew
			if (await this.isCommandAvailable("brew")) {
				return "homebrew";
			}
		}

		if (platform === "linux") {
			// Check for AUR helpers (Arch Linux)
			if (await this.isCommandAvailable("paru")) {
				return "aur";
			}
			if (await this.isCommandAvailable("yay")) {
				return "aur";
			}
		}

		if (platform === "win32") {
			// Check for Scoop
			if (await this.isCommandAvailable("scoop")) {
				return "scoop";
			}
			// Check for Chocolatey
			if (await this.isCommandAvailable("choco")) {
				return "choco";
			}
		}

		// Check for mise (cross-platform)
		if (await this.isCommandAvailable("mise")) {
			return "mise";
		}

		// Default to curl (works everywhere with bash)
		return "curl";
	}

	/**
	 * Install OpenCode using the specified or auto-detected method.
	 *
	 * @param method - Installation method to use (auto-detected if not specified)
	 * @returns Installation result
	 */
	async install(method?: InstallMethod): Promise<InstallResult> {
		const installMethod = method ?? (await this.detectBestMethod());

		this.log(`Installing OpenCode via ${installMethod}...`);

		try {
			switch (installMethod) {
				case "curl":
					return await this.installViaCurl();
				case "npm":
					return await this.installViaNpm();
				case "bun":
					return await this.installViaBun();
				case "pnpm":
					return await this.installViaPnpm();
				case "yarn":
					return await this.installViaYarn();
				case "homebrew":
					return await this.installViaHomebrew();
				case "aur":
					return await this.installViaAur();
				case "scoop":
					return await this.installViaScoop();
				case "choco":
					return await this.installViaChoco();
				case "mise":
					return await this.installViaMise();
				case "docker":
					return {
						success: false,
						method: "docker",
						error:
							"Docker installation is not supported for CLI usage. Use another method.",
					};
				default:
					return {
						success: false,
						method: installMethod,
						error: `Unknown installation method: ${installMethod}`,
					};
			}
		} catch (error) {
			return {
				success: false,
				method: installMethod,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Install OpenCode via curl (universal method).
	 *
	 * Command: `curl -fsSL https://opencode.ai/install | bash`
	 */
	private async installViaCurl(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via curl...");

		const proc = Bun.spawn(["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via curl`);
			return { success: true, method: "curl", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "curl",
			error: `Installation script failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via npm.
	 *
	 * Command: `npm install -g opencode-ai`
	 */
	private async installViaNpm(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via npm...");

		const proc = Bun.spawn(["npm", "install", "-g", "opencode-ai"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via npm`);
			return { success: true, method: "npm", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "npm",
			error: `npm installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Bun.
	 *
	 * Command: `bun install -g opencode-ai`
	 */
	private async installViaBun(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via bun...");

		const proc = Bun.spawn(["bun", "install", "-g", "opencode-ai"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via bun`);
			return { success: true, method: "bun", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "bun",
			error: `bun installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via pnpm.
	 *
	 * Command: `pnpm install -g opencode-ai`
	 */
	private async installViaPnpm(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via pnpm...");

		const proc = Bun.spawn(["pnpm", "install", "-g", "opencode-ai"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via pnpm`);
			return { success: true, method: "pnpm", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "pnpm",
			error: `pnpm installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Yarn.
	 *
	 * Command: `yarn global add opencode-ai`
	 */
	private async installViaYarn(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via yarn...");

		const proc = Bun.spawn(["yarn", "global", "add", "opencode-ai"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via yarn`);
			return { success: true, method: "yarn", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "yarn",
			error: `yarn installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Homebrew.
	 *
	 * Command: `brew install anomalyco/tap/opencode`
	 *
	 * Note: Uses the official OpenCode tap for the most up-to-date releases.
	 */
	private async installViaHomebrew(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via Homebrew...");

		const proc = Bun.spawn(["brew", "install", "anomalyco/tap/opencode"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via Homebrew`);
			return { success: true, method: "homebrew", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "homebrew",
			error: `Homebrew installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via AUR (Arch Linux).
	 *
	 * Command: `paru -S --noconfirm opencode-bin` or `yay -S --noconfirm opencode-bin`
	 */
	private async installViaAur(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via AUR...");

		// Try paru first, then yay
		const aurHelper = (await this.isCommandAvailable("paru")) ? "paru" : "yay";

		const proc = Bun.spawn([aurHelper, "-S", "--noconfirm", "opencode-bin"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via AUR`);
			return { success: true, method: "aur", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "aur",
			error: `AUR installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Scoop (Windows).
	 *
	 * Command: `scoop install opencode`
	 */
	private async installViaScoop(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via Scoop...");

		const proc = Bun.spawn(["scoop", "install", "opencode"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via Scoop`);
			return { success: true, method: "scoop", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "scoop",
			error: `Scoop installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Chocolatey (Windows).
	 *
	 * Command: `choco install opencode -y`
	 */
	private async installViaChoco(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via Chocolatey...");

		const proc = Bun.spawn(["choco", "install", "opencode", "-y"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via Chocolatey`);
			return { success: true, method: "choco", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "choco",
			error: `Chocolatey installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install OpenCode via Mise.
	 *
	 * Command: `mise use -g github:anomalyco/opencode`
	 */
	private async installViaMise(): Promise<InstallResult> {
		this.log("📦 Installing OpenCode via mise...");

		const proc = Bun.spawn(["mise", "use", "-g", "github:anomalyco/opencode"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ OpenCode ${version ?? "unknown"} installed successfully via mise`);
			return { success: true, method: "mise", version: version ?? undefined };
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "mise",
			error: `mise installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Check if a command is available in PATH.
	 */
	private async isCommandAvailable(command: string): Promise<boolean> {
		try {
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";

			const proc = Bun.spawn([checkCommand, command], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Check if a specific installation method is available.
	 */
	private async isMethodAvailable(method: InstallMethod): Promise<boolean> {
		switch (method) {
			case "curl":
				return (
					(await this.isCommandAvailable("curl")) &&
					(await this.isCommandAvailable("bash"))
				);
			case "npm":
				return await this.isCommandAvailable("npm");
			case "bun":
				return await this.isCommandAvailable("bun");
			case "pnpm":
				return await this.isCommandAvailable("pnpm");
			case "yarn":
				return await this.isCommandAvailable("yarn");
			case "homebrew":
				return await this.isCommandAvailable("brew");
			case "aur":
				return (
					(await this.isCommandAvailable("paru")) ||
					(await this.isCommandAvailable("yay"))
				);
			case "scoop":
				return await this.isCommandAvailable("scoop");
			case "choco":
				return await this.isCommandAvailable("choco");
			case "mise":
				return await this.isCommandAvailable("mise");
			case "docker":
				return await this.isCommandAvailable("docker");
			default:
				return false;
		}
	}

	/**
	 * Log a message if verbose mode is enabled.
	 */
	private log(message: string): void {
		if (this.options.verbose) {
			logger.info(message);
		}
	}
}

/**
 * Ensure OpenCode is installed, optionally installing it automatically.
 *
 * @param options - Installation options
 * @returns Object with installation status and version
 *
 * @example
 * ```typescript
 * const { installed, version } = await ensureOpencodeInstalled({
 *   autoInstall: true,
 *   minVersion: '0.1.48',
 * });
 *
 * if (!installed) {
 *   throw new Error('OpenCode installation failed');
 * }
 * ```
 */
export async function ensureOpencodeInstalled(options: {
	autoInstall?: boolean;
	minVersion?: string;
	preferredMethod?: InstallMethod;
	verbose?: boolean;
}): Promise<{
	installed: boolean;
	version: string | null;
	installedNow: boolean;
	method?: InstallMethod;
	error?: string;
}> {
	const installer = new OpencodeInstaller({
		minVersion: options.minVersion,
		preferredMethod: options.preferredMethod,
		verbose: options.verbose,
	});

	// Check if already installed
	const isInstalled = await installer.isInstalled();

	if (isInstalled) {
		const version = await installer.getVersion();
		const minVersion = options.minVersion ?? DEFAULT_MIN_VERSION;

		if (version && !installer.meetsMinimumVersion(version, minVersion)) {
			logger.warn(
				`OpenCode version ${version} is below minimum ${minVersion}. Some features may not work correctly.`,
			);
		}

		return {
			installed: true,
			version,
			installedNow: false,
		};
	}

	// Not installed - try to install if autoInstall is enabled
	if (options.autoInstall) {
		logger.info("⚠️  OpenCode not found. Installing automatically...");

		const result = await installer.install(options.preferredMethod);

		if (result.success) {
			logger.info(`✅ OpenCode ${result.version ?? "unknown"} installed via ${result.method}`);
			return {
				installed: true,
				version: result.version ?? null,
				installedNow: true,
				method: result.method,
			};
		}

		return {
			installed: false,
			version: null,
			installedNow: false,
			error: result.error,
		};
	}

	// Not installed and autoInstall is disabled
	return {
		installed: false,
		version: null,
		installedNow: false,
		error:
			"OpenCode is not installed. Install it with:\n" +
			"  curl -fsSL https://opencode.ai/install | bash\n" +
			"Or run with --auto-install flag.",
	};
}

/**
 * Get installation instructions for OpenCode.
 *
 * @returns Formatted installation instructions string
 */
export function getInstallationInstructions(): string {
	const platform = process.platform;

	let instructions = `
OpenCode Installation Instructions
==================================

Universal (recommended):
  curl -fsSL https://opencode.ai/install | bash

Using Node.js package managers:
  npm install -g opencode-ai
  bun install -g opencode-ai
  pnpm install -g opencode-ai
  yarn global add opencode-ai
`;

	if (platform === "darwin") {
		instructions += `
macOS (Homebrew):
  brew install anomalyco/tap/opencode
`;
	}

	if (platform === "linux") {
		instructions += `
Linux (Homebrew):
  brew install anomalyco/tap/opencode

Arch Linux (AUR):
  paru -S opencode-bin
`;
	}

	if (platform === "win32") {
		instructions += `
Windows (Scoop):
  scoop install opencode

Windows (Chocolatey):
  choco install opencode
`;
	}

	instructions += `
For more information, visit: https://opencode.ai/docs
`;

	return instructions;
}
