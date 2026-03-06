/**
 * Config — one loader, one type, one flow.
 * 
 * CLI args → loadConfig(workDir) → deepMerge(DEFAULTS, userConfig, cliOverrides) → Config
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config, Phase } from "./types.ts";

const DEFAULTS: Config = {
	engine: "claude",
	model: "sonnet",
	pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
	failFast: true,
	phases: {
		scan: { workers: 1, retries: 2 },
		validate: { workers: 5, retries: 2 },
		plan: { workers: 5, retries: 3 },
		consolidate: { workers: 1, retries: 2 },
		exec: { workers: 3, retries: 3 },
		verify: { workers: 5, retries: 1 },
	},
	cost: { inputPerMillion: 5, outputPerMillion: 25, budget: 50 },
	project: { name: "", language: "", framework: "", description: "" },
	commands: { test: "", lint: "", build: "" },
	rules: [],
	boundaries: { neverTouch: [] },
	gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },
};

/**
 * Deep merge objects. Later values win. Only merges plain objects, not arrays.
 */
function deepMerge<T extends Record<string, unknown>>(...sources: Partial<T>[]): T {
	const result: Record<string, unknown> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) continue;
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				typeof result[key] === "object" &&
				result[key] !== null &&
				!Array.isArray(result[key])
			) {
				result[key] = deepMerge(
					result[key] as Record<string, unknown>,
					value as Record<string, unknown>,
				);
			} else {
				result[key] = value;
			}
		}
	}
	return result as T;
}

/**
 * Load config from .milhouse/config.ts, merge with defaults and CLI overrides.
 */
export async function loadConfig(
	workDir: string,
	cliOverrides?: Partial<Config>,
): Promise<Config> {
	const configPath = join(workDir, ".milhouse", "config.ts");
	let userConfig: Partial<Config> = {};

	if (existsSync(configPath)) {
		try {
			const mod = await import(pathToFileURL(configPath).href);
			userConfig = (mod.default ?? mod) as Partial<Config>;
		} catch {
			// Failed to load config, use defaults
		}
	}

	return deepMerge(DEFAULTS as unknown as Record<string, unknown>, userConfig as Record<string, unknown>, (cliOverrides ?? {}) as Record<string, unknown>) as unknown as Config;
}

/**
 * Config template for `milhouse --init`
 */
export const CONFIG_TEMPLATE = `import type { Config } from "milhouse";

const config: Config = {
  // AI engine: "claude" | "gemini" | "aider"
  engine: "claude",
  model: "sonnet",

  // Pipeline phases (remove to skip)
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],

  // Per-phase settings
  phases: {
    scan:        { workers: 1, retries: 2 },
    validate:    { workers: 5, retries: 2 },
    plan:        { workers: 5, retries: 3 },
    consolidate: { workers: 1, retries: 2 },
    exec:        { workers: 3, retries: 3 },
    verify:      { workers: 5, retries: 1 },
  },

  // Project info (auto-detected or manual)
  project: { name: "", language: "", framework: "", description: "" },
  commands: { test: "", lint: "", build: "" },

  // Rules injected into every agent prompt
  rules: [],

  // Files agents must never touch
  boundaries: { neverTouch: [] },

  // Quality gates
  gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },

  // Cost budget ($0 = unlimited)
  cost: { inputPerMillion: 5, outputPerMillion: 25, budget: 50 },
};

export default config;
`;
