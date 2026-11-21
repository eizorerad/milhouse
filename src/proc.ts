/** One way to run subprocesses (git, project commands, the agent) with a timeout that kills the whole tree. */

import { spawn } from "node:child_process";

export interface RunOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Written to stdin. Without it stdin is closed. */
	input?: string;
	timeoutMs?: number;
	/** Run `file` as a shell command line (args are ignored). */
	shell?: boolean;
	/** Stop whatever the process left running in its group once it has finished (agents and project checks; not git, and not setup, which may start a service on purpose). */
	reap?: boolean;
	/** Bytes of each output stream to keep (the end of it). */
	maxOutput?: number;
	/**
	 * The signal the process gets when milhouse itself exits or is interrupted. By default it is killed at
	 * once. Git is asked to stop instead (SIGTERM): it then removes its lock files, also in the user's checkout.
	 */
	exitSignal?: NodeJS.Signals;
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** The output was longer than `maxOutput`: only its end is here. */
	truncated: boolean;
}

/** What a process that ran out of time gets to stop by itself (and to stop what it started: a container, a server) before it is killed. */
const TERM_GRACE_MS = 3000;
const KILL_GRACE_MS = 3000;
/** After the process exited: how long to wait for the rest of its output. A background child that keeps the pipes open must not keep us. */
const DRAIN_MS = 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The end of a stream: a command that never stops printing must not use up the memory. */
class Tail {
	private chunks: Buffer[] = [];
	private size = 0;
	truncated = false;

	constructor(private readonly limit: number) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		if (this.size > this.limit * 2) {
			const all = Buffer.concat(this.chunks);
			this.chunks = [Buffer.from(all.subarray(all.length - this.limit))]; // a copy: a view keeps `all` alive
			this.size = this.limit;
			this.truncated = true;
		}
	}

	toString(): string {
		const all = Buffer.concat(this.chunks);
		this.truncated ||= all.length > this.limit;
		return all.subarray(Math.max(all.length - this.limit, 0)).toString("utf-8");
	}
}

/**
 * Children are detached (their own process group, so a timeout can kill their whole tree), which means
 * Ctrl-C in the terminal does not reach them. Stop them ourselves when milhouse exits or is interrupted.
 */
const running = new Map<number, NodeJS.Signals>();
let cleanupInstalled = false;

function installCleanup(): void {
	if (cleanupInstalled) return;
	cleanupInstalled = true;
	process.on("exit", () => {
		for (const [pid, signal] of running) killTree(pid, signal);
	});
	process.once("SIGINT", () => process.exit(130));
	process.once("SIGTERM", () => process.exit(143));
	process.once("SIGHUP", () => process.exit(129)); // the terminal was closed
}

function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (pid === undefined) return;
	try {
		// A detached child leads its own process group: this also stops its grandchildren.
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		// Already gone.
	}
}

export function run(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			shell: opts.shell ?? false,
			detached: process.platform !== "win32",
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		installCleanup();
		if (child.pid !== undefined) running.set(child.pid, opts.exitSignal ?? "SIGKILL");
		const limit = opts.maxOutput ?? MAX_OUTPUT_BYTES;
		const stdout = new Tail(limit);
		const stderr = new Tail(limit);
		let timedOut = false;
		let settled = false;
		let drain: ReturnType<typeof setTimeout> | undefined;
		let escalate: ReturnType<typeof setTimeout> | undefined;

		const finish = (code: number | null, extraErr = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			clearTimeout(escalate);
			if (child.pid !== undefined) running.delete(child.pid);
			// After a timeout nothing of the tree may stay, whether it stopped when asked or not.
			if (opts.reap || timedOut) killTree(child.pid);
			// Let go of the pipes: a background child that still holds them must not keep us alive.
			child.stdout?.destroy();
			child.stderr?.destroy();
			const result = { stdout: stdout.toString(), stderr: stderr.toString() + extraErr };
			resolve({
				code,
				...result,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
			});
		};

		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killTree(child.pid, "SIGTERM"); // ask first: a test runner removes what it started
					escalate = setTimeout(() => {
						killTree(child.pid);
						// If a stray process keeps the pipes open, do not wait for it forever.
						setTimeout(() => finish(null), KILL_GRACE_MS).unref();
					}, TERM_GRACE_MS);
				}, opts.timeoutMs)
			: undefined;

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (err) => finish(null, err.message));
		// "close" waits until every holder of the pipes is gone, "exit" does not: a command that started a
		// background server has finished when it exits.
		child.on("exit", (code) => {
			clearTimeout(timer); // it finished in time: draining its pipes must not turn that into a timeout
			drain = setTimeout(() => finish(code), DRAIN_MS);
		});
		child.on("close", (code) => finish(code));
		if (opts.input !== undefined) {
			child.stdin?.on("error", () => {}); // the child may exit before reading everything
			child.stdin?.end(opts.input);
		}
	});
}
