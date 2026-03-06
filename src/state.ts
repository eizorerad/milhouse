/**
 * State — RunStore class. One class for all state operations.
 * All paths encapsulated. All operations go through here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, RunCost, RunMeta, Task } from "./types.ts";

function now(): string {
	return new Date().toISOString();
}

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, data: unknown): void {
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
}

function readTextFile(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function randomId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

function datestamp(): string {
	return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

interface RunsIndex {
	runs: Array<{ id: string; scope?: string; created_at: string; phase: string }>;
}

export class RunStore {
	constructor(
		readonly workDir: string,
		readonly runId: string,
	) {}

	// ─── Paths ─────────────────────────────────────────────────────

	private get dir() {
		return join(this.workDir, ".milhouse", "runs", this.runId);
	}
	private get stateDir() {
		return join(this.dir, "state");
	}
	private get plansDir() {
		return join(this.dir, "plans");
	}

	// ─── Issues ────────────────────────────────────────────────────

	loadIssues(): Issue[] {
		return readJson<Issue[]>(join(this.stateDir, "issues.json"), []);
	}

	saveIssues(issues: Issue[]): void {
		writeJson(join(this.stateDir, "issues.json"), issues);
	}

	updateIssue(id: string, update: Partial<Issue>): void {
		const issues = this.loadIssues();
		const idx = issues.findIndex((i) => i.id === id);
		if (idx >= 0) {
			issues[idx] = { ...issues[idx], ...update, updated_at: now() };
			this.saveIssues(issues);
		}
	}

	// ─── Tasks ─────────────────────────────────────────────────────

	loadTasks(): Task[] {
		return readJson<Task[]>(join(this.stateDir, "tasks.json"), []);
	}

	saveTasks(tasks: Task[]): void {
		writeJson(join(this.stateDir, "tasks.json"), tasks);
	}

	updateTask(id: string, update: Partial<Task>): void {
		const tasks = this.loadTasks();
		const idx = tasks.findIndex((t) => t.id === id);
		if (idx >= 0) {
			tasks[idx] = { ...tasks[idx], ...update, updated_at: now() };
			this.saveTasks(tasks);
		}
	}

	// ─── Run Meta ──────────────────────────────────────────────────

	loadMeta(): RunMeta {
		return readJson<RunMeta>(join(this.dir, "meta.json"), {
			id: this.runId,
			phase: "scan",
			issues_found: 0,
			issues_validated: 0,
			tasks_total: 0,
			tasks_completed: 0,
			tasks_failed: 0,
			created_at: now(),
			updated_at: now(),
		});
	}

	saveMeta(meta: RunMeta): void {
		writeJson(join(this.dir, "meta.json"), meta);
	}

	updatePhase(phase: string): void {
		const meta = this.loadMeta();
		meta.phase = phase;
		meta.updated_at = now();
		this.saveMeta(meta);
	}

	updateStats(stats: Partial<RunMeta>): void {
		const meta = this.loadMeta();
		Object.assign(meta, stats, { updated_at: now() });
		this.saveMeta(meta);
	}

	// ─── Plans ─────────────────────────────────────────────────────

	savePlan(issueId: string, content: string): void {
		if (!existsSync(this.plansDir)) mkdirSync(this.plansDir, { recursive: true });
		writeFileSync(join(this.plansDir, `${issueId}.md`), content);
	}

	loadPlan(issueId: string): string | null {
		return readTextFile(join(this.plansDir, `${issueId}.md`));
	}

	// ─── Cost ─────────────────────────────────────────────────────

	loadCost(): RunCost {
		return readJson<RunCost>(join(this.stateDir, "cost.json"), {
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
		});
	}

	saveCost(cost: RunCost): void {
		writeJson(join(this.stateDir, "cost.json"), cost);
	}

	// ─── Verification ──────────────────────────────────────────────

	saveVerification(data: unknown): void {
		writeJson(join(this.stateDir, "verification.json"), data);
	}

	loadVerification(): unknown {
		return readJson<unknown>(join(this.stateDir, "verification.json"), null);
	}

	// ─── Static Constructors ───────────────────────────────────────

	static create(workDir: string, scope?: string): RunStore {
		const runId = `run-${datestamp()}-${randomId()}`;
		const store = new RunStore(workDir, runId);

		mkdirSync(store.stateDir, { recursive: true });
		mkdirSync(store.plansDir, { recursive: true });

		store.saveMeta({
			id: runId,
			scope,
			phase: "scan",
			issues_found: 0,
			issues_validated: 0,
			tasks_total: 0,
			tasks_completed: 0,
			tasks_failed: 0,
			created_at: now(),
			updated_at: now(),
		});

		// Update runs index
		const indexPath = join(workDir, ".milhouse", "runs-index.json");
		const index = readJson<RunsIndex>(indexPath, { runs: [] });
		index.runs.push({ id: runId, scope, created_at: now(), phase: "scan" });
		writeJson(indexPath, index);

		return store;
	}

	static latest(workDir: string): RunStore | null {
		const indexPath = join(workDir, ".milhouse", "runs-index.json");
		const index = readJson<RunsIndex>(indexPath, { runs: [] });
		if (index.runs.length === 0) return null;
		const last = index.runs[index.runs.length - 1];
		return new RunStore(workDir, last.id);
	}

	static list(workDir: string): RunsIndex["runs"] {
		const indexPath = join(workDir, ".milhouse", "runs-index.json");
		return readJson<RunsIndex>(indexPath, { runs: [] }).runs;
	}

	static byId(workDir: string, runId: string): RunStore {
		return new RunStore(workDir, runId);
	}
}
