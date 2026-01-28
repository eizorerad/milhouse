import type { Task } from "../../schemas/tasks.schema";
import { TaskModel } from "./model";
import type { TaskFilter, TaskSort } from "./types";
import { PRIORITY_WEIGHTS, STATUS_WEIGHTS } from "./types";

/**
 * TaskSelector - Fluent API for filtering, sorting, and querying tasks
 * Supports chaining operations and returns new instances (immutable)
 */
export class TaskSelector {
	private tasks: TaskModel[];

	constructor(tasks: Task[] | TaskModel[]) {
		this.tasks = tasks.map((t) => (t instanceof TaskModel ? t : new TaskModel(t)));
	}

	/**
	 * Filter tasks by criteria
	 */
	filter(criteria: TaskFilter): TaskSelector {
		let filtered = [...this.tasks];

		if (criteria.status?.length) {
			filtered = filtered.filter((t) => criteria.status?.includes(t.status));
		}

		if (criteria.priority?.length) {
			filtered = filtered.filter((t) => criteria.priority?.includes(t.priority));
		}

		if (criteria.parallelGroup !== undefined) {
			filtered = filtered.filter((t) => t.parallelGroup === criteria.parallelGroup);
		}

		if (criteria.labels?.length) {
			filtered = filtered.filter((t) => criteria.labels?.some((label) => t.hasLabel(label)));
		}

		if (criteria.sourceFile) {
			filtered = filtered.filter((t) => t.sourceFile === criteria.sourceFile);
		}

		if (criteria.search) {
			const searchLower = criteria.search.toLowerCase();
			filtered = filtered.filter(
				(t) =>
					t.title.toLowerCase().includes(searchLower) ||
					t.description?.toLowerCase().includes(searchLower),
			);
		}

		return new TaskSelector(filtered.map((t) => t.toJSON()));
	}

	/**
	 * Sort tasks by field and direction
	 */
	sort(options: TaskSort): TaskSelector {
		const sorted = [...this.tasks].sort((a, b) => {
			let comparison = 0;

			switch (options.field) {
				case "title":
					comparison = a.title.localeCompare(b.title);
					break;
				case "parallelGroup":
					comparison =
						(a.parallelGroup ?? Number.MAX_SAFE_INTEGER) -
						(b.parallelGroup ?? Number.MAX_SAFE_INTEGER);
					break;
				case "priority":
					// Higher weight = higher priority, so we want b - a for ascending (low to high)
					// and a - b for descending (high to low)
					comparison = (PRIORITY_WEIGHTS[a.priority] ?? 2) - (PRIORITY_WEIGHTS[b.priority] ?? 2);
					break;
				case "status":
					comparison = (STATUS_WEIGHTS[a.status] ?? 0) - (STATUS_WEIGHTS[b.status] ?? 0);
					break;
				case "createdAt": {
					const aDate = a.toJSON().createdAt ?? "";
					const bDate = b.toJSON().createdAt ?? "";
					comparison = aDate.localeCompare(bDate);
					break;
				}
			}

			return options.direction === "desc" ? -comparison : comparison;
		});

		return new TaskSelector(sorted.map((t) => t.toJSON()));
	}

	/**
	 * Get pending tasks
	 */
	pending(): TaskModel[] {
		return this.tasks.filter((t) => t.status === "pending");
	}

	/**
	 * Get completed tasks
	 */
	completed(): TaskModel[] {
		return this.tasks.filter((t) => t.isComplete());
	}

	/**
	 * Get actionable tasks (pending or failed)
	 */
	actionable(): TaskModel[] {
		return this.tasks.filter((t) => t.isActionable());
	}

	/**
	 * Get in-progress tasks
	 */
	inProgress(): TaskModel[] {
		return this.tasks.filter((t) => t.isInProgress());
	}

	/**
	 * Get blocked tasks
	 */
	blocked(completedTaskIds: Set<string>): TaskModel[] {
		return this.tasks.filter((t) => t.isBlocked(completedTaskIds));
	}

	/**
	 * Get tasks by parallel group
	 */
	byGroup(group: number): TaskModel[] {
		return this.tasks.filter((t) => t.parallelGroup === group);
	}

	/**
	 * Get all unique parallel groups
	 */
	groups(): number[] {
		const groups = new Set<number>();
		for (const task of this.tasks) {
			if (task.parallelGroup !== undefined) {
				groups.add(task.parallelGroup);
			}
		}
		return Array.from(groups).sort((a, b) => a - b);
	}

	/**
	 * Get tasks with a specific label
	 */
	withLabel(label: string): TaskModel[] {
		return this.tasks.filter((t) => t.hasLabel(label));
	}

	/**
	 * Get all unique labels
	 */
	labels(): string[] {
		const labels = new Set<string>();
		for (const task of this.tasks) {
			for (const label of task.labels) {
				labels.add(label);
			}
		}
		return Array.from(labels).sort();
	}

	/**
	 * Get the first task (or null)
	 */
	first(): TaskModel | null {
		return this.tasks[0] ?? null;
	}

	/**
	 * Get the last task (or null)
	 */
	last(): TaskModel | null {
		return this.tasks[this.tasks.length - 1] ?? null;
	}

	/**
	 * Get task by ID
	 */
	byId(id: string): TaskModel | null {
		return this.tasks.find((t) => t.id === id) ?? null;
	}

	/**
	 * Get all tasks as TaskModel array
	 */
	all(): TaskModel[] {
		return [...this.tasks];
	}

	/**
	 * Get all tasks as raw Task array
	 */
	toArray(): Task[] {
		return this.tasks.map((t) => t.toJSON());
	}

	/**
	 * Get count of tasks
	 */
	count(): number {
		return this.tasks.length;
	}

	/**
	 * Check if selector has any tasks
	 */
	isEmpty(): boolean {
		return this.tasks.length === 0;
	}

	/**
	 * Check if selector has tasks
	 */
	hasAny(): boolean {
		return this.tasks.length > 0;
	}

	/**
	 * Get statistics about the tasks
	 */
	stats(): {
		total: number;
		pending: number;
		inProgress: number;
		completed: number;
		failed: number;
		skipped: number;
		blocked: number;
	} {
		const stats = {
			total: this.tasks.length,
			pending: 0,
			inProgress: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			blocked: 0,
		};

		for (const task of this.tasks) {
			switch (task.status) {
				case "pending":
					stats.pending++;
					break;
				case "in_progress":
					stats.inProgress++;
					break;
				case "completed":
					stats.completed++;
					break;
				case "failed":
					stats.failed++;
					break;
				case "skipped":
					stats.skipped++;
					break;
				case "blocked":
					stats.blocked++;
					break;
			}
		}

		return stats;
	}

	/**
	 * Map over tasks
	 */
	map<T>(fn: (task: TaskModel, index: number) => T): T[] {
		return this.tasks.map(fn);
	}

	/**
	 * ForEach over tasks
	 */
	forEach(fn: (task: TaskModel, index: number) => void): void {
		this.tasks.forEach(fn);
	}

	/**
	 * Find a task matching predicate
	 */
	find(predicate: (task: TaskModel) => boolean): TaskModel | null {
		return this.tasks.find(predicate) ?? null;
	}

	/**
	 * Check if any task matches predicate
	 */
	some(predicate: (task: TaskModel) => boolean): boolean {
		return this.tasks.some(predicate);
	}

	/**
	 * Check if all tasks match predicate
	 */
	every(predicate: (task: TaskModel) => boolean): boolean {
		return this.tasks.every(predicate);
	}

	/**
	 * Take first n tasks
	 */
	take(n: number): TaskSelector {
		return new TaskSelector(this.tasks.slice(0, n).map((t) => t.toJSON()));
	}

	/**
	 * Skip first n tasks
	 */
	skip(n: number): TaskSelector {
		return new TaskSelector(this.tasks.slice(n).map((t) => t.toJSON()));
	}

	/**
	 * Create selector from raw task array
	 */
	static from(tasks: Task[]): TaskSelector {
		return new TaskSelector(tasks);
	}

	/**
	 * Create empty selector
	 */
	static empty(): TaskSelector {
		return new TaskSelector([]);
	}
}
