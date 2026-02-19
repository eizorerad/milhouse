/**
 * Tmux Auto-Installation Module
 *
 * Provides automatic detection and installation of tmux.
 * Supports multiple installation methods across different platforms.
 *
 * @see docs/tmux-installer-design.md
 */

import { logger } from "../../observability/logger";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported installation methods for tmux.
 * Unlike OpenCode which has many npm-based options, tmux requires
 * system package managers.
 */
export type TmuxInstallMethod =
	| "homebrew" // macOS and Linux with Homebrew
	| "apt" // Debian, Ubuntu, and derivatives
	| "dnf" // Fedora, RHEL 8+, CentOS Stream
	| "yum" // RHEL 7, CentOS 7, older Fedora
	| "pacman" // Arch Linux and derivatives
	| "zypper" // openSUSE
	| "apk" // Alpine Linux
	| "manual"; // Manual installation (Windows/unsupported)

/**
 * Detected Linux distribution type.
 */
export type LinuxDistro =
	| "debian"
	| "ubuntu"
	| "fedora"
	| "rhel"
	| "centos"
	| "arch"
	| "manjaro"
	| "opensuse"
	| "alpine"
	| "unknown";

/**
 * Detailed Linux distribution information.
 */
export interface LinuxDistroInfo {
	/** Distribution ID from /etc/os-release */
	id: string;
	/** Distribution name */
	name: string;
	/** Version ID */
	versionId?: string;
	/** ID_LIKE field - parent distributions */
	idLike?: string[];
}

/**
 * Result of a tmux installation attempt.
 */
export interface TmuxInstallResult {
	/** Whether the installation was successful */
	success: boolean;
	/** The installation method used */
	method?: TmuxInstallMethod;
	/** The installed version, if successful */
	version?: string;
	/** Error message, if failed */
	error?: string;
	/** Whether sudo was required */
	requiresSudo?: boolean;
}

/**
 * Options for the TmuxInstaller.
 */
export interface TmuxInstallerOptions {
	/** Whether to automatically install if not found */
	autoInstall?: boolean;
	/** Whether to show installation progress */
	verbose?: boolean;
	/** Preferred installation method - will be tried first if available */
	preferredMethod?: TmuxInstallMethod;
	/** Skip sudo check - useful for containers running as root */
	skipSudoCheck?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Mapping of Linux distribution IDs to package managers.
 */
const DISTRO_PACKAGE_MANAGERS: Record<string, TmuxInstallMethod> = {
	// Debian family
	debian: "apt",
	ubuntu: "apt",
	linuxmint: "apt",
	pop: "apt",
	elementary: "apt",
	zorin: "apt",

	// Red Hat family
	fedora: "dnf",
	rhel: "dnf",
	centos: "dnf",
	rocky: "dnf",
	alma: "dnf",

	// Arch family
	arch: "pacman",
	manjaro: "pacman",
	endeavouros: "pacman",
	garuda: "pacman",

	// SUSE family
	opensuse: "zypper",
	"opensuse-leap": "zypper",
	"opensuse-tumbleweed": "zypper",

	// Alpine
	alpine: "apk",
};

// ============================================================================
// TmuxInstaller Class
// ============================================================================

/**
 * TmuxInstaller class.
 *
 * Handles detection, version checking, and installation of tmux.
 * Unlike npm packages, tmux requires system package managers and
 * typically needs sudo privileges on Linux.
 *
 * @example
 * ```typescript
 * const installer = new TmuxInstaller({ verbose: true });
 *
 * if (!await installer.isInstalled()) {
 *   const result = await installer.install();
 *   if (result.success) {
 *     console.log(`Installed tmux ${result.version} via ${result.method}`);
 *   }
 * }
 * ```
 */
export class TmuxInstaller {
	private options: TmuxInstallerOptions;

	constructor(options: TmuxInstallerOptions = {}) {
		this.options = {
			autoInstall: false,
			verbose: false,
			skipSudoCheck: false,
			...options,
		};
	}

	// ============================================================================
	// Detection Methods
	// ============================================================================

	/**
	 * Check if tmux is installed and accessible.
	 * Uses 'which' on Unix-like systems and 'where' on Windows.
	 *
	 * @returns true if tmux is available in PATH
	 */
	async isInstalled(): Promise<boolean> {
		try {
			const isWindows = process.platform === "win32";
			const checkCommand = isWindows ? "where" : "which";

			const proc = Bun.spawn([checkCommand, "tmux"], {
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
	 * Get the installed tmux version.
	 * Parses output from 'tmux -V' which returns "tmux X.Y".
	 *
	 * @returns Version string like "3.4" or null if not installed
	 */
	async getVersion(): Promise<string | null> {
		try {
			const proc = Bun.spawn(["tmux", "-V"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;

			if (exitCode === 0) {
				const output = await new Response(proc.stdout).text();
				// Parse version from output - tmux outputs "tmux X.Y" or "tmux X.Ya"
				const match = output.match(/tmux\s+(\d+\.\d+[a-z]?)/i);
				return match ? match[1] : null;
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Detect the current Linux distribution.
	 * Parses /etc/os-release to identify the distro.
	 *
	 * @returns LinuxDistro type or "unknown" if detection fails
	 */
	async detectLinuxDistro(): Promise<LinuxDistro> {
		if (process.platform !== "linux") {
			return "unknown";
		}

		const distroInfo = await this.getLinuxDistroInfo();
		if (!distroInfo) {
			return "unknown";
		}

		// Direct match
		const knownDistros: LinuxDistro[] = [
			"debian",
			"ubuntu",
			"fedora",
			"rhel",
			"centos",
			"arch",
			"manjaro",
			"opensuse",
			"alpine",
		];

		if (knownDistros.includes(distroInfo.id as LinuxDistro)) {
			return distroInfo.id as LinuxDistro;
		}

		// Check ID_LIKE for derivatives
		if (distroInfo.idLike) {
			for (const like of distroInfo.idLike) {
				if (knownDistros.includes(like as LinuxDistro)) {
					return like as LinuxDistro;
				}
			}
		}

		return "unknown";
	}

	/**
	 * Get detailed Linux distribution information.
	 * Parses /etc/os-release file.
	 *
	 * @returns LinuxDistroInfo object or null if not Linux or detection fails
	 */
	async getLinuxDistroInfo(): Promise<LinuxDistroInfo | null> {
		if (process.platform !== "linux") {
			return null;
		}

		try {
			const osRelease = await Bun.file("/etc/os-release").text();
			const lines = osRelease.split("\n");
			const data: Record<string, string> = {};

			for (const line of lines) {
				const match = line.match(/^(\w+)=["']?([^"'\n]*)["']?$/);
				if (match) {
					data[match[1]] = match[2];
				}
			}

			return {
				id: data.ID?.toLowerCase() ?? "unknown",
				name: data.NAME ?? data.ID ?? "Unknown",
				versionId: data.VERSION_ID,
				idLike: data.ID_LIKE?.split(" ").map((s) => s.toLowerCase()),
			};
		} catch {
			return null;
		}
	}

	/**
	 * Check if sudo is available and the user can use it.
	 * Runs 'sudo -n true' to check for passwordless sudo.
	 *
	 * @returns true if sudo is available
	 */
	async isSudoAvailable(): Promise<boolean> {
		if (this.options.skipSudoCheck) {
			return true;
		}

		try {
			// Check if we're already root
			if (process.getuid?.() === 0) {
				return true;
			}

			// Check if sudo command exists
			const hasSudo = await this.isCommandAvailable("sudo");
			if (!hasSudo) {
				return false;
			}

			// Check if we can use sudo without password (for non-interactive use)
			const proc = Bun.spawn(["sudo", "-n", "true"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	// ============================================================================
	// Installation Method Detection
	// ============================================================================

	/**
	 * Detect the best installation method for the current platform.
	 *
	 * Priority order:
	 * 1. User's preferred method, if specified and available
	 * 2. Platform-specific package manager:
	 *    - macOS: Homebrew
	 *    - Linux: Distro-specific package manager
	 *    - Windows: Return manual (with WSL suggestion)
	 *
	 * @returns The best available installation method
	 */
	async detectBestMethod(): Promise<TmuxInstallMethod> {
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

		// Windows - tmux doesn't run natively
		if (platform === "win32") {
			return "manual";
		}

		// macOS - prefer Homebrew
		if (platform === "darwin") {
			if (await this.isCommandAvailable("brew")) {
				return "homebrew";
			}
			return "manual";
		}

		// Linux - detect distro and use appropriate package manager
		if (platform === "linux") {
			const distroInfo = await this.getLinuxDistroInfo();

			if (distroInfo) {
				// Direct match
				if (DISTRO_PACKAGE_MANAGERS[distroInfo.id]) {
					const method = DISTRO_PACKAGE_MANAGERS[distroInfo.id];
					if (await this.isMethodAvailable(method)) {
						return method;
					}
				}

				// Check ID_LIKE for derivatives
				if (distroInfo.idLike) {
					for (const like of distroInfo.idLike) {
						if (DISTRO_PACKAGE_MANAGERS[like]) {
							const method = DISTRO_PACKAGE_MANAGERS[like];
							if (await this.isMethodAvailable(method)) {
								return method;
							}
						}
					}
				}
			}

			// Fallback: try Homebrew on Linux
			if (await this.isCommandAvailable("brew")) {
				return "homebrew";
			}
		}

		return "manual";
	}

	/**
	 * Check if a specific installation method is available.
	 *
	 * @param method - The method to check
	 * @returns true if the method can be used
	 */
	async isMethodAvailable(method: TmuxInstallMethod): Promise<boolean> {
		switch (method) {
			case "homebrew":
				return await this.isCommandAvailable("brew");
			case "apt":
				return await this.isCommandAvailable("apt-get");
			case "dnf":
				return await this.isCommandAvailable("dnf");
			case "yum":
				return await this.isCommandAvailable("yum");
			case "pacman":
				return await this.isCommandAvailable("pacman");
			case "zypper":
				return await this.isCommandAvailable("zypper");
			case "apk":
				return await this.isCommandAvailable("apk");
			case "manual":
				return true; // Always available as fallback
			default:
				return false;
		}
	}

	// ============================================================================
	// Installation Methods
	// ============================================================================

	/**
	 * Install tmux using the specified or auto-detected method.
	 *
	 * @param method - Installation method, auto-detected if not specified
	 * @returns Installation result
	 */
	async install(method?: TmuxInstallMethod): Promise<TmuxInstallResult> {
		const installMethod = method ?? (await this.detectBestMethod());

		this.log(`Installing tmux via ${installMethod}...`);

		try {
			switch (installMethod) {
				case "homebrew":
					return await this.installViaHomebrew();
				case "apt":
					return await this.installViaApt();
				case "dnf":
					return await this.installViaDnf();
				case "yum":
					return await this.installViaYum();
				case "pacman":
					return await this.installViaPacman();
				case "zypper":
					return await this.installViaZypper();
				case "apk":
					return await this.installViaApk();
				case "manual":
					return this.getManualInstallResult();
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
	 * Install tmux via Homebrew.
	 *
	 * Command: `brew install tmux`
	 */
	private async installViaHomebrew(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via Homebrew...");

		const proc = Bun.spawn(["brew", "install", "tmux"], {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via Homebrew`);
			return {
				success: true,
				method: "homebrew",
				version: version ?? undefined,
				requiresSudo: false,
			};
		}

		const stderr = await new Response(proc.stderr).text();
		return {
			success: false,
			method: "homebrew",
			error: `Homebrew installation failed: ${stderr || "Unknown error"}`,
		};
	}

	/**
	 * Install tmux via apt (Debian/Ubuntu).
	 *
	 * Command: `sudo apt-get update && sudo apt-get install -y tmux`
	 */
	private async installViaApt(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via apt...");

		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;

		// First update package list
		const updateResult = await this.runWithSudo(["apt-get", "update"], needsSudo);
		if (!updateResult.success) {
			return {
				success: false,
				method: "apt",
				error: `apt-get update failed: ${updateResult.stderr || "Unknown error"}`,
				requiresSudo: needsSudo,
			};
		}

		// Then install tmux
		const installResult = await this.runWithSudo(["apt-get", "install", "-y", "tmux"], needsSudo);

		if (installResult.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via apt`);
			return {
				success: true,
				method: "apt",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "apt",
			error: `apt installation failed: ${installResult.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Install tmux via dnf (Fedora/RHEL).
	 *
	 * Command: `sudo dnf install -y tmux`
	 */
	private async installViaDnf(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via dnf...");

		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;
		const result = await this.runWithSudo(["dnf", "install", "-y", "tmux"], needsSudo);

		if (result.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via dnf`);
			return {
				success: true,
				method: "dnf",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "dnf",
			error: `dnf installation failed: ${result.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Install tmux via yum (older RHEL/CentOS).
	 *
	 * Command: `sudo yum install -y tmux`
	 */
	private async installViaYum(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via yum...");

		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;
		const result = await this.runWithSudo(["yum", "install", "-y", "tmux"], needsSudo);

		if (result.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via yum`);
			return {
				success: true,
				method: "yum",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "yum",
			error: `yum installation failed: ${result.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Install tmux via pacman (Arch Linux).
	 *
	 * Command: `sudo pacman -S --noconfirm tmux`
	 */
	private async installViaPacman(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via pacman...");

		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;
		const result = await this.runWithSudo(["pacman", "-S", "--noconfirm", "tmux"], needsSudo);

		if (result.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via pacman`);
			return {
				success: true,
				method: "pacman",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "pacman",
			error: `pacman installation failed: ${result.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Install tmux via zypper (openSUSE).
	 *
	 * Command: `sudo zypper install -y tmux`
	 */
	private async installViaZypper(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via zypper...");

		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;
		const result = await this.runWithSudo(["zypper", "install", "-y", "tmux"], needsSudo);

		if (result.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via zypper`);
			return {
				success: true,
				method: "zypper",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "zypper",
			error: `zypper installation failed: ${result.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Install tmux via apk (Alpine Linux).
	 *
	 * Command: `apk add --no-cache tmux`
	 * Note: Alpine containers often run as root, so sudo may not be needed.
	 */
	private async installViaApk(): Promise<TmuxInstallResult> {
		this.log("📦 Installing tmux via apk...");

		// Alpine containers typically run as root
		const needsSudo = !this.options.skipSudoCheck && process.getuid?.() !== 0;
		const result = await this.runWithSudo(["apk", "add", "--no-cache", "tmux"], needsSudo);

		if (result.success) {
			const version = await this.getVersion();
			this.log(`✅ tmux ${version ?? "unknown"} installed successfully via apk`);
			return {
				success: true,
				method: "apk",
				version: version ?? undefined,
				requiresSudo: needsSudo,
			};
		}

		return {
			success: false,
			method: "apk",
			error: `apk installation failed: ${result.stderr || "Unknown error"}`,
			requiresSudo: needsSudo,
		};
	}

	/**
	 * Get result for manual installation (Windows or unsupported platforms).
	 */
	private getManualInstallResult(): TmuxInstallResult {
		const platform = process.platform;

		if (platform === "win32") {
			return {
				success: false,
				method: "manual",
				error:
					"tmux is not available natively on Windows. " +
					"Please use Windows Subsystem for Linux (WSL) to run tmux.\n\n" +
					"To install WSL:\n" +
					"  wsl --install\n\n" +
					"Then install tmux inside WSL:\n" +
					"  sudo apt-get install tmux",
			};
		}

		return {
			success: false,
			method: "manual",
			error: `Could not detect a supported package manager. Please install tmux manually using your system's package manager.\n\n${getInstallationInstructions()}`,
		};
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

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
	 * Run a command with optional sudo.
	 */
	private async runWithSudo(
		command: string[],
		useSudo: boolean,
	): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
		const fullCommand = useSudo ? ["sudo", ...command] : command;

		const proc = Bun.spawn(fullCommand, {
			stdout: this.options.verbose ? "inherit" : "pipe",
			stderr: this.options.verbose ? "inherit" : "pipe",
		});

		const exitCode = await proc.exited;
		const stdout = this.options.verbose ? "" : await new Response(proc.stdout).text();
		const stderr = this.options.verbose ? "" : await new Response(proc.stderr).text();

		return {
			success: exitCode === 0,
			stdout,
			stderr,
			exitCode,
		};
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

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Ensure tmux is installed, optionally installing it automatically.
 *
 * This is the primary entry point for most use cases.
 *
 * @param options - Installation options
 * @returns Object with installation status and version
 *
 * @example
 * ```typescript
 * const { installed, version } = await ensureTmuxInstalled({
 *   autoInstall: true,
 *   verbose: true,
 * });
 *
 * if (!installed) {
 *   throw new Error('tmux installation failed');
 * }
 * ```
 */
export async function ensureTmuxInstalled(options: TmuxInstallerOptions = {}): Promise<{
	installed: boolean;
	version: string | null;
	installedNow: boolean;
	method?: TmuxInstallMethod;
	error?: string;
}> {
	const installer = new TmuxInstaller({
		verbose: options.verbose,
		preferredMethod: options.preferredMethod,
		skipSudoCheck: options.skipSudoCheck,
	});

	// Check if already installed
	const isInstalled = await installer.isInstalled();

	if (isInstalled) {
		const version = await installer.getVersion();
		return {
			installed: true,
			version,
			installedNow: false,
		};
	}

	// Not installed - try to install if autoInstall is enabled
	if (options.autoInstall) {
		logger.info("⚠️  tmux not found. Installing automatically...");

		const result = await installer.install(options.preferredMethod);

		if (result.success) {
			logger.info(`✅ tmux ${result.version ?? "unknown"} installed via ${result.method}`);
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
		error: `tmux is not installed. Install it with your system's package manager:\n${getInstallationInstructions()}`,
	};
}

/**
 * Get installation instructions for tmux.
 *
 * @returns Formatted installation instructions string
 */
export function getInstallationInstructions(): string {
	const platform = process.platform;

	let instructions = `
tmux Installation Instructions
==============================
`;

	if (platform === "darwin") {
		instructions += `
macOS (Homebrew):
  brew install tmux
`;
	}

	if (platform === "linux") {
		instructions += `
Debian/Ubuntu:
  sudo apt-get update && sudo apt-get install -y tmux

Fedora/RHEL/CentOS:
  sudo dnf install -y tmux

Arch Linux:
  sudo pacman -S tmux

openSUSE:
  sudo zypper install tmux

Alpine Linux:
  apk add tmux

Using Homebrew (if installed):
  brew install tmux
`;
	}

	if (platform === "win32") {
		instructions += `
Windows:
  tmux is not available natively on Windows.
  Please use Windows Subsystem for Linux (WSL):

  1. Install WSL:
     wsl --install

  2. Then install tmux inside WSL:
     sudo apt-get install tmux
`;
	}

	instructions += `
For more information, visit: https://github.com/tmux/tmux
`;

	return instructions;
}
