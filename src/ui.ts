/**
 * UI — themed spinner, parallel progress, logger.
 * Same visual feel as v0.2 but zero extra deps (no ora, nanospinner).
 * Uses picocolors + raw stdout writes.
 */

import pc from "picocolors";

// ─── Verbose flag ────────────────────────────────────────────────────────────

let verbose = false;

export function setVerbose(v: boolean): void {
	verbose = v;
	if (v) process.env.VERBOSE = "1";
}

// ─── Hex color support ──────────────────────────────────────────────────────

function hex(color: string): (text: string) => string {
	if (!pc.isColorSupported) return (t: string) => t;
	const h = color.replace("#", "");
	const r = Number.parseInt(h.substring(0, 2), 16);
	const g = Number.parseInt(h.substring(2, 4), 16);
	const b = Number.parseInt(h.substring(4, 6), 16);
	return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

// ─── Theme ──────────────────────────────────────────────────────────────────

export const theme = {
	brand: hex("#7C3AED"),       // Purple
	accent: hex("#06B6D4"),      // Cyan
	success: hex("#10B981"),     // Green
	warning: hex("#F59E0B"),     // Amber
	error: hex("#EF4444"),       // Red
	info: hex("#3B82F6"),        // Blue

	phase: {
		scan: hex("#8B5CF6"),       // Violet
		validate: hex("#06B6D4"),   // Cyan
		plan: hex("#3B82F6"),       // Blue
		consolidate: hex("#10B981"),// Green
		exec: hex("#F59E0B"),       // Amber
		verify: hex("#EC4899"),     // Pink
	} as Record<string, (t: string) => string>,
};


const severityTextColor: Record<string, (t: string) => string> = {
	CRITICAL: theme.error,
	HIGH: theme.warning,
	MEDIUM: theme.info,
	LOW: pc.dim,
};


// ─── Severity colors ────────────────────────────────────────────────────────

export function severityColor(severity: string, text: string): string {
	const color = severityTextColor[severity];
	return color ? color(text) : text;
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escape codes from a string to get visible width. */
export function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Banner ─────────────────────────────────────────────────────────────────

export function printBanner(): void {
	const lines = [
		{
			raw: " __  __ ___ _     _   _  ___  _   _ ____  _____ ",
			styled: pc.bold(theme.brand(" __  __ ___ _     _   _  ___  _   _ ____  _____ ")),
		},
		{
			raw: "|  \\/  |_ _| |   | | | |/ _ \\| | | / ___|| ____|",
			styled: pc.bold(theme.brand("|  \\/  |_ _| |   | | | |/ _ \\| | | / ___|| ____|")),
		},
		{
			raw: "| |\\/| || || |   | |_| | | | | | | \\___ \\|  _|  ",
			styled: pc.bold(theme.brand("| |\\/| || || |   | |_| | | | | | | \\___ \\|  _|  ")),
		},
		{
			raw: "| |  | || || |___|  _  | |_| | |_| |___) | |___ ",
			styled: pc.bold(theme.brand("| |  | || || |___|  _  | |_| | |_| |___) | |___ ")),
		},
		{
			raw: "|_|  |_|___|_____|_| |_|\\___/ \\___/|____/|_____|",
			styled: pc.bold(theme.brand("|_|  |_|___|_____|_| |_|\\___/ \\___/|____/|_____|")),
		},
		{
			raw: "MILHOUSE // Correctness-first AI coding orchestrator",
			styled: `${pc.bold(theme.brand("MILHOUSE"))}${pc.gray(" // Correctness-first AI coding orchestrator")}`,
		},
	];

	const innerWidth = Math.max(...lines.map((line) => line.raw.length));
	const border = theme.brand(`+${"-".repeat(innerWidth + 2)}+`);
	console.log("");
	console.log(border);
	for (const line of lines) {
		const padding = " ".repeat(Math.max(0, innerWidth - line.raw.length));
		console.log(`${theme.brand("|")} ${line.styled}${padding} ${theme.brand("|")}`);
	}
	console.log(border);
	console.log("");
}

// ─── Issue list ─────────────────────────────────────────────────────────────

import type { Issue } from "./types.ts";

const statusColor: Record<string, (t: string) => string> = {
	CONFIRMED: theme.success,
	FALSE: theme.error,
	PARTIAL: theme.warning,
	MISDIAGNOSED: theme.accent,
};

const issueSeverityColor: Record<string, (t: string) => string> = {
	CRITICAL: theme.error,
	HIGH: theme.error,
	MEDIUM: theme.warning,
};

export function printIssueList(issues: Issue[]): void {
	for (const issue of issues) {
		const sc = statusColor[issue.status] ?? pc.dim;
		const vc = issueSeverityColor[issue.severity] ?? pc.dim;
		console.log(`  ${sc(`[${issue.status}]`)} ${vc(`[${issue.severity}]`)} ${issue.title} ${pc.dim(`(${issue.id})`)}`);
	}
}

// ─── Progress bar ───────────────────────────────────────────────────────────

export function progressBar(current: number, total: number, width = 20): string {
	if (total === 0) return pc.dim("-".repeat(width));
	const filled = Math.round((current / total) * width);
	const empty = width - filled;
	const bar = theme.brand("#".repeat(filled)) + pc.dim("-".repeat(empty));
	const pct = Math.round((current / total) * 100);
	return `[${bar}] ${pc.yellow(String(pct))}%`;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

export const log = {
	info: (msg: string) => console.log(`${theme.info("*")} ${msg}`),
	success: (msg: string) => console.log(`${theme.success("+")} ${msg}`),
	warn: (msg: string) => console.log(`${theme.warning("!")} ${msg}`),
	error: (msg: string) => console.error(`${theme.error("x")} ${msg}`),
	debug: (msg: string) => {
		if (verbose) console.log(pc.dim(`  ${msg}`));
	},

	phase: (name: string) => {
		const color = theme.phase[name] ?? theme.brand;
		const sep = "-".repeat(Math.min(getMaxWidth(), 60));
		console.log("");
		console.log(pc.dim(sep));
		console.log(`  ${pc.bold(color(name.toUpperCase()))}`);
		console.log(pc.dim(sep));
	},

	summary: (succeeded: number, total: number, cost: number, duration: number) => {
		const secs = (duration / 1000).toFixed(1);
		const bar = progressBar(succeeded, total, 15);
		console.log(`  ${bar}  ${theme.success(String(succeeded))}/${total} | $${cost.toFixed(2)} | ${pc.dim(`${secs}s`)}`);
	},
};

// ─── Time formatting ────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	if (ms <= 0) return "N/A";
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remSecs = secs % 60;
	if (mins < 60) return `${mins}m ${remSecs}s`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hours}h ${remMins}m`;
}

function formatElapsed(startTime: number): string {
	return formatDuration(Date.now() - startTime);
}

// ─── Terminal width ─────────────────────────────────────────────────────────

function getMaxWidth(): number {
	return Math.max((process.stdout.columns || 80) - 4, 40);
}

function clearLine(): void {
	process.stdout.write("\x1b[K");
}

// ─── Spinner frames ─────────────────────────────────────────────────────────

const FRAMES = ["|", "/", "-", "\\"];

// ─── Shared stop/finish helper ──────────────────────────────────────────────

function finishLine(
	timer: ReturnType<typeof setInterval> | null,
	finalText: string,
): void {
	if (timer) clearInterval(timer);
	process.stdout.write(`\r${finalText}`);
	clearLine();
	process.stdout.write("\n");
}

// ─── Single Spinner (for single-item phases like scan, consolidate) ─────────

export class Spinner {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private text: string;
	private startTime: number;

	constructor(text: string) {
		this.text = text;
		this.startTime = Date.now();
	}

	start(): this {
		this.timer = setInterval(() => {
			this.render();
			this.frame++;
		}, 120);
		return this;
	}

	private render(): void {
		const f = FRAMES[this.frame % FRAMES.length];
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		process.stdout.write(`\r  ${theme.brand(f)} ${this.text} ${time} `);
		clearLine();
	}

	update(text: string): void {
		this.text = text;
	}

	/** Write a line cleanly during active spinner rendering. */
	writeLine(msg: string): void {
		if (this.timer) clearInterval(this.timer);
		process.stdout.write("\r\x1b[K");
		process.stdout.write(msg + "\n");
		if (this.timer) {
			this.timer = setInterval(() => {
				this.render();
				this.frame++;
			}, 120);
		}
	}

	private stop(finalText: string): void {
		finishLine(this.timer, finalText);
		this.timer = null;
	}

	success(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		this.stop(`  ${theme.success("+")} ${text ?? this.text} ${time}`);
	}

	fail(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		this.stop(`  ${theme.error("x")} ${text ?? this.text} ${time}`);
	}

	warn(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		this.stop(`  ${theme.warning("!")} ${text ?? this.text} ${time}`);
	}
}

// ─── Parallel Progress Spinner (for multi-item phases) ──────────────────────

interface Slot {
	id: string | null;
	status: string;
}

export class ParallelSpinner {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private startTime: number;
	private slots: Map<number, Slot>;
	private maxSlots: number;
	private completed = 0;
	private total: number;
	private label: string;

	constructor(maxSlots: number, total: number, label: string) {
		this.maxSlots = maxSlots;
		this.total = total;
		this.label = label;
		this.startTime = Date.now();
		this.slots = new Map();
		for (let i = 1; i <= maxSlots; i++) {
			this.slots.set(i, { id: null, status: "idle" });
		}
	}

	start(): this {
		this.timer = setInterval(() => {
			this.render();
			this.frame++;
		}, 120);
		return this;
	}

	private render(): void {
		const f = FRAMES[this.frame % FRAMES.length];
		const progress = pc.yellow(`[${this.completed}/${this.total}]`);
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);

		// Build slot display
		const parts: string[] = [];
		for (let i = 1; i <= this.maxSlots; i++) {
			const slot = this.slots.get(i)!;
			if (slot.id && slot.status !== "idle") {
				const shortId = slot.id.length > 10 ? slot.id.slice(0, 8) : slot.id;
				const shortStatus = slot.status.length > 12 ? `${slot.status.slice(0, 10)}..` : slot.status;
				parts.push(`${shortId}:${pc.cyan(shortStatus)}`);
			}
		}
		const slotsStr = parts.length > 0 ? parts.join(pc.dim(" | ")) : pc.dim("waiting");

		const bar = progressBar(this.completed, this.total, 10);

		const maxW = getMaxWidth();
		const raw = `\r  ${theme.brand(f)} ${progress} ${slotsStr} ${bar} ${time}`;
		// Truncate if needed
		const visible = raw.replace(/\x1b\[[0-9;]*m/g, "");
		if (visible.length > maxW) {
			process.stdout.write(`\r  ${theme.brand(f)} ${progress} ${bar} ${time} `);
		} else {
			process.stdout.write(raw);
		}
		clearLine();
	}

	/** Acquire a slot for an item. Returns slot number. */
	acquireSlot(itemId: string): number {
		for (let i = 1; i <= this.maxSlots; i++) {
			const slot = this.slots.get(i)!;
			if (!slot.id || slot.status === "idle") {
				this.slots.set(i, { id: itemId, status: "starting" });
				return i;
			}
		}
		// Fallback: reuse slot 1
		this.slots.set(1, { id: itemId, status: "starting" });
		return 1;
	}

	/** Update a slot's status text. */
	updateSlot(slotNum: number, status: string): void {
		const slot = this.slots.get(slotNum);
		if (slot?.id) slot.status = status;
	}

	/** Release a slot after item completes. */
	releaseSlot(slotNum: number): void {
		this.completed++;
		this.slots.set(slotNum, { id: null, status: "idle" });
	}

	/** Write a line cleanly during active spinner rendering. */
	writeLine(msg: string): void {
		if (this.timer) clearInterval(this.timer);
		process.stdout.write("\r\x1b[K");
		process.stdout.write(msg + "\n");
		if (this.timer) {
			this.timer = setInterval(() => {
				this.render();
				this.frame++;
			}, 120);
		}
	}

	private stop(finalText: string): void {
		finishLine(this.timer, finalText);
		this.timer = null;
	}

	success(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		const bar = progressBar(this.completed, this.total, 10);
		this.stop(
			`  ${theme.success("+")} ${text ?? this.label} ${pc.yellow(`[${this.completed}/${this.total}]`)} ${bar} ${time}`,
		);
	}

	fail(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		this.stop(`  ${theme.error("x")} ${text ?? this.label} ${time}`);
	}

	warn(text?: string): void {
		const time = pc.dim(`[${formatElapsed(this.startTime)}]`);
		this.stop(`  ${theme.warning("!")} ${text ?? this.label} ${time}`);
	}
}
