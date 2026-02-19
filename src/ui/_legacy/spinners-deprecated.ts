/**
 * Deprecated Spinner APIs
 *
 * These functions and classes have been moved to _legacy as they are deprecated.
 * They are kept here for backward compatibility with existing consumers.
 *
 * @deprecated All exports in this file are deprecated. Use the modern `spinners` module API instead.
 * @see src/ui/spinners.ts for the modern API
 */

import { createSpinner } from "nanospinner";
import pc from "picocolors";
import type { DetailedStep } from "../../engines/base.ts";
import { formatStepForDisplay } from "../../engines/base.ts";
import { spinners, type SpinnerInstance } from "../spinners.ts";
import { theme } from "../theme.ts";

/**
 * Create a simple spinner
 *
 * @deprecated Use `spinners.start()` for new code.
 */
export function createSimpleSpinner(text: string): SpinnerInstance {
	return createSpinner(text).start();
}

/**
 * Adapter to convert legacy spinner usage to new system
 *
 * @deprecated This is a migration helper. Use `spinners` directly for new code.
 */
export class LegacySpinnerAdapter {
	private id: string;
	private startTime: number;

	constructor(id: string, text: string) {
		this.id = id;
		this.startTime = Date.now();
		spinners.start(id, text, "task");
	}

	update(text: string): void {
		spinners.update(this.id, text);
	}

	success(text?: string): void {
		const duration = Date.now() - this.startTime;
		const durationStr = theme.muted(`(${(duration / 1000).toFixed(1)}s)`);
		spinners.succeed(this.id, text ? `${text} ${durationStr}` : undefined);
	}

	error(text?: string): void {
		spinners.fail(this.id, text);
	}

	warn(text?: string): void {
		spinners.warn(this.id, text);
	}

	stop(): void {
		spinners.stop(this.id);
	}
}

// ============================================================================
// Legacy Spinner Classes (moved from spinners.ts for backward compatibility)
// ============================================================================

/**
 * Action counters for tracking progress
 */
export interface ActionCounts {
	read: number;
	write: number;
	test: number;
	cmd: number;
}

/**
 * Progress spinner with step tracking and action counts
 *
 * @deprecated Use the new `spinners` module API for new code.
 * This class is maintained for backward compatibility with 8 existing consumers:
 * - src/cli/commands/task.ts:113 - Task execution with settings
 * - src/cli/commands/consolidate.ts:635 - Consolidation progress
 * - src/cli/commands/plan.ts:809 - Planning progress
 * - src/cli/commands/exec.ts:254 - Execution progress
 * - src/cli/commands/scan.ts:357 - Repository scanning
 * - src/cli/commands/verify.ts:636 - Verification progress
 * - src/execution/steps/sequential.ts:133 - Sequential step execution
 *
 * Features not in modern API:
 * - Automatic elapsed time display: `[1m 23s]`
 * - Action counts: `(R:5 W:2 T:1 C:3)`
 * - Settings display: `[engine, options]`
 * - DetailedStep category parsing
 */
export class ProgressSpinner {
	private spinner: SpinnerInstance;
	private startTime: number;
	private currentStep = "Thinking";
	private currentDetail?: string;
	private task: string;
	private settings: string;
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private actionCounts: ActionCounts = { read: 0, write: 0, test: 0, cmd: 0 };
	private showCounts = true;

	constructor(task: string, settings?: string[], options?: { showCounts?: boolean }) {
		this.task = task.length > 40 ? `${task.slice(0, 37)}...` : task;
		this.settings = settings?.length ? `[${settings.join(", ")}]` : "";
		this.startTime = Date.now();
		this.showCounts = options?.showCounts !== false;
		this.spinner = createSpinner(this.formatText()).start();

		// Update timer every second
		this.tickInterval = setInterval(() => this.tick(), 1000);
	}

	private formatCounts(): string {
		const { read, write, test, cmd } = this.actionCounts;
		const total = read + write + test + cmd;
		if (total === 0 || !this.showCounts) return "";

		const parts: string[] = [];
		if (read > 0) parts.push(`R:${read}`);
		if (write > 0) parts.push(`W:${write}`);
		if (test > 0) parts.push(`T:${test}`);
		if (cmd > 0) parts.push(`C:${cmd}`);

		return parts.length > 0 ? `(${parts.join(" ")}) ` : "";
	}

	private formatText(): string {
		const elapsed = Date.now() - this.startTime;
		const secs = Math.floor(elapsed / 1000);
		const mins = Math.floor(secs / 60);
		const remainingSecs = secs % 60;
		const time = mins > 0 ? `${mins}m ${remainingSecs}s` : `${secs}s`;

		const settingsStr = this.settings ? ` ${pc.yellow(this.settings)}` : "";
		const countsStr = pc.dim(this.formatCounts());
		const stepWithDetail = this.currentDetail
			? `${this.currentStep} ${pc.dim(this.currentDetail)}`
			: this.currentStep;

		return `${pc.cyan(stepWithDetail)} ${countsStr}${settingsStr} ${pc.dim(`[${time}]`)} ${this.task}`;
	}

	/**
	 * Update the current step (accepts string or DetailedStep)
	 */
	updateStep(step: string | DetailedStep): void {
		if (typeof step === "string") {
			this.currentStep = step;
			this.currentDetail = undefined;
		} else {
			// DetailedStep object
			this.currentStep = formatStepForDisplay(step, "compact");
			this.currentDetail = step.shortDetail;

			// Update counters
			this.incrementCounter(step);
		}
		this.spinner.update({ text: this.formatText() });
	}

	/**
	 * Increment appropriate action counter
	 */
	private incrementCounter(step: DetailedStep): void {
		switch (step.category) {
			case "reading":
				this.actionCounts.read++;
				break;
			case "writing":
				this.actionCounts.write++;
				break;
			case "testing":
				this.actionCounts.test++;
				break;
			case "linting":
			case "command":
			case "committing":
			case "staging":
				this.actionCounts.cmd++;
				break;
		}
	}

	/**
	 * Get current action counts
	 */
	getCounts(): ActionCounts {
		return { ...this.actionCounts };
	}

	/**
	 * Reset action counts
	 */
	resetCounts(): void {
		this.actionCounts = { read: 0, write: 0, test: 0, cmd: 0 };
	}

	/**
	 * Update spinner text (called periodically to update time)
	 */
	tick(): void {
		this.spinner.update({ text: this.formatText() });
	}

	private clearTickInterval(): void {
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
	}

	/**
	 * Mark as success
	 */
	success(message?: string): void {
		this.clearTickInterval();
		this.spinner.success({ text: message || this.formatText() });
	}

	/**
	 * Mark as error
	 */
	error(message?: string): void {
		this.clearTickInterval();
		this.spinner.error({ text: message || this.formatText() });
	}

	/**
	 * Mark as warning (completed but with issues)
	 */
	warn(message?: string): void {
		this.clearTickInterval();
		this.spinner.warn({ text: message || this.formatText() });
	}

	/**
	 * Mark as failed (alias for error with different semantics)
	 */
	fail(message?: string): void {
		this.error(message);
	}

	/**
	 * Stop the spinner
	 */
	stop(): void {
		this.clearTickInterval();
		this.spinner.stop();
	}
}

/**
 * Slot status for dynamic agent spinner
 */
interface SlotStatus {
	issueId: string | null;
	status: string;
	startedAt: number;
}

/**
 * Dynamic Agent Spinner for p-limit based parallel validation
 *
 * Shows real-time progress with dynamic slot assignment:
 * `[3/7] IV-1: ISS-001 investigating | IV-2: ISS-002 running | IV-3: ISS-003 starting`
 *
 * @deprecated Use the new `spinners` module API for new code.
 * This class is maintained for backward compatibility with 3 existing consumers:
 * - src/cli/commands/validate.ts:1091 - Parallel validation rounds
 * - src/execution/issue-executor.ts:932 - Issue-based parallel execution
 * - src/execution/steps/parallel.ts:744 - Dynamic import for parallel steps
 *
 * Features not in modern API:
 * - Multi-slot parallel tracking: `IV-1: ISS-001 investigating | IV-2: ISS-002 running`
 * - Progress counter: `[3/7]`
 * - Automatic slot management for p-limit integration
 */
export class DynamicAgentSpinner {
	private spinner: SpinnerInstance;
	private startTime: number;
	private maxSlots: number;
	private totalTasks: number;
	private completedTasks: number;
	private slots: Map<number, SlotStatus>;
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private baseText: string;

	constructor(maxSlots: number, totalTasks: number, baseText = "Deep validation in progress") {
		this.maxSlots = maxSlots;
		this.totalTasks = totalTasks;
		this.completedTasks = 0;
		this.baseText = baseText;
		this.slots = new Map();
		this.startTime = Date.now();

		// Initialize empty slots
		for (let i = 1; i <= maxSlots; i++) {
			this.slots.set(i, { issueId: null, status: "idle", startedAt: 0 });
		}

		this.spinner = createSpinner(this.formatText()).start();

		// Update timer every second
		this.tickInterval = setInterval(() => this.tick(), 1000);
	}

	/**
	 * Acquire a slot for a new issue
	 * Returns slot number (1-based) or throws if no slots available
	 */
	acquireSlot(issueId: string): number {
		// Find first idle slot
		for (let i = 1; i <= this.maxSlots; i++) {
			const slot = this.slots.get(i);
			if (slot && (slot.status === "idle" || slot.status === "complete")) {
				this.slots.set(i, {
					issueId,
					status: "starting",
					startedAt: Date.now(),
				});
				this.tick();
				return i;
			}
		}

		// Should not happen with proper p-limit configuration
		throw new Error(`No available slots (max: ${this.maxSlots})`);
	}

	/**
	 * Update slot status
	 */
	updateSlot(slotNum: number, status: string): void {
		const slot = this.slots.get(slotNum);
		if (slot?.issueId) {
			slot.status = status;
			this.tick();
		}
	}

	/**
	 * Release a slot and mark task as complete
	 */
	releaseSlot(slotNum: number, success: boolean): void {
		const slot = this.slots.get(slotNum);
		if (slot?.issueId) {
			this.completedTasks++;
			this.slots.set(slotNum, {
				issueId: null,
				status: "idle",
				startedAt: 0,
			});
			this.tick();
		}
	}

	/**
	 * Format elapsed time
	 */
	private formatElapsed(): string {
		const elapsed = Date.now() - this.startTime;
		const secs = Math.floor(elapsed / 1000);
		const mins = Math.floor(secs / 60);
		const remainingSecs = secs % 60;
		return mins > 0 ? `${mins}m ${remainingSecs}s` : `${secs}s`;
	}

	/**
	 * Format the spinner text showing all active slots
	 */
	private formatText(): string {
		const parts: string[] = [];

		// Active slots display
		for (let i = 1; i <= this.maxSlots; i++) {
			const slot = this.slots.get(i);
			if (slot?.issueId && slot.status !== "idle") {
				// Truncate status if too long
				const statusShort =
					slot.status.length > 15 ? `${slot.status.slice(0, 12)}...` : slot.status;
				parts.push(`IV-${i}: ${slot.issueId} ${pc.cyan(statusShort)}`);
			}
		}

		const slotsDisplay = parts.length > 0 ? parts.join(" | ") : "waiting";
		const progress = pc.yellow(`[${this.completedTasks}/${this.totalTasks}]`);
		const time = pc.dim(`[${this.formatElapsed()}]`);

		return `${progress} ${slotsDisplay} ${time} ${this.baseText}`;
	}

	/**
	 * Update spinner text (called periodically and on status changes)
	 */
	tick(): void {
		this.spinner.update({ text: this.formatText() });
	}

	private clearTickInterval(): void {
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
	}

	/**
	 * Get progress stats
	 */
	getProgress(): { completed: number; total: number; active: number } {
		let active = 0;
		for (const slot of this.slots.values()) {
			if (slot.issueId && slot.status !== "idle") {
				active++;
			}
		}
		return { completed: this.completedTasks, total: this.totalTasks, active };
	}

	/**
	 * Mark as success
	 */
	success(message?: string): void {
		this.clearTickInterval();
		this.spinner.success({
			text:
				message ||
				`Deep validation complete [${this.completedTasks}/${this.totalTasks}] ${pc.dim(`[${this.formatElapsed()}]`)}`,
		});
	}

	/**
	 * Mark as error
	 */
	error(message?: string): void {
		this.clearTickInterval();
		this.spinner.error({ text: message || this.formatText() });
	}

	/**
	 * Mark as warning
	 */
	warn(message?: string): void {
		this.clearTickInterval();
		this.spinner.warn({ text: message || this.formatText() });
	}

	/**
	 * Stop the spinner
	 */
	stop(): void {
		this.clearTickInterval();
		this.spinner.stop();
	}
}
