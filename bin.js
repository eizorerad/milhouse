#!/usr/bin/env node
/**
 * @fileoverview Milhouse CLI Entry Point
 *
 * Bootstrap script that resolves and runs the Milhouse CLI.
 * This file must be pure JavaScript (no TypeScript imports) to work with Node.js.
 *
 * @since 4.4.0
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Platform detection
const PLATFORM_MAP = {
	darwin: "darwin",
	linux: "linux",
	win32: "windows",
};

const ARCH_MAP = {
	arm64: "arm64",
	aarch64: "arm64",
	x64: "x64",
	amd64: "x64",
};

function detectPlatform() {
	const nodePlatform = process.platform;
	const nodeArch = process.arch;

	return {
		platform: PLATFORM_MAP[nodePlatform] ?? "unknown",
		arch: ARCH_MAP[nodeArch] ?? "unknown",
		executableExtension: nodePlatform === "win32" ? ".exe" : "",
		isWindows: nodePlatform === "win32",
	};
}

function constructBinaryName(prefix, config) {
	return `${prefix}-${config.platform}-${config.arch}${config.executableExtension}`;
}

function resolveBinary(options) {
	const platform = detectPlatform();
	const validPlatforms = ["darwin", "linux", "windows"];
	const validArchs = ["arm64", "x64"];

	if (!validPlatforms.includes(platform.platform) || !validArchs.includes(platform.arch)) {
		return {
			found: false,
			platform,
			error: `Unsupported platform: ${platform.platform}-${platform.arch}`,
		};
	}

	const binaryName = constructBinaryName(options.binaryPrefix, platform);
	const binaryPath = join(options.baseDirectory, options.distDirectory, binaryName);

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

function checkCommandExists(command, isWindows) {
	try {
		const checkCommand = isWindows ? "where" : "which";
		const result = spawnSync(checkCommand, [command], {
			stdio: "pipe",
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function executeCompiled(binaryPath, argv, cwd) {
	const result = spawnSync(binaryPath, argv, {
		stdio: "inherit",
		cwd,
	});

	return {
		exitCode: result.status ?? 1,
		success: result.status === 0,
		runner: "compiled",
		error: result.error?.message,
	};
}

function executeDev(runtime, entryPath, argv, cwd, isWindows) {
	const runtimeArgs = runtime === "bun" ? ["run", entryPath] : [entryPath];
	const fullArgs = [...runtimeArgs, ...argv];

	let result;
	if (isWindows) {
		result = spawnSync("cmd.exe", ["/c", runtime, ...fullArgs], {
			stdio: "inherit",
			cwd,
		});
	} else {
		result = spawnSync(runtime, fullArgs, {
			stdio: "inherit",
			cwd,
		});
	}

	if (result.error) {
		return {
			exitCode: 1,
			success: false,
			runner: runtime,
			error: result.error.message,
		};
	}

	return {
		exitCode: result.status ?? 1,
		success: result.status === 0,
		runner: runtime,
	};
}

function runCli(options) {
	const { compiledBinaryPath, devEntryPath, argv, cwd, platform } = options;

	// Try compiled binary first
	if (compiledBinaryPath && existsSync(compiledBinaryPath)) {
		return executeCompiled(compiledBinaryPath, argv, cwd);
	}

	// Check if dev entry exists
	if (!existsSync(devEntryPath)) {
		return {
			exitCode: 1,
			success: false,
			runner: "none",
			error: "Neither compiled binary nor source entry found",
		};
	}

	// Try development runtimes in preferred order
	const runtimes = platform.isWindows ? ["tsx", "bun"] : ["bun", "tsx"];

	for (const runtime of runtimes) {
		if (!checkCommandExists(runtime, platform.isWindows)) {
			continue;
		}

		const result = executeDev(runtime, devEntryPath, argv, cwd, platform.isWindows);

		if (!result.error || !result.error.includes("ENOENT")) {
			return result;
		}
	}

	return {
		exitCode: 1,
		success: false,
		runner: "none",
		error: "No compatible runtime found. Install bun or tsx.",
	};
}

function getRunnerErrorMessage(result) {
	if (result.runner === "none") {
		return [
			"Unable to run Milhouse CLI.",
			"",
			"Options:",
			"  1. Build the compiled binary: bun run build",
			"  2. Install bun: https://bun.sh",
			"  3. Install tsx: npm install -g tsx",
		].join("\n");
	}

	if (result.error) {
		return `Execution failed (${result.runner}): ${result.error}`;
	}

	return `Execution failed with exit code ${result.exitCode}`;
}

// Main execution
const platform = detectPlatform();
const binaryResult = resolveBinary({
	binaryPrefix: "milhouse",
	distDirectory: "dist",
	baseDirectory: __dirname,
});

const result = runCli({
	compiledBinaryPath: binaryResult.found ? binaryResult.path : undefined,
	devEntryPath: join(__dirname, "src", "index.ts"),
	argv: process.argv.slice(2),
	cwd: process.cwd(),
	platform,
});

if (!result.success && result.runner === "none") {
	console.error(getRunnerErrorMessage(result));
}

process.exit(result.exitCode);
