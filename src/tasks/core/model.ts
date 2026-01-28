import type { Task, TaskStatus } from "../../schemas/tasks.schema";
import { TaskSchema } from "../../schemas/tasks.schema";
import { PRIORITY_WEIGHTS } from "./types";

/**
 * TaskModel - Immutable wrapper around Task data with helper methods
 * Provides a rich API for working with tasks while maintaining immutability
 */
export class TaskModel {
	private readonly data: Task;

	constructor(data: Task) {
		this.data = TaskSchema.parse(data);
	}

	// Getters for common properties
	get id(): string {
		return this.data.id;
	}
	get title(): string {
		return this.data.title;
	}
	get description(): string | undefined {
		return this.data.description;
	}
	get status(): TaskStatus {
		return this.data.status;
	}
	get priority(): string {
		return this.data.priority;
	}
	get parallelGroup(): number | undefined {
		return this.data.metadata.parallelGroup;
	}
	get sourceFile(): string | undefined {
		return this.data.metadata.sourceFile;
	}
	get lineNumber(): number | undefined {
		return this.data.metadata.lineNumber;
	}
	get dependencies(): string[] {
		return this.data.metadata.dependencies;
	}
	get labels(): string[] {
		return this.data.metadata.labels;
	}

	/**
	 * Check if task is actionable (can be started)
	 */
	isActionable(): boolean {
		return this.data.status === "pending" || this.data.status === "failed";
	}

	/**
	 * Check if task is complete (finished successfully or skipped)
	 */
	isComplete(): boolean {
		return this.data.status === "completed" || this.data.status === "skipped";
	}

	/**
	 * Check if task is in progress
	 */
	isInProgress(): boolean {
		return this.data.status === "in_progress";
	}

	/**
	 * Check if task is blocked by unfinished dependencies
	 */
	isBlocked(completedTaskIds: Set<string>): boolean {
		return this.data.metadata.dependencies.some((dep) => !completedTaskIds.has(dep));
	}

	/**
	 * Check if task has a specific label
	 */
	hasLabel(label: string): boolean {
		return this.data.metadata.labels.includes(label);
	}

	/**
	 * Get priority weight for sorting
	 */
	getPriorityWeight(): number {
		return PRIORITY_WEIGHTS[this.data.priority] ?? 2;
	}

	/**
	 * Create a new TaskModel with updated status
	 */
	withStatus(status: TaskStatus): TaskModel {
		const now = new Date().toISOString();
		return new TaskModel({
			...this.data,
			status,
			updatedAt: now,
			completedAt: status === "completed" ? now : this.data.completedAt,
		});
	}

	/**
	 * Create a new TaskModel with updated priority
	 */
	withPriority(priority: Task["priority"]): TaskModel {
		return new TaskModel({
			...this.data,
			priority,
			updatedAt: new Date().toISOString(),
		});
	}

	/**
	 * Create a new TaskModel with added label
	 */
	withLabel(label: string): TaskModel {
		if (this.hasLabel(label)) {
			return this;
		}
		return new TaskModel({
			...this.data,
			metadata: {
				...this.data.metadata,
				labels: [...this.data.metadata.labels, label],
			},
			updatedAt: new Date().toISOString(),
		});
	}

	/**
	 * Create a new TaskModel with removed label
	 */
	withoutLabel(label: string): TaskModel {
		return new TaskModel({
			...this.data,
			metadata: {
				...this.data.metadata,
				labels: this.data.metadata.labels.filter((l) => l !== label),
			},
			updatedAt: new Date().toISOString(),
		});
	}

	/**
	 * Get raw task data
	 */
	toJSON(): Task {
		return { ...this.data };
	}

	/**
	 * Create TaskModel from unknown data with validation
	 */
	static from(data: unknown): TaskModel {
		return new TaskModel(TaskSchema.parse(data));
	}

	/**
	 * Create TaskModel with minimal required fields
	 */
	static create(id: string, title: string, source: string): TaskModel {
		return new TaskModel({
			id,
			title,
			status: "pending",
			priority: "medium",
			metadata: {
				source,
				dependencies: [],
				labels: [],
			},
		});
	}

	/**
	 * Check equality with another TaskModel
	 */
	equals(other: TaskModel): boolean {
		return this.id === other.id && this.status === other.status && this.title === other.title;
	}

	/**
	 * Get a display string for the task
	 */
	toString(): string {
		const statusIcon = this.getStatusIcon();
		const group = this.parallelGroup !== undefined ? ` [G${this.parallelGroup}]` : "";
		return `${statusIcon} ${this.title}${group}`;
	}

	/**
	 * Get status icon for display
	 */
	private getStatusIcon(): string {
		switch (this.status) {
			case "completed":
				return "✓";
			case "in_progress":
				return "⏳";
			case "failed":
				return "✗";
			case "skipped":
				return "⊘";
			case "blocked":
				return "⊗";
			default:
				return "○";
		}
	}
}
