/**
 * Audit Trail Module
 *
 * Provides audit logging capabilities for state changes:
 * - Append-only audit log (audit.jsonl)
 * - Query and filter audit entries
 * - Integration with state change functions
 *
 * File format: JSON Lines (JSONL) - one JSON object per line
 * Location: .milhouse/runs/<run-id>/audit.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logStateError, StateParseError } from "./errors.ts";
import { getRunDir } from "./runs.ts";
import {
	AUDIT_ACTIONS,
	type AuditAction,
	type AuditEntry,
	AuditEntrySchema,
} from "./types.ts";

// ============================================================================
// CONSTANTS
// ============================================================================

const AUDIT_FILE = "audit.jsonl";

// ============================================================================
// PATH FUNCTIONS
// ============================================================================

/**
 * Get path to audit log file for a run
 */
export function getAuditLogPath(runId: string, workDir = process.cwd()): string {
	return join(getRunDir(runId, workDir), AUDIT_FILE);
}

// ============================================================================
// APPEND OPERATIONS
// ============================================================================

/**
 * Append an audit entry to the log
 *
 * This is an append-only operation - entries cannot be modified or deleted.
 * Each entry is written as a single JSON line.
 *
 * @param runId - Run identifier
 * @param entry - Audit entry to append (timestamp will be added if missing)
 * @param workDir - Working directory
 */
export function appendAuditEntry(
	runId: string,
	entry: Omit<AuditEntry, "timestamp"> & { timestamp?: string },
	workDir = process.cwd(),
): void {
	const runDir = getRunDir(runId, workDir);

	// Ensure run directory exists
	if (!existsSync(runDir)) {
		mkdirSync(runDir, { recursive: true });
	}

	// Add timestamp if not provided
	const fullEntry: AuditEntry = {
		...entry,
		timestamp: entry.timestamp ?? new Date().toISOString(),
	};

	// Validate entry
	const validated = AuditEntrySchema.parse(fullEntry);

	// Append to audit log (one JSON object per line)
	const auditPath = getAuditLogPath(runId, workDir);
	const line = JSON.stringify(validated) + "\n";
	appendFileSync(auditPath, line, "utf-8");
}

/**
 * Create a typed audit entry helper
 */
export function createAuditEntry(
	action: AuditAction | string,
	entityType: string,
	entityId: string,
	options: {
		agentId?: string;
		before?: unknown;
		after?: unknown;
		metadata?: Record<string, unknown>;
	} = {},
): Omit<AuditEntry, "timestamp"> {
	return {
		action,
		entity_type: entityType,
		entity_id: entityId,
		agent_id: options.agentId,
		before: options.before,
		after: options.after,
		metadata: options.metadata,
	};
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Filter options for audit log queries
 */
export interface AuditLogFilters {
	/** Filter by action type */
	action?: string | string[];
	/** Filter by entity type */
	entityType?: string | string[];
	/** Filter by entity ID */
	entityId?: string;
	/** Filter by agent ID */
	agentId?: string;
	/** Filter entries after this timestamp */
	after?: Date | string;
	/** Filter entries before this timestamp */
	before?: Date | string;
	/** Maximum number of entries to return */
	limit?: number;
	/** Skip first N entries */
	offset?: number;
}

/**
 * Read and filter audit log entries
 *
 * @param runId - Run identifier
 * @param filters - Optional filters to apply
 * @param workDir - Working directory
 * @returns Array of audit entries matching filters (newest first)
 */
export function getAuditLog(
	runId: string,
	filters: AuditLogFilters = {},
	workDir = process.cwd(),
): AuditEntry[] {
	const auditPath = getAuditLogPath(runId, workDir);

	if (!existsSync(auditPath)) {
		return [];
	}

	// Read all lines
	const content = readFileSync(auditPath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim());

	// Parse entries
	const entries: AuditEntry[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			const entry = AuditEntrySchema.parse(parsed);
			entries.push(entry);
		} catch (error) {
			// Log but continue - corrupted entry shouldn't break reading
			const stateError = new StateParseError(
				"Failed to parse audit entry",
				{ filePath: auditPath, cause: error instanceof Error ? error : new Error(String(error)) },
			);
			logStateError(stateError, "debug");
		}
	}

	// Apply filters
	let filtered = entries;

	if (filters.action) {
		const actions = Array.isArray(filters.action) ? filters.action : [filters.action];
		filtered = filtered.filter((e) => actions.includes(e.action));
	}

	if (filters.entityType) {
		const types = Array.isArray(filters.entityType) ? filters.entityType : [filters.entityType];
		filtered = filtered.filter((e) => types.includes(e.entity_type));
	}

	if (filters.entityId) {
		filtered = filtered.filter((e) => e.entity_id === filters.entityId);
	}

	if (filters.agentId) {
		filtered = filtered.filter((e) => e.agent_id === filters.agentId);
	}

	if (filters.after) {
		const afterTime = new Date(filters.after).getTime();
		filtered = filtered.filter((e) => new Date(e.timestamp).getTime() > afterTime);
	}

	if (filters.before) {
		const beforeTime = new Date(filters.before).getTime();
		filtered = filtered.filter((e) => new Date(e.timestamp).getTime() < beforeTime);
	}

	// Sort by timestamp (newest first)
	filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	// Apply pagination
	if (filters.offset) {
		filtered = filtered.slice(filters.offset);
	}

	if (filters.limit) {
		filtered = filtered.slice(0, filters.limit);
	}

	return filtered;
}

/**
 * Get audit entries for a specific entity
 */
export function getEntityAuditLog(
	runId: string,
	entityType: string,
	entityId: string,
	workDir = process.cwd(),
): AuditEntry[] {
	return getAuditLog(runId, { entityType, entityId }, workDir);
}

/**
 * Get the latest audit entry for an entity
 */
export function getLatestAuditEntry(
	runId: string,
	entityType: string,
	entityId: string,
	workDir = process.cwd(),
): AuditEntry | null {
	const entries = getAuditLog(runId, { entityType, entityId, limit: 1 }, workDir);
	return entries[0] ?? null;
}

/**
 * Count audit entries matching filters
 */
export function countAuditEntries(
	runId: string,
	filters: Omit<AuditLogFilters, "limit" | "offset"> = {},
	workDir = process.cwd(),
): number {
	return getAuditLog(runId, filters, workDir).length;
}

// ============================================================================
// CONVENIENCE FUNCTIONS FOR COMMON AUDIT ACTIONS
// ============================================================================

/**
 * Log a run creation
 */
export function auditRunCreated(
	runId: string,
	options: { scope?: string; name?: string; agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.RUN_CREATED, "run", runId, {
			agentId: options.agentId,
			after: { scope: options.scope, name: options.name },
		}),
		options.workDir,
	);
}

/**
 * Log a run phase change
 */
export function auditRunPhaseChanged(
	runId: string,
	previousPhase: string,
	newPhase: string,
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.RUN_PHASE_CHANGED, "run", runId, {
			agentId: options.agentId,
			before: { phase: previousPhase },
			after: { phase: newPhase },
		}),
		options.workDir,
	);
}

/**
 * Log a task status change
 */
export function auditTaskStatusChanged(
	runId: string,
	taskId: string,
	previousStatus: string,
	newStatus: string,
	options: { agentId?: string; error?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.TASK_STATUS_CHANGED, "task", taskId, {
			agentId: options.agentId,
			before: { status: previousStatus },
			after: { status: newStatus, error: options.error },
		}),
		options.workDir,
	);
}

/**
 * Log an issue status change
 */
export function auditIssueStatusChanged(
	runId: string,
	issueId: string,
	previousStatus: string,
	newStatus: string,
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.ISSUE_STATUS_CHANGED, "issue", issueId, {
			agentId: options.agentId,
			before: { status: previousStatus },
			after: { status: newStatus },
		}),
		options.workDir,
	);
}

/**
 * Log an issue validation
 */
export function auditIssueValidated(
	runId: string,
	issueId: string,
	validationResult: "CONFIRMED" | "FALSE" | "PARTIAL" | "MISDIAGNOSED",
	options: { agentId?: string; reportPath?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.ISSUE_VALIDATED, "issue", issueId, {
			agentId: options.agentId,
			after: { status: validationResult, report_path: options.reportPath },
		}),
		options.workDir,
	);
}

/**
 * Log an execution start
 */
export function auditExecutionStarted(
	runId: string,
	executionId: string,
	taskId: string,
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.EXECUTION_STARTED, "execution", executionId, {
			agentId: options.agentId,
			after: { task_id: taskId },
		}),
		options.workDir,
	);
}

/**
 * Log an execution completion
 */
export function auditExecutionCompleted(
	runId: string,
	executionId: string,
	taskId: string,
	options: { agentId?: string; commitSha?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.EXECUTION_COMPLETED, "execution", executionId, {
			agentId: options.agentId,
			after: { task_id: taskId, commit_sha: options.commitSha },
		}),
		options.workDir,
	);
}

/**
 * Log an execution failure
 */
export function auditExecutionFailed(
	runId: string,
	executionId: string,
	taskId: string,
	error: string,
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.EXECUTION_FAILED, "execution", executionId, {
			agentId: options.agentId,
			after: { task_id: taskId, error },
		}),
		options.workDir,
	);
}

/**
 * Log a validation report creation
 */
export function auditValidationReportCreated(
	runId: string,
	issueId: string,
	reportPath: string,
	status: "valid" | "invalid" | "partial",
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.VALIDATION_REPORT_CREATED, "validation_report", issueId, {
			agentId: options.agentId,
			after: { report_path: reportPath, status },
		}),
		options.workDir,
	);
}

/**
 * Log a state snapshot creation
 */
export function auditStateSnapshotCreated(
	runId: string,
	stateType: string,
	snapshotId: string,
	options: { agentId?: string; reason?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.STATE_SNAPSHOT_CREATED, "snapshot", snapshotId, {
			agentId: options.agentId,
			after: { state_type: stateType, reason: options.reason },
		}),
		options.workDir,
	);
}

/**
 * Log a state rollback
 */
export function auditStateRollback(
	runId: string,
	stateType: string,
	snapshotId: string,
	options: { agentId?: string; workDir?: string } = {},
): void {
	appendAuditEntry(
		runId,
		createAuditEntry(AUDIT_ACTIONS.STATE_ROLLBACK, "state", stateType, {
			agentId: options.agentId,
			after: { snapshot_id: snapshotId },
		}),
		options.workDir,
	);
}

// ============================================================================
// AUDIT STATISTICS
// ============================================================================

/**
 * Get audit statistics for a run
 */
export function getAuditStats(
	runId: string,
	workDir = process.cwd(),
): {
	totalEntries: number;
	entriesByAction: Record<string, number>;
	entriesByEntityType: Record<string, number>;
	firstEntry: string | null;
	lastEntry: string | null;
} {
	const entries = getAuditLog(runId, {}, workDir);

	const entriesByAction: Record<string, number> = {};
	const entriesByEntityType: Record<string, number> = {};

	for (const entry of entries) {
		entriesByAction[entry.action] = (entriesByAction[entry.action] ?? 0) + 1;
		entriesByEntityType[entry.entity_type] = (entriesByEntityType[entry.entity_type] ?? 0) + 1;
	}

	return {
		totalEntries: entries.length,
		entriesByAction,
		entriesByEntityType,
		firstEntry: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
		lastEntry: entries.length > 0 ? entries[0].timestamp : null,
	};
}

// Re-export AUDIT_ACTIONS for convenience
export { AUDIT_ACTIONS };
