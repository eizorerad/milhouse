/** Run state: JSON files under .milhouse/runs/<id>/. Writes are atomic; corrupt files fail loudly. */

import { createHash } from "node:crypto";
import {
	constants,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { emptyCost } from "./cost.ts";
import type { Issue, Phase, RunCost, RunMeta, RunStatus, Task } from "./types.ts";
import { errorMessage, generateId, now } from "./util.ts";

export const STATE_DIR = ".milhouse";

/** The branch that keeps a failed attempt at an issue for inspection. */
export const parkBranch = (issueId: string): string => `mh-failed/${issueId}`;

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

	/**
	 * Worktree where exec works. Its HEAD is detached; accepted work is recorded in `ref`.
	 * It is outside the project: inside it, a command would find the packages installed in the project's own
	 * directory, and checks would pass on work that does not install them. It is not in the temporary folder,
	 * which other users share and which may be small or mounted noexec. MILHOUSE_WORK_DIR moves it elsewhere.
	 */
	get worktree(): string {
		const earlier = join(this.workDir, STATE_DIR, "work", this.runId); // where 0.5.1 put it
		if (existsSync(earlier)) return earlier;
		const chosen = process.env.MILHOUSE_WORK_DIR?.trim();
		if (chosen) return join(resolve(chosen), this.runId);
		// By default the user's cache folder (XDG_CACHE_HOME if it is an absolute path), and in it one for this
		// project: two clones may have a run of the same id.
		const xdg = process.env.XDG_CACHE_HOME?.trim();
		const cache = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
		const project = createHash("sha1").update(this.workDir).digest("hex").slice(0, 10);
		return join(cache, "milhouse", project, this.runId);
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

	// ─── Log ─────────────────────────────────────────────────────────

	/** Adds one line to the run's log (events.jsonl): what happened, for whoever reads the run afterwards. */
	logEvent(event: Record<string, unknown>): void {
		mkdirSync(dirname(this.file("events.jsonl")), { recursive: true });
		// Not through a symlink that somebody planted, as writeJson does not either.
		const flags =
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
		const fd = openSync(this.file("events.jsonl"), flags, 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ at: now(), ...event })}\n`);
		} finally {
			closeSync(fd);
		}
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
	 * Remove finished runs older than `days`. Stopped runs stay, because they can be resumed, and so do runs
	 * that never said how they ended (a crash): `all` takes those too. `before` runs first for each one, to
	 * remove what the run left outside its directory; if it throws, the run is kept.
	 */
	static async clean(
		workDir: string,
		days: number,
		before?: (store: RunStore) => Promise<void>,
		all = false,
	): Promise<{ removed: string[]; kept: Array<{ id: string; reason: string }> }> {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const old = RunStore.list(workDir).filter(
			(run) =>
				(all || run.status === "completed" || run.status === "failed") &&
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
