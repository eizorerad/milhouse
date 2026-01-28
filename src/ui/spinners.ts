import { createSpinner } from "nanospinner";
import ora, { type Ora, type Color } from "ora";
import { bus } from "../events";
import { formatPhase, theme } from "./theme";

export type SpinnerInstance = ReturnType<typeof createSpinner>;

export type SpinnerType = "pipeline" | "phase" | "task" | "engine" | "git" | "gate" | "probe";

// Spinner configurations for different contexts
const spinnerConfigs: Record<SpinnerType, { spinner: string; color: Color }> = {
	pipeline: { spinner: "dots12", color: "magenta" },
	phase: { spinner: "dots", color: "cyan" },
	task: { spinner: "dots2", color: "blue" },
	engine: { spinner: "dots3", color: "yellow" },
	git: { spinner: "dots4", color: "green" },
	gate: { spinner: "dots5", color: "red" },
	probe: { spinner: "dots6", color: "white" },
};

// Active spinners registry
const activeSpinners = new Map<string, Ora>();

export const spinners = {
	// Start a new spinner
	start: (id: string, text: string, type: SpinnerType = "task"): Ora => {
		const config = spinnerConfigs[type];
		const spinner = ora({
			text,
			spinner: config.spinner as Parameters<typeof ora>[0] extends { spinner?: infer S }
				? S
				: never,
			color: config.color,
		}).start();

		activeSpinners.set(id, spinner);
		return spinner;
	},

	// Update spinner text
	update: (id: string, text: string): void => {
		const spinner = activeSpinners.get(id);
		if (spinner) {
			spinner.text = text;
		}
	},

	// Mark spinner as successful
	succeed: (id: string, text?: string): void => {
		const spinner = activeSpinners.get(id);
		if (spinner) {
			spinner.succeed(text);
			activeSpinners.delete(id);
		}
	},

	// Mark spinner as failed
	fail: (id: string, text?: string): void => {
		const spinner = activeSpinners.get(id);
		if (spinner) {
			spinner.fail(text);
			activeSpinners.delete(id);
		}
	},

	// Mark spinner as warning
	warn: (id: string, text?: string): void => {
		const spinner = activeSpinners.get(id);
		if (spinner) {
			spinner.warn(text);
			activeSpinners.delete(id);
		}
	},

	// Stop spinner without status
	stop: (id: string): void => {
		const spinner = activeSpinners.get(id);
		if (spinner) {
			spinner.stop();
			activeSpinners.delete(id);
		}
	},

	// Stop all active spinners
	stopAll: (): void => {
		for (const [, spinner] of activeSpinners) {
			spinner.stop();
		}
		activeSpinners.clear();
	},

	// Get active spinner by id
	get: (id: string): Ora | undefined => activeSpinners.get(id),

	// Check if a spinner is active
	isActive: (id: string): boolean => activeSpinners.has(id),

	// Get count of active spinners
	count: (): number => activeSpinners.size,
};

// Wire spinners to event bus for automatic lifecycle management
export function initSpinnerEventHandlers(): void {
	// Pipeline phase events
	bus.on("pipeline:phase:start", ({ phase }) => {
		const phaseKey = phase as keyof typeof theme.phase;
		const text = theme.phase[phaseKey]
			? `Running ${formatPhase(phaseKey)} phase...`
			: `Running ${phase} phase...`;
		spinners.start(`phase-${phase}`, text, "phase");
	});

	bus.on("pipeline:phase:complete", ({ phase, duration }) => {
		const phaseKey = phase as keyof typeof theme.phase;
		const durationStr = theme.muted(`(${(duration / 1000).toFixed(1)}s)`);
		const text = theme.phase[phaseKey]
			? `${formatPhase(phaseKey)} phase complete ${durationStr}`
			: `${phase} phase complete ${durationStr}`;
		spinners.succeed(`phase-${phase}`, text);
	});

	bus.on("pipeline:phase:error", ({ phase, error }) => {
		const phaseKey = phase as keyof typeof theme.phase;
		const text = theme.phase[phaseKey]
			? `${formatPhase(phaseKey)} phase failed: ${theme.error(error.message)}`
			: `${phase} phase failed: ${theme.error(error.message)}`;
		spinners.fail(`phase-${phase}`, text);
	});

	// Task events
	bus.on("task:start", ({ taskId, title }) => {
		spinners.start(`task-${taskId}`, title, "task");
	});

	bus.on("task:progress", ({ taskId, step, detail }) => {
		const text = detail ? `${step} ${theme.dim(detail)}` : step;
		spinners.update(`task-${taskId}`, text);
	});

	bus.on("task:complete", ({ taskId, success, duration }) => {
		const durationStr = theme.muted(`(${(duration / 1000).toFixed(1)}s)`);
		if (success) {
			spinners.succeed(`task-${taskId}`, `Task complete ${durationStr}`);
		} else {
			spinners.fail(`task-${taskId}`, `Task failed ${durationStr}`);
		}
	});

	bus.on("task:error", ({ taskId, error }) => {
		spinners.fail(`task-${taskId}`, `Task error: ${theme.error(error.message)}`);
	});

	// Engine events
	bus.on("engine:start", ({ engine, taskId }) => {
		const engineKey = engine as keyof typeof theme.engine;
		const engineName = theme.engine[engineKey] ? theme.engine[engineKey](engine) : engine;
		spinners.start(`engine-${taskId}`, `${engineName} processing...`, "engine");
	});

	bus.on("engine:complete", ({ taskId }) => {
		spinners.succeed(`engine-${taskId}`);
	});

	bus.on("engine:error", ({ taskId, error }) => {
		spinners.fail(`engine-${taskId}`, `Engine error: ${theme.error(error.message)}`);
	});

	// Git events
	bus.on("git:worktree:create", ({ path, branch }) => {
		spinners.start(
			`git-worktree-${path}`,
			`Creating worktree ${theme.path(path)} on ${theme.code(branch)}`,
			"git",
		);
	});

	bus.on("git:worktree:cleanup", ({ path }) => {
		spinners.succeed(`git-worktree-${path}`, `Cleaned up worktree ${theme.path(path)}`);
	});

	bus.on("git:merge:start", ({ source, target }) => {
		spinners.start(
			`git-merge-${source}`,
			`Merging ${theme.code(source)} → ${theme.code(target)}`,
			"git",
		);
	});

	bus.on("git:merge:complete", ({ source, target }) => {
		spinners.succeed(`git-merge-${source}`, `Merged ${theme.code(source)} → ${theme.code(target)}`);
	});

	bus.on("git:merge:conflict", ({ source, target, files }) => {
		spinners.warn(
			`git-merge-${source}`,
			`Merge conflict ${theme.code(source)} → ${theme.code(target)}: ${files.length} files`,
		);
	});

	// Gate events
	bus.on("gate:start", ({ name, taskId }) => {
		spinners.start(`gate-${taskId}-${name}`, `Running gate: ${theme.highlight(name)}`, "gate");
	});

	bus.on("gate:pass", ({ name, taskId }) => {
		spinners.succeed(`gate-${taskId}-${name}`, `Gate passed: ${theme.highlight(name)}`);
	});

	bus.on("gate:fail", ({ name, taskId, reason }) => {
		spinners.fail(
			`gate-${taskId}-${name}`,
			`Gate failed: ${theme.highlight(name)} - ${theme.error(reason)}`,
		);
	});

	// Probe events
	bus.on("probe:start", ({ name }) => {
		spinners.start(`probe-${name}`, `Running probe: ${theme.info(name)}`, "probe");
	});

	bus.on("probe:complete", ({ name }) => {
		spinners.succeed(`probe-${name}`, `Probe complete: ${theme.info(name)}`);
	});

	bus.on("probe:error", ({ name, error }) => {
		spinners.fail(
			`probe-${name}`,
			`Probe error: ${theme.info(name)} - ${theme.error(error.message)}`,
		);
	});
}

// Export Ora type for external use
export type { Ora };

/**
 * Create an ora-based spinner with Milhouse theming
 *
 * This is the recommended way to create spinners in new code.
 * It uses the new ora-based spinner system with proper theming.
 */
export function createThemedSpinner(
	id: string,
	text: string,
	type: SpinnerType = "task",
): Ora {
	return spinners.start(id, text, type);
}

// ============================================================================
// Re-exports from _legacy for backward compatibility
// ============================================================================

/**
 * @deprecated Use the new `spinners` module API for new code.
 * These exports are maintained for backward compatibility with existing consumers.
 */
export {
	ProgressSpinner,
	DynamicAgentSpinner,
	createSimpleSpinner,
	LegacySpinnerAdapter,
	type ActionCounts,
} from "./_legacy/spinners-deprecated.ts";
