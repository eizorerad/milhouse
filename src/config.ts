/** Config: DEFAULTS <- .milhouse/config.ts <- CLI overrides. Unknown keys and bad values are errors. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./state.ts";
import { PHASES } from "./types.ts";
import type { Config } from "./types.ts";
import { errorMessage } from "./util.ts";

export class ConfigError extends Error {
	override name = "ConfigError";
}

export const DEFAULTS: Config = {
	model: "sonnet",
	pipeline: [...PHASES],
	failFast: false,
	phases: {
		scan: { retries: 2, model: "" },
		validate: { workers: 5, retries: 2, model: "" },
		plan: { workers: 5, retries: 2, model: "" },
		consolidate: { retries: 2, model: "" },
		exec: { retries: 2, model: "" },
		verify: { retries: 1, model: "" },
	},
	budget: 50,
	project: { name: "", language: "", framework: "", description: "" },
	commands: { setup: "", build: "", lint: "", test: "" },
	rules: [],
	neverTouch: [],
	gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },
};

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Immutable deep merge. Later sources win; arrays are replaced, not merged. */
export function deepMerge(base: Plain, ...sources: unknown[]): Plain {
	let result = base;
	for (const source of sources) {
		if (!isPlain(source)) continue;
		const next: Plain = { ...result };
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) continue;
			const current = result[key];
			next[key] = isPlain(value) && isPlain(current) ? deepMerge(current, value) : value;
		}
		result = next;
	}
	return result;
}

/** Dotted paths in `user` that DEFAULTS does not know (typos such as `cost.budgetLimit`). */
function unknownKeys(user: unknown, known: unknown, path = ""): string[] {
	if (!isPlain(user) || !isPlain(known)) return [];
	return Object.entries(user).flatMap(([key, value]) =>
		key in known ? unknownKeys(value, known[key], `${path}${key}.`) : [`${path}${key}`],
	);
}

/** Type mismatches of `value` against the shape of `template`. */
function typeErrors(value: unknown, template: unknown, path: string): string[] {
	if (isPlain(template)) {
		if (!isPlain(value)) return [`${path} must be an object`];
		return Object.entries(template).flatMap(([key, t]) =>
			key in value ? typeErrors(value[key], t, path ? `${path}.${key}` : key) : [],
		);
	}
	if (Array.isArray(template)) {
		const ok = Array.isArray(value) && value.every((v) => typeof v === "string");
		return ok ? [] : [`${path} must be an array of strings`];
	}
	return typeof value === typeof template ? [] : [`${path} must be a ${typeof template}`];
}

function validate(config: Config): void {
	const errors = typeErrors(config, DEFAULTS, "");

	if (errors.length === 0) {
		const order = config.pipeline.map((phase) => PHASES.indexOf(phase));
		if (order.includes(-1) || order.some((index, i) => i > 0 && index <= order[i - 1])) {
			errors.push(`pipeline must list phases of ${PHASES.join(", ")} once each, in that order`);
		}
		if (config.budget < 0) errors.push("budget must be >= 0");
		for (const [step, options] of Object.entries(config.phases)) {
			if (!Number.isInteger(options.retries) || options.retries < 0) {
				errors.push(`phases.${step}.retries must be an integer >= 0`);
			}
			if (
				options.workers !== undefined &&
				(!Number.isInteger(options.workers) || options.workers < 1)
			) {
				errors.push(`phases.${step}.workers must be an integer >= 1`);
			}
		}
	}
	if (errors.length > 0) throw new ConfigError(`Invalid config:\n- ${errors.join("\n- ")}`);
}

export async function loadConfig(workDir: string, overrides: Plain = {}): Promise<Config> {
	const path = join(workDir, STATE_DIR, "config.ts");
	let user: unknown = {};
	if (existsSync(path)) {
		try {
			const mod = await import(pathToFileURL(path).href);
			user = mod.default ?? mod;
		} catch (err) {
			throw new ConfigError(`Cannot load ${path}: ${errorMessage(err)}`);
		}
	}
	if (!isPlain(user)) throw new ConfigError(`${path} must export a config object as default`);

	const unknown = unknownKeys(user, DEFAULTS);
	if (unknown.length > 0) {
		throw new ConfigError(
			`Unknown config key(s) in ${path}: ${unknown.join(", ")}. See the README for the current options.`,
		);
	}
	const config = deepMerge(DEFAULTS as unknown as Plain, user, overrides) as unknown as Config;
	validate(config);
	return config;
}

export const CONFIG_TEMPLATE = `// Milhouse config. Every key is optional; the values below are the defaults.
export default {
  // Claude model alias or id. Override per step with phases.<step>.model.
  model: "sonnet",

  // Phases to run, in this order. Remove "merge" to review the verified branch yourself.
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "merge"],

  // Stop after the first phase with a failed item (default: continue with what worked).
  failFast: false,

  // Retries per item. An exec retry is a repair round that feeds the failure back to the agent.
  // verify is the reviewer that checks every issue inside exec.
  phases: {
    scan: { retries: 2 },
    validate: { workers: 5, retries: 2 },
    plan: { workers: 5, retries: 2 },
    consolidate: { retries: 2 },
    exec: { retries: 2 },
    verify: { retries: 1 },
  },

  // Spending limit for one run, in USD. 0 = unlimited.
  budget: 50,

  project: { name: "", language: "", framework: "", description: "" },

  // Shell commands run in the worktree. A failing build/lint/test sends the issue back to the agent.
  commands: { setup: "", build: "", lint: "", test: "" },

  // Rules injected into every prompt, and globs agents must not change (enforced after exec).
  rules: [],
  neverTouch: [], // e.g. ["migrations/**", ".env*"]

  // evidence: validate cites real code. placeholder: no new TODO/FIXME/stubs. diffHygiene: no trailing whitespace or conflict markers.
  // dod: commands pass and the reviewer confirms the acceptance criteria.
  gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },
};
`;
