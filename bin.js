#!/usr/bin/env node
/**
 * @fileoverview Milhouse CLI Entry Point
 *
 * Bootstrap script that resolves and runs the Milhouse CLI.
 * Uses the platform abstraction layer for cross-platform support.
 *
 * @since 4.4.0
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	detectPlatform,
	getRunnerErrorMessage,
	resolveBinary,
	runCli,
} from "./src/platform/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
