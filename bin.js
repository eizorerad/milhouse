#!/usr/bin/env node
/**
 * Milhouse CLI — bootstrap script.
 * Tries compiled binary first, then falls back to bun/tsx.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

// Platform → binary name
const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform] ?? "unknown";
const arch = { arm64: "arm64", x64: "x64" }[process.arch] ?? "unknown";
const ext = process.platform === "win32" ? ".exe" : "";
const binaryPath = join(__dirname, "dist", `milhouse-${platform}-${arch}${ext}`);

// Try compiled binary
if (existsSync(binaryPath)) {
	const r = spawnSync(binaryPath, argv, { stdio: "inherit", cwd: process.cwd() });
	process.exit(r.status ?? 1);
}

// Fallback: dev mode via bun or tsx
const entry = join(__dirname, "src", "index.ts");
if (!existsSync(entry)) {
	console.error("Neither compiled binary nor source found. Run: bun run build");
	process.exit(1);
}

const runtimes = process.platform === "win32" ? ["tsx", "bun"] : ["bun", "tsx"];
for (const rt of runtimes) {
	const check = spawnSync(process.platform === "win32" ? "where" : "which", [rt], { stdio: "pipe", timeout: 3000 });
	if (check.status !== 0) continue;

	const args = rt === "bun" ? ["run", entry, ...argv] : [entry, ...argv];
	const r = process.platform === "win32"
		? spawnSync("cmd.exe", ["/c", rt, ...args], { stdio: "inherit", cwd: process.cwd() })
		: spawnSync(rt, args, { stdio: "inherit", cwd: process.cwd() });

	if (!r.error || !r.error.message.includes("ENOENT")) {
		process.exit(r.status ?? 1);
	}
}

console.error("No compatible runtime. Install bun (https://bun.sh) or tsx (npm i -g tsx).");
process.exit(1);
