import { bus } from "../../events";
import type { Task, TaskStatus } from "../../schemas/tasks.schema";
import { TaskSelector } from "../core/selector";
import type { ITaskSource, TaskSourceStats, TaskSyncResult } from "../core/types";

/**
 * TaskSyncManager - Manages synchronization between task sources
 * Handles merging, conflict resolution, and state tracking
 */
export class TaskSyncManager {
	private sources: ITaskSource[];
	private lastSync: Map<string, Date> = new Map();
	private taskCache: Map<string, Task> = new Map();

	constructor(sources: ITaskSource[] = []) {
		this.sources = sources;
	}

	/**
	 * Add a task source
	 */
	addSource(source: ITaskSource): void {
		this.sources.push(source);
	}

	/**
	 * Remove a task source by name
	 */
	removeSource(name: string): boolean {
		const index = this.sources.findIndex((s) => s.name === name);
		if (index !== -1) {
			this.sources.splice(index, 1);
			return true;
		}
		return false;
	}

	/**
	 * Sync all sources and merge tasks
	 */
	async syncAll(): Promise<TaskSyncResult> {
		const result: TaskSyncResult = {
			added: 0,
			updated: 0,
			removed: 0,
			errors: [],
		};

		const previousTasks = new Map(this.taskCache);
		this.taskCache.clear();

		for (const source of this.sources) {
			try {
				if (!(await source.isAvailable())) {
					result.errors.push(`Source ${source.name} is not available`);
					continue;
				}

				const collection = await source.load();
				this.lastSync.set(source.name, new Date());

				for (const task of collection.tasks) {
					const existingTask = previousTasks.get(task.id);

					if (!existingTask) {
						result.added++;
					} else if (this.hasTaskChanged(existingTask, task)) {
						result.updated++;
					}

					this.taskCache.set(task.id, task);
					previousTasks.delete(task.id);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.errors.push(`Error syncing ${source.name}: ${message}`);
			}
		}

		// Remaining tasks in previousTasks were removed
		result.removed = previousTasks.size;

		// Emit sync event
		bus.emit("task:start", {
			taskId: "sync",
			title: `Synced ${result.added} added, ${result.updated} updated, ${result.removed} removed`,
		});

		return result;
	}

	/**
	 * Check if a task has changed
	 */
	private hasTaskChanged(oldTask: Task, newTask: Task): boolean {
		return (
			oldTask.status !== newTask.status ||
			oldTask.title !== newTask.title ||
			oldTask.priority !== newTask.priority
		);
	}

	/**
	 * Get all tasks from all sources
	 */
	async getAllTasks(): Promise<Task[]> {
		if (this.taskCache.size === 0) {
			await this.syncAll();
		}
		return Array.from(this.taskCache.values());
	}

	/**
	 * Get a TaskSelector for querying tasks
	 */
	async getSelector(): Promise<TaskSelector> {
		const tasks = await this.getAllTasks();
		return new TaskSelector(tasks);
	}

	/**
	 * Update task status across sources
	 */
	async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
		const task = this.taskCache.get(taskId);

		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Find the source that owns this task
		const sourceName = task.metadata.source;
		const source = this.sources.find((s) => s.name === sourceName);

		if (!source) {
			throw new Error(`Source not found for task: ${taskId}`);
		}

		await source.updateStatus(taskId, status);

		// Update cache
		this.taskCache.set(taskId, {
			...task,
			status,
			updatedAt: new Date().toISOString(),
			completedAt: status === "completed" ? new Date().toISOString() : task.completedAt,
		});
	}

	/**
	 * Get aggregated statistics from all sources
	 */
	async getStats(): Promise<TaskSourceStats> {
		const stats: TaskSourceStats = {
			total: 0,
			pending: 0,
			completed: 0,
			failed: 0,
			inProgress: 0,
			skipped: 0,
			blocked: 0,
		};

		for (const source of this.sources) {
			try {
				const sourceStats = await source.getStats();
				stats.total += sourceStats.total;
				stats.pending += sourceStats.pending;
				stats.completed += sourceStats.completed;
				stats.failed += sourceStats.failed;
				stats.inProgress += sourceStats.inProgress;
				stats.skipped += sourceStats.skipped;
				stats.blocked += sourceStats.blocked;
			} catch {
				// Skip unavailable sources
			}
		}

		return stats;
	}

	/**
	 * Get next actionable task
	 */
	async getNextTask(): Promise<Task | null> {
		const selector = await this.getSelector();
		const actionable = selector.actionable();

		if (actionable.length === 0) {
			return null;
		}

		// Sort by priority and parallel group
		const sorted = new TaskSelector(actionable.map((t) => t.toJSON()))
			.sort({ field: "priority", direction: "desc" })
			.sort({ field: "parallelGroup", direction: "asc" });

		const first = sorted.first();
		return first ? first.toJSON() : null;
	}

	/**
	 * Get tasks ready for parallel execution in a group
	 */
	async getParallelTasks(group: number): Promise<Task[]> {
		const selector = await this.getSelector();
		return selector.byGroup(group).map((t) => t.toJSON());
	}

	/**
	 * Get all parallel groups
	 */
	async getGroups(): Promise<number[]> {
		const selector = await this.getSelector();
		return selector.groups();
	}

	/**
	 * Get last sync time for a source
	 */
	getLastSyncTime(sourceName: string): Date | null {
		return this.lastSync.get(sourceName) || null;
	}

	/**
	 * Force refresh all sources
	 */
	async refresh(): Promise<void> {
		this.taskCache.clear();
		this.lastSync.clear();

		for (const source of this.sources) {
			if (source.refresh) {
				await source.refresh();
			}
		}

		await this.syncAll();
	}

	/**
	 * Get source count
	 */
	getSourceCount(): number {
		return this.sources.length;
	}

	/**
	 * Get source names
	 */
	getSourceNames(): string[] {
		return this.sources.map((s) => s.name);
	}
}

/**
 * Create a sync manager with sources
 */
export function createSyncManager(sources: ITaskSource[]): TaskSyncManager {
	return new TaskSyncManager(sources);
}
