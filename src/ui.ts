/** Terminal output: logger, banner and a one-line progress indicator. */

import pc from "picocolors";
import { stripControl } from "./util.ts";

let verbose = false;
export const setVerbose = (value: boolean): void => {
	verbose = value;
};

/** True while a spinner line is on screen: anything else we print must erase it first. */
let spinnerShown = false;

function clearSpinner(): void {
	if (!spinnerShown) return;
	process.stdout.write("\r\x1b[K");
	spinnerShown = false;
}

function emit(stream: "log" | "error", message: string): void {
	clearSpinner();
	console[stream](message);
}

/** What an agent, git or the repository said: shown, but never allowed to drive the terminal. */
const text = stripControl;

export const log = {
	info: (message: string) => emit("log", `${pc.blue("*")} ${text(message)}`),
	success: (message: string) => emit("log", `${pc.green("+")} ${text(message)}`),
	warn: (message: string) => emit("log", `${pc.yellow("!")} ${text(message)}`),
	error: (message: string) => emit("error", `${pc.red("x")} ${text(message)}`),
	debug: (message: string) => {
		if (verbose) emit("log", pc.dim(`  ${text(message)}`));
	},
	phase: (name: string) => {
		emit("log", `\n${pc.dim("-".repeat(48))}\n  ${pc.bold(pc.magenta(name.toUpperCase()))}`);
	},
};

export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(ms, 0) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const BANNER = [
	" __  __ ___ _     _   _  ___  _   _ ____  _____ ",
	"|  \\/  |_ _| |   | | | |/ _ \\| | | / ___|| ____|",
	"| |\\/| || || |   | |_| | | | | | | \\___ \\|  _|  ",
	"| |  | || || |___|  _  | |_| | |_| |___) | |___ ",
	"|_|  |_|___|_____|_| |_|\\___/ \\___/|____/|_____|",
];

export function printBanner(version: string): void {
	console.log(`\n${BANNER.map((line) => pc.bold(pc.magenta(line))).join("\n")}`);
	console.log(pc.dim(` Correctness-first AI coding orchestrator  v${version}\n`));
}

// Plain ASCII: a terminal without UTF-8 (a CI log, an old console) must not show garbage.
const FRAMES = ["|", "/", "-", "\\"];

/** Shows which items of a phase are running. Plain log lines when stdout is not a terminal. */
export class Progress {
	private done = 0;
	private frame = 0;
	private readonly active: string[] = []; // parallel items may have the same display name
	private readonly startedAt = Date.now();
	private readonly timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly label: string,
		private readonly total: number,
	) {
		if (process.stdout.isTTY && process.stdout.columns > 1 && process.env.TERM !== "dumb") {
			this.timer = setInterval(() => this.render(), 120);
		}
	}

	begin(id: string): void {
		this.active.push(id);
		if (!this.timer) console.log(`  ... ${text(id)}`);
	}

	end(id: string, ok: boolean, note = ""): void {
		const index = this.active.indexOf(id);
		if (index >= 0) this.active.splice(index, 1);
		this.done++;
		const mark = ok ? pc.green("+") : pc.red("x");
		const label = ok && note ? text(id) : `${mark} ${text(id)}`;
		this.print(`${label}${note ? pc.dim(` - ${text(note)}`) : ""}`);
	}

	note(message: string): void {
		this.print(`${pc.yellow("!")} ${text(message)}`);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		clearSpinner();
	}

	private print(line: string): void {
		emit("log", `  ${line}`);
	}

	private render(): void {
		const frame = pc.magenta(FRAMES[this.frame++ % FRAMES.length]);
		const count = `${this.done}/${this.total}`;
		const phase = `  ${frame} ${this.label} ${count}`;
		const elapsed = formatDuration(Date.now() - this.startedAt);
		const running = this.active.map((id) => text(id).replace(/\s+/g, " ")).join(", ");
		// A carriage return only rewinds one physical row. Leave the last column free to avoid wrapping.
		const columns = process.stdout.columns;
		const line = [
			running && `${phase} ${pc.dim(`${running} ${elapsed}`)}`,
			`${phase} ${pc.dim(`${this.active.length} running ${elapsed}`)}`,
			`${phase} ${pc.dim(elapsed)}`,
			count,
			frame,
		].find((candidate) => candidate && Bun.stringWidth(candidate) < columns);
		if (line) {
			process.stdout.write(`\r${line}\x1b[K`);
			spinnerShown = true;
		} else {
			clearSpinner();
		}
	}
}
