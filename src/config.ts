/** Config: DEFAULTS <- .milhouse/config.ts <- CLI overrides. Unknown keys and bad values are errors. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./state.ts";
import {
	type AgentStep,
	type Config,
	DEFAULT_MODEL,
	HARNESS_NAMES,
	type HarnessName,
	PHASES,
	type Phase,
} from "./types.ts";
import { MINUTE, errorMessage } from "./util.ts";

export class ConfigError extends Error {
	override name = "ConfigError";
}

export const DEFAULTS: Config = {
	harness: "claude",
	model: "",
	harnessArgs: { claude: [], codex: [] },
	pipeline: [...PHASES],
	failFast: false,
	phases: {
		scan: { retries: 2, timeoutMinutes: 15, model: "", harness: "", rules: [] },
		validate: { workers: 5, retries: 2, timeoutMinutes: 5, model: "", harness: "", rules: [] },
		plan: { workers: 5, retries: 2, timeoutMinutes: 5, model: "", harness: "", rules: [] },
		consolidate: { retries: 2, timeoutMinutes: 5, model: "", harness: "", rules: [] },
		exec: { retries: 2, timeoutMinutes: 30, model: "", harness: "", rules: [] },
		verify: { retries: 1, timeoutMinutes: 10, model: "", harness: "", rules: [] },
	},
	budget: 50,
	maxMinutes: 0,
	project: { name: "", language: "", framework: "", description: "" },
	commands: { setup: "", build: "", lint: "", test: "" },
	commandTimeoutMinutes: 10,
	allowUnchecked: false,
	rules: [],
	neverTouch: [],
	gates: {
		evidence: true,
		diffHygiene: true,
		placeholder: true,
		dod: true,
		baseline: true,
		// Where trailing spaces mean something, and a TODO in the text is not unfinished code.
		ignore: ["*.md", "*.tsv", "*.csv", "*.patch", "*.diff"],
	},
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

/**
 * Options Milhouse sets itself: the protocol it reads, the permissions it grants, where the agent works.
 * `harnessArgs` may add anything else (a profile, a config override), but not these.
 */
const RESERVED_ARGS: Record<HarnessName, string[]> = {
	claude: [
		"-p",
		"--print",
		"--output-format",
		"--input-format",
		"--json-schema",
		"--tools",
		"--permission-mode",
		"--dangerously-skip-permissions",
		"--setting-sources",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--max-turns",
		"--max-budget-usd",
		"--model", // set `model` instead
		"--", // everything after it would be read as the prompt
	],
	codex: [
		"--json",
		"--ephemeral",
		"-C",
		"--cd",
		"-s",
		"--sandbox",
		"--dangerously-bypass-approvals-and-sandbox",
		"--full-auto",
		"--approve-for-me",
		"-o",
		"--output-last-message",
		"--output-schema",
		"--add-dir",
		"-m", // Codex refuses an option that is given twice: set `model` instead
		"--model",
		"--",
	],
};

/** What a call may take is limited to a day: a longer time would overflow the timer. */
const validLimit = (minutes: number): boolean =>
	Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60;

export const commandTimeoutMs = (config: Config): number => config.commandTimeoutMinutes * MINUTE;

export function projectChecksEnabled({ gates, commands }: Config): boolean {
	return gates.dod && [commands.build, commands.lint, commands.test].some((cmd) => cmd.trim());
}

/** The agent that runs `step`: its own choice, or the global one. */
export const stepHarness = (config: Config, step: AgentStep): HarnessName =>
	config.phases[step].harness || config.harness;

/**
 * The model of `step`. The global model belongs to the global harness: a step that runs on the other one
 * does not inherit it (a Claude alias means nothing to Codex) and uses that harness's default instead.
 */
export function stepModel(config: Config, step: AgentStep): string {
	const own = config.phases[step].model;
	if (own) return own;
	const harness = stepHarness(config, step);
	return (harness === config.harness ? config.model : "") || DEFAULT_MODEL[harness];
}

/** The steps that call an agent when `phases` run. `verify` is the reviewer inside exec, used with the definition of done. */
export function agentSteps(config: Config, phases: Phase[]): AgentStep[] {
	return phases.flatMap((phase): AgentStep[] => {
		if (phase === "merge") return [];
		return phase === "exec" && config.gates.dod ? ["exec", "verify"] : [phase];
	});
}

/**
 * Which agent runs each step, for the start of a run: "scan claude/claude-opus-5-5, validate codex/default x8".
 * "default" is the model of the harness's own configuration (a Codex step without a model).
 */
export function describeAgents(config: Config, phases: Phase[]): string {
	return agentSteps(config, phases)
		.map((step) => {
			const workers = config.phases[step].workers ?? 1;
			const agent = `${stepHarness(config, step)}/${stepModel(config, step) || "default"}`;
			return `${step} ${agent}${workers > 1 ? ` x${workers}` : ""}`;
		})
		.join(", ");
}

function validate(config: Config): void {
	const errors = typeErrors(config, DEFAULTS, "");

	if (errors.length === 0) {
		const known = (name: string): boolean => (HARNESS_NAMES as readonly string[]).includes(name);
		if (!known(config.harness)) errors.push(`harness must be one of ${HARNESS_NAMES.join(", ")}`);
		for (const name of HARNESS_NAMES) {
			for (const arg of config.harnessArgs[name]) {
				// --name=value is the option --name, and -xvalue is the option -x
				const option = arg.startsWith("--") ? arg.split("=")[0] : arg.slice(0, 2);
				if (arg.startsWith("-") && RESERVED_ARGS[name].includes(option)) {
					errors.push(`harnessArgs.${name}: "${option}" is set by Milhouse and cannot be changed`);
				}
			}
		}
		const order = config.pipeline.map((phase) => PHASES.indexOf(phase));
		if (order.includes(-1) || order.some((index, i) => i > 0 && index <= order[i - 1])) {
			errors.push(`pipeline must list phases of ${PHASES.join(", ")} once each, in that order`);
		}
		// NaN would switch the limit off without a word, Infinity would be passed on to the agent as a limit.
		if (!Number.isFinite(config.budget) || config.budget < 0) {
			errors.push("budget must be a finite number >= 0");
		}
		if (!Number.isFinite(config.maxMinutes) || config.maxMinutes < 0) {
			errors.push("maxMinutes must be a finite number >= 0");
		}
		if (!validLimit(config.commandTimeoutMinutes)) {
			errors.push("commandTimeoutMinutes must be a number above 0 and at most 1440");
		}
		for (const [step, options] of Object.entries(config.phases)) {
			if (options.harness !== "" && !known(options.harness)) {
				errors.push(`phases.${step}.harness must be "" or one of ${HARNESS_NAMES.join(", ")}`);
			}
			if (!Number.isInteger(options.retries) || options.retries < 0) {
				errors.push(`phases.${step}.retries must be an integer >= 0`);
			}
			if (!validLimit(options.timeoutMinutes)) {
				errors.push(`phases.${step}.timeoutMinutes must be a number above 0 and at most 1440`);
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

const EMPTY_COMMANDS = 'commands: { setup: "", build: "", lint: "", test: "" },';

/** The config file `milhouse init` writes, with the commands that were found in the project. */
export function configTemplate(found: Partial<Config["commands"]>): string {
	const commands = { ...DEFAULTS.commands, ...found };
	const values = Object.entries(commands).map(
		([slot, command]) => `${slot}: ${JSON.stringify(command)}`,
	);
	return CONFIG_TEMPLATE.replace(EMPTY_COMMANDS, `commands: { ${values.join(", ")} },`);
}

export const CONFIG_TEMPLATE = `// Milhouse config. Every key is optional; the values below are the defaults.
export default {
  // The agent that runs every step: "claude" (Claude Code) or "codex" (Codex CLI).
  // Any step can use the other one, e.g. phases: { verify: { harness: "codex" } } for an independent reviewer.
  harness: "claude",

  // Model of that harness. "" = its default (claude: sonnet, codex: what your Codex config says).
  // Override per step with phases.<step>.model.
  model: "",

  // Extra command-line arguments per harness, e.g. { codex: ["-p", "milhouse"] } to use a Codex profile.
  harnessArgs: { claude: [], codex: [] },

  // Phases to run, in this order. Remove "merge" to review the verified branch yourself.
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "merge"],

  // Stop after the first phase with a failed item (default: continue with what worked).
  failFast: false,

  // Retries per item, and per step also: harness, model (a full id such as "claude-opus-5-5" pins a version,
  // an alias such as "opus" follows the newest) and rules (extra instructions for that step only).
  // An exec retry is a repair round that feeds the failure back to the agent.
  // verify is the reviewer that checks every issue inside exec.
  // timeoutMinutes: the longest that one call of the step may take.
  phases: {
    scan: { retries: 2, timeoutMinutes: 15 },
    validate: { workers: 5, retries: 2, timeoutMinutes: 5 },
    plan: { workers: 5, retries: 2, timeoutMinutes: 5 },
    consolidate: { retries: 2, timeoutMinutes: 5 },
    exec: { retries: 2, timeoutMinutes: 30 },
    verify: { retries: 1, timeoutMinutes: 10 },
  },

  // Spending limit for one run, in USD. 0 = unlimited. Codex reports tokens, not dollars: it cannot be capped.
  budget: 50,

  // The longest that one milhouse command may run, in minutes, for every agent: no call outlasts it and no new
  // one starts. 0 = unlimited. A resumed run gets the full time again.
  maxMinutes: 0,

  project: { name: "", language: "", framework: "", description: "" },

  // At least one build/lint/test must pass for automatic merge. Setup alone does not count.
  commands: { setup: "", build: "", lint: "", test: "" },
  // The longest that one setup, build, lint or test command may run, in minutes.
  commandTimeoutMinutes: 10,
  // Without a command only an agent reviews the work and nothing merges by itself, so exec refuses to start.
  // true: start anyway (also: --allow-unchecked).
  allowUnchecked: false,

  // Rules injected into every prompt, and globs agents must not change (enforced after exec).
  rules: [],
  neverTouch: [], // e.g. ["migrations/**", ".env*"]

  // evidence: validate cites real code. placeholder: no new TODO/FIXME/stubs. diffHygiene: no trailing whitespace or conflict markers.
  // dod: commands pass and the reviewer confirms the acceptance criteria.
  // baseline: the commands must pass on the starting commit before the run spends anything; otherwise every issue fails for what was broken already.
  // ignore: files that placeholder and diffHygiene skip (patterns as in .gitignore; a list here replaces the default).
  gates: {
    evidence: true,
    diffHygiene: true,
    placeholder: true,
    dod: true,
    baseline: true,
    ignore: ["*.md", "*.tsv", "*.csv", "*.patch", "*.diff"],
  },
};
`;
