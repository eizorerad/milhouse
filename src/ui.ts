/** Terminal output: logger, banner and a one-line progress indicator. */

import pc from "picocolors";

let verbose = false;
export const setVerbose = (value: boolean): void => {
	verbose = value;
};

/** True while a spinner line is on screen: anything else we print must erase it first. */
let spinnerShown = false;

function emit(stream: "log" | "error", message: string): void {
	if (spinnerShown) process.stdout.write("\r\x1b[K");
	console[stream](message);
}

export const log = {
	info: (message: string) => emit("log", `${pc.blue("*")} ${message}`),
	success: (message: string) => emit("log", `${pc.green("+")} ${message}`),
	warn: (message: string) => emit("log", `${pc.yellow("!")} ${message}`),
	error: (message: string) => emit("error", `${pc.red("x")} ${message}`),
	debug: (message: string) => {
		if (verbose) emit("log", pc.dim(`  ${message}`));
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

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Shows which items of a phase are running. Plain log lines when stdout is not a terminal. */
export class Progress {
	private done = 0;
	private frame = 0;
	private readonly active = new Set<string>();
	private readonly startedAt = Date.now();
	private readonly tty = Boolean(process.stdout.isTTY);
	private readonly timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly label: string,
		private readonly total: number,
	) {
		if (this.tty) {
			this.timer = setInterval(() => this.render(), 120);
			spinnerShown = true;
		}
	}

	begin(id: string): void {
		this.active.add(id);
		if (!this.tty) console.log(`  … ${id}`);
	}

	end(id: string, ok: boolean, note = ""): void {
		this.active.delete(id);
		this.done++;
		const mark = ok ? pc.green("+") : pc.red("x");
		this.print(`${mark} ${id}${note ? pc.dim(` — ${note}`) : ""}`);
	}

	note(message: string): void {
		this.print(`${pc.yellow("!")} ${message}`);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.tty) process.stdout.write("\r\x1b[K");
		spinnerShown = false;
	}

	private print(line: string): void {
		emit("log", `  ${line}`);
	}

	private render(): void {
		const frame = pc.magenta(FRAMES[this.frame++ % FRAMES.length]);
		const running = [...this.active].join(", ");
		const elapsed = formatDuration(Date.now() - this.startedAt);
		process.stdout.write(
			`\r  ${frame} ${this.label} ${this.done}/${this.total} ${pc.dim(`${running} ${elapsed}`)}\x1b[K`,
		);
	}
}
