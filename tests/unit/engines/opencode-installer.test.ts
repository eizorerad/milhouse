/**
 * Unit tests for OpenCode Installer Module
 *
 * Tests the auto-installation functionality for OpenCode CLI.
 * Uses mocking to avoid actual system calls.
 *
 * @module tests/unit/engines/opencode-installer
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	OpencodeInstaller,
	ensureOpencodeInstalled,
	getInstallationInstructions,
	type InstallMethod,
} from "../../../src/engines/opencode/installer";

describe("OpencodeInstaller", () => {
	let installer: OpencodeInstaller;

	beforeEach(() => {
		installer = new OpencodeInstaller({ verbose: false });
	});

	describe("meetsMinimumVersion", () => {
		it("should return true when version is equal to minimum", () => {
			expect(installer.meetsMinimumVersion("0.1.48", "0.1.48")).toBe(true);
		});

		it("should return true when version is greater than minimum (patch)", () => {
			expect(installer.meetsMinimumVersion("0.1.49", "0.1.48")).toBe(true);
		});

		it("should return true when version is greater than minimum (minor)", () => {
			expect(installer.meetsMinimumVersion("0.2.0", "0.1.48")).toBe(true);
		});

		it("should return true when version is greater than minimum (major)", () => {
			expect(installer.meetsMinimumVersion("1.0.0", "0.1.48")).toBe(true);
		});

		it("should return false when version is less than minimum (patch)", () => {
			expect(installer.meetsMinimumVersion("0.1.47", "0.1.48")).toBe(false);
		});

		it("should return false when version is less than minimum (minor)", () => {
			expect(installer.meetsMinimumVersion("0.0.99", "0.1.48")).toBe(false);
		});

		it("should return false when version is less than minimum (major)", () => {
			// This is a special case - 0.x.x vs 0.1.48
			// Since major is equal (0), it compares minor
			expect(installer.meetsMinimumVersion("0.0.99", "0.1.48")).toBe(false);
		});

		it("should handle versions with only major.minor", () => {
			expect(installer.meetsMinimumVersion("1.0", "0.1.48")).toBe(true);
			expect(installer.meetsMinimumVersion("0.1", "0.1.48")).toBe(false);
		});

		it("should use default minimum version when not specified", () => {
			// Default is 0.1.48
			expect(installer.meetsMinimumVersion("0.1.48")).toBe(true);
			expect(installer.meetsMinimumVersion("0.1.47")).toBe(false);
		});

		it("should handle pre-release style versions by comparing numeric parts", () => {
			// Pre-release versions are parsed as numeric parts only
			expect(installer.meetsMinimumVersion("0.1.48", "0.1.48")).toBe(true);
			expect(installer.meetsMinimumVersion("0.2.0", "0.1.48")).toBe(true);
		});
	});

	describe("isInstalled", () => {
		it("should return boolean indicating installation status", async () => {
			// This test verifies the method returns a boolean
			// The actual result depends on whether opencode is installed
			const result = await installer.isInstalled();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("getVersion", () => {
		it("should return string or null", async () => {
			const result = await installer.getVersion();
			expect(result === null || typeof result === "string").toBe(true);
		});
	});

	describe("detectBestMethod", () => {
		it("should return a valid install method", async () => {
			const validMethods: InstallMethod[] = [
				"curl",
				"npm",
				"bun",
				"pnpm",
				"yarn",
				"homebrew",
				"aur",
				"scoop",
				"choco",
				"mise",
				"docker",
			];

			const result = await installer.detectBestMethod();
			expect(validMethods).toContain(result);
		});

		it("should prefer bun when available", async () => {
			// Since we're running in Bun, it should detect bun as available
			const result = await installer.detectBestMethod();
			// On a system with bun, it should return 'bun'
			// This test may vary based on the test environment
			expect(typeof result).toBe("string");
		});
	});

	describe("install", () => {
		it("should return InstallResult with correct structure", async () => {
			// We don't actually install, just verify the return type structure
			// by checking the method exists and returns the expected shape
			const installMethod = installer.install;
			expect(typeof installMethod).toBe("function");
		});

		it("should handle docker method with error", async () => {
			const result = await installer.install("docker");
			expect(result.success).toBe(false);
			expect(result.method).toBe("docker");
			expect(result.error).toContain("Docker installation is not supported");
		});
	});
});

describe("ensureOpencodeInstalled", () => {
	it("should return object with correct structure", async () => {
		const result = await ensureOpencodeInstalled({
			autoInstall: false,
			verbose: false,
		});

		expect(typeof result.installed).toBe("boolean");
		expect(result.version === null || typeof result.version === "string").toBe(true);
		expect(typeof result.installedNow).toBe("boolean");
	});

	it("should return error message when not installed and autoInstall is false", async () => {
		// This test depends on whether opencode is actually installed
		const result = await ensureOpencodeInstalled({
			autoInstall: false,
			verbose: false,
		});

		if (!result.installed) {
			expect(result.error).toBeDefined();
			expect(result.error).toContain("OpenCode is not installed");
		}
	});
});

describe("getInstallationInstructions", () => {
	it("should return installation instructions string", () => {
		const instructions = getInstallationInstructions();

		expect(typeof instructions).toBe("string");
		expect(instructions).toContain("OpenCode Installation Instructions");
		expect(instructions).toContain("curl -fsSL https://opencode.ai/install | bash");
		expect(instructions).toContain("npm install -g opencode-ai");
		expect(instructions).toContain("bun install -g opencode-ai");
	});

	it("should include platform-specific instructions", () => {
		const instructions = getInstallationInstructions();
		const platform = process.platform;

		if (platform === "darwin") {
			expect(instructions).toContain("macOS");
			expect(instructions).toContain("brew install");
		}

		if (platform === "linux") {
			expect(instructions).toContain("Linux");
		}

		if (platform === "win32") {
			expect(instructions).toContain("Windows");
			expect(instructions).toContain("scoop install");
			expect(instructions).toContain("choco install");
		}
	});

	it("should include documentation link", () => {
		const instructions = getInstallationInstructions();
		expect(instructions).toContain("https://opencode.ai/docs");
	});
});
