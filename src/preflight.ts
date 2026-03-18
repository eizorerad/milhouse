/**
 * Preflight — validate environment before pipeline starts.
 */

import { createRunCost, isBudgetExceeded } from "./cost.ts";
import { isWorkingTreeDirty } from "./git.ts";
import { type Config, PHASES } from "./types.ts";

export const KNOWN_ENGINES = ["claude", "gemini", "aider"] as const;

export async function checkEngine(engineName: string): Promise<void> {
	const cmd = process.platform === "win32" ? "where" : "which";
	const proc = Bun.spawn([cmd, engineName], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(
			`Engine CLI "${engineName}" not found on PATH. Install it or set a different engine in .milhouse/config.ts`,
		);
	}
}

export async function checkGitRepo(workDir: string): Promise<void> {
	const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: workDir,
		stdout: "ignore",
		stderr: "ignore",
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error("Not a git repository. Run milhouse from inside a git repo.");
	}
}

export function checkConfig(config: Config): void {
	if (!KNOWN_ENGINES.includes(config.engine as (typeof KNOWN_ENGINES)[number])) {
		throw new Error(
			`Unknown engine "${config.engine}". Available engines: ${KNOWN_ENGINES.join(", ")}`,
		);
	}

	if (!Array.isArray(config.pipeline) || config.pipeline.length === 0) {
		throw new Error("Pipeline is empty. Define at least one phase in config.pipeline.");
	}

	for (const phase of config.pipeline) {
		if (!PHASES.includes(phase)) {
			throw new Error(`Unknown pipeline phase "${phase}". Valid phases: ${PHASES.join(", ")}`);
		}
	}
}

function checkBudget(config: Config): void {
	const zeroCost = createRunCost();
	if (isBudgetExceeded(zeroCost, config)) {
		throw new Error("Budget is already exhausted (budget <= 0). Increase cost.budget in config.");
	}
}

export async function preflight(config: Config, workDir: string): Promise<void> {
	await checkEngine(config.engine);
	await checkGitRepo(workDir);
	checkConfig(config);
	checkBudget(config);

	if (await isWorkingTreeDirty(workDir)) {
		throw new Error(
			"Working tree has uncommitted changes. Commit or stash them before running milhouse.",
		);
	}
}
