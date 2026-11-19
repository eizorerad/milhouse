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
	/** Stop whatever the process left running in its group once it has finished (agents, not project commands). */
	reap?: boolean;
	/** Bytes of each output stream to keep (the end of it). */
	maxOutput?: number;
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** The output was longer than `maxOutput`: only its end is here. */
	truncated: boolean;
}

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
			this.chunks = [all.subarray(all.length - this.limit)];
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
const running = new Set<number>();
let cleanupInstalled = false;

function installCleanup(): void {
	if (cleanupInstalled) return;
	cleanupInstalled = true;
	process.on("exit", () => {
		for (const pid of running) killTree(pid);
	});
	process.once("SIGINT", () => process.exit(130));
	process.once("SIGTERM", () => process.exit(143));
	process.once("SIGHUP", () => process.exit(129)); // the terminal was closed
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		// A detached child leads its own process group: this also stops its grandchildren.
		process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
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
		if (child.pid !== undefined) running.add(child.pid);
		const limit = opts.maxOutput ?? MAX_OUTPUT_BYTES;
		const stdout = new Tail(limit);
		const stderr = new Tail(limit);
		let timedOut = false;
		let settled = false;
		let drain: ReturnType<typeof setTimeout> | undefined;

		const finish = (code: number | null, extraErr = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			if (child.pid !== undefined) running.delete(child.pid);
			if (opts.reap) killTree(child.pid);
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
					killTree(child.pid);
					// If a stray process keeps the pipes open, do not wait for it forever.
					setTimeout(() => finish(null), KILL_GRACE_MS).unref();
				}, opts.timeoutMs)
			: undefined;

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (err) => finish(null, err.message));
		// "close" waits until every holder of the pipes is gone, "exit" does not: a command that started a
		// background server has finished when it exits.
		child.on("exit", (code) => {
			drain = setTimeout(() => finish(code), DRAIN_MS);
		});
		child.on("close", (code) => finish(code));
		if (opts.input !== undefined) {
			child.stdin?.on("error", () => {}); // the child may exit before reading everything
			child.stdin?.end(opts.input);
		}
	});
}
