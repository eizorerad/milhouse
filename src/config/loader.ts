/**
 * Config loader — reads `.milhouse/config.ts` (primary) or `.milhouse/config.yaml` (fallback).
 *
 * Uses Bun's native `await import()` for .ts files.
 * Falls back to YAML for backward compatibility or compiled binary environments.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Config } from "./define.ts";
import { logDebug, logWarn } from "../ui/logger.ts";

const EXPECTED_IMPORT_ERROR_CODES = new Set([
	"ERR_UNKNOWN_FILE_EXTENSION",
	"ERR_MODULE_NOT_FOUND",
	"MODULE_NOT_FOUND",
]);

let cached: Config | null = null;

/**
 * Load user config from `.milhouse/config.ts` or `.milhouse/config.yaml`.
 * Result is cached for the lifetime of the process.
 */
export async function loadUserConfig(workDir: string): Promise<Config> {
	if (cached) return cached;

	const tsPath = join(workDir, ".milhouse", "config.ts");
	const yamlPaths = [
		join(workDir, ".milhouse", "config.yaml"),
		join(workDir, ".milhouse", "config.yml"),
	];

	// Primary: TypeScript config
	if (existsSync(tsPath)) {
		try {
			const mod = await import(pathToFileURL(tsPath).href);
			cached = (mod.default ?? mod) as Config;
			return cached;
		} catch (error: unknown) {
			const code = (error as { code?: string }).code;
			if (code && EXPECTED_IMPORT_ERROR_CODES.has(code)) {
				logDebug(`Could not import .milhouse/config.ts (${code}) — falling back to YAML or defaults`);
			} else {
				const msg = error instanceof Error ? error.message : String(error);
				logWarn(`Failed to load .milhouse/config.ts: ${msg} — falling back to YAML or defaults`);
			}
		}
	}

	// Fallback: YAML config
	for (const yamlPath of yamlPaths) {
		if (existsSync(yamlPath)) {
			try {
				const content = readFileSync(yamlPath, "utf-8");
				const parsed = parseYaml(content);
				if (parsed && typeof parsed === "object") {
					cached = parsed as Config;
					return cached;
				}
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				logWarn(`Failed to parse ${yamlPath}: ${msg} — skipping`);
			}
		}
	}

	// No config found — use empty (DEFAULTS will fill everything)
	cached = {};
	return cached;
}

/**
 * Clear cached config (for testing or reinit).
 */
export function clearConfigCache(): void {
	cached = null;
}
