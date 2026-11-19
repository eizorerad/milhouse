/** Run state: JSON files under .milhouse/runs/<id>/. Writes are atomic; corrupt files fail loudly. */

import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { emptyCost } from "./cost.ts";
import type { Issue, Phase, RunCost, RunMeta, RunStatus, Task } from "./types.ts";
import { errorMessage, generateId, now } from "./util.ts";

export const STATE_DIR = ".milhouse";

/** Keep runtime files out of git without touching the user's own .gitignore. */
export function ensureIgnoreFile(workDir: string): void {
	const path = join(workDir, STATE_DIR, ".gitignore");
	if (existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "runs/\nwork/\nlock\n");
}

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch (err) {
		throw new Error(`Corrupt state file ${path}: ${errorMessage(err)}. Fix or delete it.`);
	}
}

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	// A fresh name, created exclusively: never follow a path somebody planted in the repository.
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: "wx" });
	renameSync(tmp, path);
}

/** Run ids become paths and ref names, so only this shape is ever accepted. */
const RUN_ID = /^run-[A-Za-z0-9_-]+$/;

export class RunStore {
	constructor(
		readonly workDir: string,
		readonly runId: string,
	) {
		if (!RUN_ID.test(runId)) throw new Error(`Invalid run id "${runId}".`);
	}

	/**
	 * Tip of the accepted work of this run. A ref outside refs/heads: unlike a branch it cannot be
	 * checked out or force-moved by an agent running git in the worktree.
	 */
	get ref(): string {
		return `refs/milhouse/${this.runId}`;
	}

	/** Worktree where exec works. Its HEAD is detached; accepted work is recorded in `ref`. */
	get worktree(): string {
		return join(this.workDir, STATE_DIR, "work", this.runId);
	}

	private file(name: string): string {
		return join(this.workDir, STATE_DIR, "runs", this.runId, name);
	}

	// ─── Issues & tasks ──────────────────────────────────────────────

	loadIssues(): Issue[] {
		return readJson<Issue[]>(this.file("issues.json"), []);
	}

	saveIssues(issues: Issue[]): void {
		writeJson(this.file("issues.json"), issues);
	}

	updateIssue(id: string, patch: Partial<Issue>): void {
		this.saveIssues(this.loadIssues().map((i) => (i.id === id ? { ...i, ...patch } : i)));
	}

	loadTasks(): Task[] {
		return readJson<Task[]>(this.file("tasks.json"), []);
	}

	saveTasks(tasks: Task[]): void {
		writeJson(this.file("tasks.json"), tasks);
	}

	updateTasks(ids: Iterable<string>, patch: Partial<Task>): void {
		const selected = new Set(ids);
		this.saveTasks(this.loadTasks().map((t) => (selected.has(t.id) ? { ...t, ...patch } : t)));
	}

	// ─── Meta ────────────────────────────────────────────────────────

	loadMeta(): RunMeta {
		const meta = readJson<RunMeta | null>(this.file("meta.json"), null);
		if (!meta) throw new Error(`Run "${this.runId}" has no meta.json.`);
		return meta;
	}

	private patchMeta(patch: Partial<RunMeta>): void {
		writeJson(this.file("meta.json"), { ...this.loadMeta(), ...patch, updated_at: now() });
	}

	/** After a merge the run continues from the merged state. */
	setBase(sha: string): void {
		this.patchMeta({ base_sha: sha });
	}

	startPhase(phase: Phase): void {
		this.patchMeta({ phase, status: "running" });
	}

	completePhase(phase: Phase): void {
		this.patchMeta({ done: [...new Set([...this.loadMeta().done, phase])] });
	}

	finish(status: RunStatus): void {
		this.patchMeta({ status });
	}

	// ─── Cost ────────────────────────────────────────────────────────

	loadCost(): RunCost {
		return readJson<RunCost>(this.file("cost.json"), emptyCost());
	}

	saveCost(cost: RunCost): void {
		writeJson(this.file("cost.json"), cost);
	}

	// ─── Runs ────────────────────────────────────────────────────────

	static create(
		workDir: string,
		scope: string | undefined,
		base: { branch: string; sha: string },
	): RunStore {
		ensureIgnoreFile(workDir);
		const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		const store = new RunStore(workDir, generateId(`run-${stamp}`));
		const meta: RunMeta = {
			id: store.runId,
			scope,
			status: "running",
			phase: "scan",
			done: [],
			base_branch: base.branch,
			base_sha: base.sha,
			created_at: now(),
			updated_at: now(),
		};
		writeJson(store.file("meta.json"), meta);
		return store;
	}

	/** All runs, oldest first. */
	static list(workDir: string): RunMeta[] {
		const root = join(workDir, STATE_DIR, "runs");
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((name) => RUN_ID.test(name))
			.map((name) => new RunStore(workDir, name))
			.filter((store) => existsSync(store.file("meta.json")))
			.map((store) => ({ ...store.loadMeta(), id: store.runId })) // the directory name is the id
			.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	static latest(workDir: string): RunStore | null {
		const last = RunStore.list(workDir).at(-1);
		return last ? new RunStore(workDir, last.id) : null;
	}

	static byId(workDir: string, runId: string): RunStore {
		const store = RUN_ID.test(runId) ? new RunStore(workDir, runId) : undefined;
		if (!store || !existsSync(store.file("meta.json"))) {
			throw new Error(`Run "${runId}" not found. Use --list-runs to see available runs.`);
		}
		return store;
	}

	/**
	 * Remove finished runs older than `days` (stopped runs stay: they can be resumed). `before` runs first for
	 * each one, to remove what the run left outside its directory; if it throws, the run is kept.
	 */
	static async clean(
		workDir: string,
		days: number,
		before?: (store: RunStore) => Promise<void>,
	): Promise<{ removed: string[]; kept: Array<{ id: string; reason: string }> }> {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const old = RunStore.list(workDir).filter(
			(run) =>
				(run.status === "completed" || run.status === "failed") &&
				new Date(run.created_at).getTime() < cutoff,
		);
		const removed: string[] = [];
		const kept: Array<{ id: string; reason: string }> = [];
		for (const run of old) {
			try {
				await before?.(new RunStore(workDir, run.id));
				rmSync(join(workDir, STATE_DIR, "runs", run.id), { recursive: true, force: true });
				removed.push(run.id);
			} catch (err) {
				kept.push({ id: run.id, reason: errorMessage(err) });
			}
		}
		return { removed, kept };
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A takeover that has been going on this long was abandoned by a crashed starter. */
const STALE_TAKEOVER_MS = 10_000;

/**
 * Create the lock file with its owner already inside it: written whole to a file of its own, then linked
 * into place. Creating it empty and writing afterwards would let a second starter see a lock without an
 * owner, take it for a dead one's and clear it. Throws EEXIST when somebody holds the lock.
 */
function createLock(path: string): void {
	const mine = `${path}.${process.pid}.tmp`;
	writeFileSync(mine, String(process.pid));
	try {
		linkSync(mine, path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
		writeFileSync(path, String(process.pid), { flag: "wx" }); // a filesystem without hard links
	} finally {
		rmSync(mine, { force: true });
	}
}

/** One milhouse per repository at a time. Returns the release function (also runs on exit). */
export function acquireLock(workDir: string): () => void {
	const path = join(workDir, STATE_DIR, "lock");
	const takeover = `${path}.takeover`;
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			createLock(path);
			const release = () => {
				process.off("exit", release);
				rmSync(path, { force: true });
			};
			process.once("exit", release);
			return release;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		let holder: string;
		try {
			holder = readFileSync(path, "utf-8");
		} catch {
			continue; // released in the meantime
		}
		const pid = Number(holder);
		if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
			throw new Error(`Another milhouse is running in this repository (pid ${pid}).`);
		}

		// The holder is dead. Only one starter at a time may clear its lock: two starters that both saw
		// the stale lock would otherwise delete each other's fresh one and both run.
		try {
			mkdirSync(takeover);
		} catch {
			const started = statSync(takeover, { throwIfNoEntry: false })?.mtimeMs ?? 0;
			if (Date.now() - started > STALE_TAKEOVER_MS) {
				rmSync(takeover, { recursive: true, force: true });
			} else {
				Bun.sleepSync(20);
			}
			continue;
		}
		try {
			if (readFileSync(path, "utf-8") === holder) rmSync(path, { force: true });
		} catch {
			// already gone
		} finally {
			rmSync(takeover, { recursive: true, force: true });
		}
	}
	throw new Error("Could not acquire the milhouse lock.");
}
