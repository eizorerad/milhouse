/**
 * Config — one loader, one type, one flow.
 *
 * CLI args → loadConfig(workDir) → deepMerge(DEFAULTS, userConfig, cliOverrides) → Config
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KNOWN_ENGINES, PHASES } from "./types.ts";
import type { Config, DeepPartial, Phase } from "./types.ts";

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
function deepMerge<T extends Record<string, unknown>>(...sources: DeepPartial<T>[]): T {
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

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const KNOWN_TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_ENGINE_SET = new Set<string>(KNOWN_ENGINES);
const PHASE_SET = new Set<string>(PHASES);

function isKnownEngine(engine: string): boolean {
	return KNOWN_ENGINE_SET.has(engine);
}

function isPhase(entry: string): entry is Phase {
	return PHASE_SET.has(entry);
}

function validateConfig(config: Config): void {
	if (!isKnownEngine(config.engine)) {
		throw new ConfigError(
			`Invalid engine "${config.engine}". Must be one of: ${KNOWN_ENGINES.join(", ")}`,
		);
	}

	for (const entry of config.pipeline) {
		if (!isPhase(entry)) {
			throw new ConfigError(
				`Invalid pipeline phase "${entry}". Must be one of: ${PHASES.join(", ")}`,
			);
		}
	}

	for (const [phase, opts] of Object.entries(config.phases)) {
		if (opts.workers != null && opts.workers <= 0) {
			throw new ConfigError(`phases.${phase}.workers is ${opts.workers}, must be > 0`);
		}
		if (opts.retries != null && opts.retries < 0) {
			throw new ConfigError(`phases.${phase}.retries is ${opts.retries}, must be >= 0`);
		}
	}

	if (config.cost.budget < 0) {
		throw new ConfigError(`cost.budget is ${config.cost.budget}, must be >= 0`);
	}
	if (config.cost.inputPerMillion < 0) {
		throw new ConfigError(`cost.inputPerMillion is ${config.cost.inputPerMillion}, must be >= 0`);
	}
	if (config.cost.outputPerMillion < 0) {
		throw new ConfigError(`cost.outputPerMillion is ${config.cost.outputPerMillion}, must be >= 0`);
	}

	for (const key of Object.keys(config)) {
		if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
			console.warn(`Warning: Unknown config key "${key}"`);
		}
	}
}

/**
 * Load config from .milhouse/config.ts, merge with defaults and CLI overrides.
 */
export async function loadConfig(
	workDir: string,
	cliOverrides?: DeepPartial<Config>,
): Promise<Config> {
	const configPath = join(workDir, ".milhouse", "config.ts");
	let userConfig: DeepPartial<Config> = {};

	if (existsSync(configPath)) {
		try {
			const mod = await import(pathToFileURL(configPath).href);
			userConfig = (mod.default ?? mod) as DeepPartial<Config>;
		} catch (err) {
			console.warn(
				`Warning: Failed to load config from ${configPath}: ${err instanceof Error ? err.message : err}. Using defaults.`,
			);
		}
	}

	const merged = deepMerge(
		DEFAULTS as unknown as Record<string, unknown>,
		userConfig as Record<string, unknown>,
		(cliOverrides ?? {}) as Record<string, unknown>,
	) as unknown as Config;
	validateConfig(merged);
	return merged;
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
