/**
 * State Events Module
 *
 * Provides typed events for state changes in the milhouse state management system.
 * These events integrate with the main event bus at src/events/bus.ts.
 *
 * @module state/events
 */

import { bus } from "../events/bus.ts";
import type { RunPhase, TaskStatus, IssueStatus } from "./types.ts";

// ============================================================================
// STATE EVENT TYPES
// ============================================================================

/**
 * State-specific events that extend the main MilhouseEvents
 *
 * These events are emitted when state changes occur in the system.
 */
export type StateEvent =
	| { type: "run:phase:changed"; runId: string; phase: RunPhase; previousPhase?: RunPhase }
	| { type: "run:stats:updated"; runId: string; stats: RunStatsPayload }
	| { type: "run:created"; runId: string; scope?: string; name?: string }
	| { type: "run:deleted"; runId: string }
	| { type: "task:status:changed"; taskId: string; status: TaskStatus; previousStatus?: TaskStatus; issueId?: string }
	| { type: "task:created"; taskId: string; issueId?: string; title: string }
	| { type: "task:updated"; taskId: string; fields: string[] }
	| { type: "issue:status:changed"; issueId: string; status: IssueStatus; previousStatus?: IssueStatus }
	| { type: "issue:created"; issueId: string; symptom: string }
	| { type: "issue:updated"; issueId: string; fields: string[] }
	| { type: "validation:report:created"; runId: string; reportId: string; issueId: string; status: IssueStatus };

/**
 * Run statistics payload
 */
export interface RunStatsPayload {
	issues_found?: number;
	issues_validated?: number;
	tasks_total?: number;
	tasks_completed?: number;
	tasks_failed?: number;
}

// ============================================================================
// STATE EVENT EMITTER
// ============================================================================

/**
 * State-specific event emitter
 *
 * This wraps the main event bus to provide typed state events.
 * Events are emitted to the main bus with the "state:" prefix for namespacing.
 */
export const stateEvents = {
	/**
	 * Emit a run phase change event
	 */
	emitRunPhaseChanged(runId: string, phase: RunPhase, previousPhase?: RunPhase): void {
		// Emit to main bus using pipeline:phase events for compatibility
		bus.emit("pipeline:phase:start", { runId, phase });

		// Log for debugging
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] run:phase:changed - runId=${runId}, phase=${phase}, prev=${previousPhase}`);
		}
	},

	/**
	 * Emit a run stats update event
	 */
	emitRunStatsUpdated(runId: string, stats: RunStatsPayload): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] run:stats:updated - runId=${runId}, stats=${JSON.stringify(stats)}`);
		}
	},

	/**
	 * Emit a run created event
	 */
	emitRunCreated(runId: string, scope?: string, name?: string): void {
		bus.emit("pipeline:start", { runId, phases: ["scan", "validate", "plan", "exec", "verify"] });

		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] run:created - runId=${runId}, scope=${scope}, name=${name}`);
		}
	},

	/**
	 * Emit a run deleted event
	 */
	emitRunDeleted(runId: string): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] run:deleted - runId=${runId}`);
		}
	},

	/**
	 * Emit a task status change event
	 */
	emitTaskStatusChanged(
		taskId: string,
		status: TaskStatus,
		previousStatus?: TaskStatus,
		issueId?: string,
	): void {
		// Map to main bus task events
		if (status === "running") {
			bus.emit("task:start", { taskId, title: taskId });
		} else if (status === "done") {
			bus.emit("task:complete", { taskId, duration: 0, success: true });
		} else if (status === "failed") {
			bus.emit("task:complete", { taskId, duration: 0, success: false });
		}

		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] task:status:changed - taskId=${taskId}, status=${status}, prev=${previousStatus}`);
		}
	},

	/**
	 * Emit a task created event
	 */
	emitTaskCreated(taskId: string, title: string, issueId?: string): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] task:created - taskId=${taskId}, title=${title}, issueId=${issueId}`);
		}
	},

	/**
	 * Emit a task updated event
	 */
	emitTaskUpdated(taskId: string, fields: string[]): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] task:updated - taskId=${taskId}, fields=${fields.join(",")}`);
		}
	},

	/**
	 * Emit an issue status change event
	 */
	emitIssueStatusChanged(
		issueId: string,
		status: IssueStatus,
		previousStatus?: IssueStatus,
	): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] issue:status:changed - issueId=${issueId}, status=${status}, prev=${previousStatus}`);
		}
	},

	/**
	 * Emit an issue created event
	 */
	emitIssueCreated(issueId: string, symptom: string): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] issue:created - issueId=${issueId}, symptom=${symptom.slice(0, 50)}`);
		}
	},

	/**
	 * Emit an issue updated event
	 */
	emitIssueUpdated(issueId: string, fields: string[]): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] issue:updated - issueId=${issueId}, fields=${fields.join(",")}`);
		}
	},

	/**
	 * Emit a validation report created event
	 */
	emitValidationReportCreated(
		runId: string,
		reportId: string,
		issueId: string,
		status: IssueStatus,
	): void {
		if (process.env.DEBUG_STATE_EVENTS) {
			console.debug(`[STATE EVENT] validation:report:created - runId=${runId}, reportId=${reportId}, issueId=${issueId}, status=${status}`);
		}
	},
};

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Subscribe to run phase changes
 *
 * @param handler - Callback function when phase changes
 * @returns Unsubscribe function
 */
export function onRunPhaseChanged(
	handler: (payload: { runId: string; phase: string }) => void,
): () => void {
	return bus.on("pipeline:phase:start", handler);
}

/**
 * Subscribe to task status changes
 *
 * @param handler - Callback function when task status changes
 * @returns Unsubscribe function
 */
export function onTaskStatusChanged(
	handler: (payload: { taskId: string; success?: boolean }) => void,
): () => void {
	return bus.on("task:complete", (payload) => {
		handler({ taskId: payload.taskId, success: payload.success });
	});
}

/**
 * Subscribe to task start events
 *
 * @param handler - Callback function when task starts
 * @returns Unsubscribe function
 */
export function onTaskStart(
	handler: (payload: { taskId: string; title: string }) => void,
): () => void {
	return bus.on("task:start", handler);
}
