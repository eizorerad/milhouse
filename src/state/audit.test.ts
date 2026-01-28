/**
 * Audit Module Tests
 *
 * Tests for audit trail functionality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAuditLogPath,
	appendAuditEntry,
	createAuditEntry,
	getAuditLog,
	getEntityAuditLog,
	getLatestAuditEntry,
	countAuditEntries,
	auditRunCreated,
	auditRunPhaseChanged,
	auditTaskStatusChanged,
	auditIssueStatusChanged,
	auditIssueValidated,
	auditExecutionStarted,
	auditExecutionCompleted,
	auditExecutionFailed,
	auditValidationReportCreated,
	auditStateSnapshotCreated,
	auditStateRollback,
	getAuditStats,
	AUDIT_ACTIONS,
} from "./audit.ts";
import { createRun, getRunDir } from "./runs.ts";

describe("Audit Module Tests", () => {
	const testDir = join(process.cwd(), ".test-audit");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(join(testDir, ".milhouse"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Path Functions", () => {
		test("getAuditLogPath should return correct path", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const path = getAuditLogPath(run.id, testDir);

			expect(path).toContain(run.id);
			expect(path).toEndWith("audit.jsonl");
		});
	});

	describe("Append Operations", () => {
		test("appendAuditEntry should create audit file and append entry", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(
				run.id,
				{
					action: "test:action",
					entity_type: "test",
					entity_id: "test-1",
				},
				testDir
			);

			const auditPath = getAuditLogPath(run.id, testDir);
			expect(existsSync(auditPath)).toBe(true);

			const content = readFileSync(auditPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines.length).toBe(1);

			const entry = JSON.parse(lines[0]);
			expect(entry.action).toBe("test:action");
			expect(entry.entity_type).toBe("test");
			expect(entry.entity_id).toBe("test-1");
			expect(entry.timestamp).toBeDefined();
		});

		test("appendAuditEntry should append multiple entries", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "action1", entity_type: "test", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "action2", entity_type: "test", entity_id: "2" }, testDir);
			appendAuditEntry(run.id, { action: "action3", entity_type: "test", entity_id: "3" }, testDir);

			const auditPath = getAuditLogPath(run.id, testDir);
			const content = readFileSync(auditPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines.length).toBe(3);
		});

		test("appendAuditEntry should use provided timestamp", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const timestamp = "2024-01-15T10:30:00.000Z";

			appendAuditEntry(
				run.id,
				{
					action: "test:action",
					entity_type: "test",
					entity_id: "1",
					timestamp,
				},
				testDir
			);

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].timestamp).toBe(timestamp);
		});

		test("createAuditEntry should create properly structured entry", () => {
			const entry = createAuditEntry("test:action", "task", "TASK-1", {
				agentId: "agent-123",
				before: { status: "pending" },
				after: { status: "done" },
				metadata: { duration: 100 },
			});

			expect(entry.action).toBe("test:action");
			expect(entry.entity_type).toBe("task");
			expect(entry.entity_id).toBe("TASK-1");
			expect(entry.agent_id).toBe("agent-123");
			expect(entry.before).toEqual({ status: "pending" });
			expect(entry.after).toEqual({ status: "done" });
			expect(entry.metadata).toEqual({ duration: 100 });
		});
	});

	describe("Query Operations", () => {
		test("getAuditLog should return empty array when no entries", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const entries = getAuditLog(run.id, {}, testDir);

			expect(entries).toEqual([]);
		});

		test("getAuditLog should return entries sorted by timestamp (newest first)", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "t", entity_id: "1", timestamp: "2024-01-01T00:00:00Z" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "t", entity_id: "2", timestamp: "2024-01-03T00:00:00Z" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "t", entity_id: "3", timestamp: "2024-01-02T00:00:00Z" }, testDir);

			const entries = getAuditLog(run.id, {}, testDir);

			expect(entries[0].action).toBe("a2");
			expect(entries[1].action).toBe("a3");
			expect(entries[2].action).toBe("a1");
		});

		test("getAuditLog should filter by action", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "task:created", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "task:updated", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "run:created", entity_type: "run", entity_id: "1" }, testDir);

			const taskCreated = getAuditLog(run.id, { action: "task:created" }, testDir);
			expect(taskCreated.length).toBe(1);

			const taskActions = getAuditLog(run.id, { action: ["task:created", "task:updated"] }, testDir);
			expect(taskActions.length).toBe(2);
		});

		test("getAuditLog should filter by entityType", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "issue", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "task", entity_id: "2" }, testDir);

			const taskEntries = getAuditLog(run.id, { entityType: "task" }, testDir);
			expect(taskEntries.length).toBe(2);

			const multiType = getAuditLog(run.id, { entityType: ["task", "issue"] }, testDir);
			expect(multiType.length).toBe(3);
		});

		test("getAuditLog should filter by entityId", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "task", entity_id: "TASK-1" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "task", entity_id: "TASK-2" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "task", entity_id: "TASK-1" }, testDir);

			const entries = getAuditLog(run.id, { entityId: "TASK-1" }, testDir);
			expect(entries.length).toBe(2);
		});

		test("getAuditLog should filter by agentId", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "t", entity_id: "1", agent_id: "agent-1" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "t", entity_id: "2", agent_id: "agent-2" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "t", entity_id: "3", agent_id: "agent-1" }, testDir);

			const entries = getAuditLog(run.id, { agentId: "agent-1" }, testDir);
			expect(entries.length).toBe(2);
		});

		test("getAuditLog should filter by time range", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "t", entity_id: "1", timestamp: "2024-01-01T00:00:00Z" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "t", entity_id: "2", timestamp: "2024-01-15T00:00:00Z" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "t", entity_id: "3", timestamp: "2024-01-30T00:00:00Z" }, testDir);

			const afterJan10 = getAuditLog(run.id, { after: "2024-01-10T00:00:00Z" }, testDir);
			expect(afterJan10.length).toBe(2);

			const beforeJan20 = getAuditLog(run.id, { before: "2024-01-20T00:00:00Z" }, testDir);
			expect(beforeJan20.length).toBe(2);

			const inRange = getAuditLog(run.id, { after: "2024-01-10T00:00:00Z", before: "2024-01-20T00:00:00Z" }, testDir);
			expect(inRange.length).toBe(1);
		});

		test("getAuditLog should support pagination", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			for (let i = 0; i < 10; i++) {
				appendAuditEntry(run.id, { action: `a${i}`, entity_type: "t", entity_id: `${i}` }, testDir);
			}

			const limited = getAuditLog(run.id, { limit: 3 }, testDir);
			expect(limited.length).toBe(3);

			const offset = getAuditLog(run.id, { offset: 5 }, testDir);
			expect(offset.length).toBe(5);

			const paginated = getAuditLog(run.id, { offset: 2, limit: 3 }, testDir);
			expect(paginated.length).toBe(3);
		});

		test("getEntityAuditLog should return entries for specific entity", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "task", entity_id: "TASK-1" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "task", entity_id: "TASK-2" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "task", entity_id: "TASK-1" }, testDir);

			const entries = getEntityAuditLog(run.id, "task", "TASK-1", testDir);
			expect(entries.length).toBe(2);
		});

		test("getLatestAuditEntry should return most recent entry for entity", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "task", entity_id: "TASK-1", timestamp: "2024-01-01T00:00:00Z" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "task", entity_id: "TASK-1", timestamp: "2024-01-15T00:00:00Z" }, testDir);

			const latest = getLatestAuditEntry(run.id, "task", "TASK-1", testDir);
			expect(latest).not.toBeNull();
			expect(latest!.action).toBe("a2");
		});

		test("getLatestAuditEntry should return null when no entries", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const latest = getLatestAuditEntry(run.id, "task", "TASK-1", testDir);

			expect(latest).toBeNull();
		});

		test("countAuditEntries should return correct count", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "a1", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "a2", entity_type: "task", entity_id: "2" }, testDir);
			appendAuditEntry(run.id, { action: "a3", entity_type: "issue", entity_id: "1" }, testDir);

			const total = countAuditEntries(run.id, {}, testDir);
			expect(total).toBe(3);

			const taskCount = countAuditEntries(run.id, { entityType: "task" }, testDir);
			expect(taskCount).toBe(2);
		});
	});

	describe("Convenience Functions", () => {
		test("auditRunCreated should log run creation", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditRunCreated(run.id, { scope: "test scope", name: "test name", workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries.length).toBe(1);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.RUN_CREATED);
			expect(entries[0].entity_type).toBe("run");
		});

		test("auditRunPhaseChanged should log phase change", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditRunPhaseChanged(run.id, "scan", "validate", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.RUN_PHASE_CHANGED);
			expect(entries[0].before).toEqual({ phase: "scan" });
			expect(entries[0].after).toEqual({ phase: "validate" });
		});

		test("auditTaskStatusChanged should log task status change", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditTaskStatusChanged(run.id, "TASK-1", "pending", "done", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.TASK_STATUS_CHANGED);
			expect(entries[0].entity_id).toBe("TASK-1");
		});

		test("auditIssueStatusChanged should log issue status change", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditIssueStatusChanged(run.id, "ISSUE-1", "UNVALIDATED", "CONFIRMED", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.ISSUE_STATUS_CHANGED);
		});

		test("auditIssueValidated should log issue validation", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditIssueValidated(run.id, "ISSUE-1", "CONFIRMED", { reportPath: "reports/issue-1.json", workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.ISSUE_VALIDATED);
		});

		test("auditExecutionStarted should log execution start", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditExecutionStarted(run.id, "exec-1", "TASK-1", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.EXECUTION_STARTED);
			expect(entries[0].entity_id).toBe("exec-1");
		});

		test("auditExecutionCompleted should log execution completion", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditExecutionCompleted(run.id, "exec-1", "TASK-1", { commitSha: "abc123", workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.EXECUTION_COMPLETED);
		});

		test("auditExecutionFailed should log execution failure", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditExecutionFailed(run.id, "exec-1", "TASK-1", "Test error", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.EXECUTION_FAILED);
		});

		test("auditValidationReportCreated should log report creation", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditValidationReportCreated(run.id, "ISSUE-1", "reports/issue-1.json", "valid", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.VALIDATION_REPORT_CREATED);
		});

		test("auditStateSnapshotCreated should log snapshot creation", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditStateSnapshotCreated(run.id, "issues", "snapshot-1", { reason: "Before change", workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.STATE_SNAPSHOT_CREATED);
		});

		test("auditStateRollback should log state rollback", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			auditStateRollback(run.id, "issues", "snapshot-1", { workDir: testDir });

			const entries = getAuditLog(run.id, {}, testDir);
			expect(entries[0].action).toBe(AUDIT_ACTIONS.STATE_ROLLBACK);
		});
	});

	describe("Audit Statistics", () => {
		test("getAuditStats should return comprehensive statistics", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			appendAuditEntry(run.id, { action: "task:created", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "task:updated", entity_type: "task", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "issue:created", entity_type: "issue", entity_id: "1" }, testDir);
			appendAuditEntry(run.id, { action: "run:created", entity_type: "run", entity_id: run.id }, testDir);

			const stats = getAuditStats(run.id, testDir);

			expect(stats.totalEntries).toBe(4);
			expect(stats.entriesByAction["task:created"]).toBe(1);
			expect(stats.entriesByAction["task:updated"]).toBe(1);
			expect(stats.entriesByEntityType["task"]).toBe(2);
			expect(stats.entriesByEntityType["issue"]).toBe(1);
			expect(stats.entriesByEntityType["run"]).toBe(1);
			expect(stats.firstEntry).toBeDefined();
			expect(stats.lastEntry).toBeDefined();
		});

		test("getAuditStats should return empty stats when no entries", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const stats = getAuditStats(run.id, testDir);

			expect(stats.totalEntries).toBe(0);
			expect(stats.entriesByAction).toEqual({});
			expect(stats.entriesByEntityType).toEqual({});
			expect(stats.firstEntry).toBeNull();
			expect(stats.lastEntry).toBeNull();
		});
	});

	describe("AUDIT_ACTIONS Constants", () => {
		test("should have all expected action types", () => {
			expect(AUDIT_ACTIONS.RUN_CREATED).toBe("run:created");
			expect(AUDIT_ACTIONS.RUN_DELETED).toBe("run:deleted");
			expect(AUDIT_ACTIONS.RUN_PHASE_CHANGED).toBe("run:phase:changed");
			expect(AUDIT_ACTIONS.TASK_CREATED).toBe("task:created");
			expect(AUDIT_ACTIONS.TASK_STATUS_CHANGED).toBe("task:status:changed");
			expect(AUDIT_ACTIONS.ISSUE_CREATED).toBe("issue:created");
			expect(AUDIT_ACTIONS.ISSUE_VALIDATED).toBe("issue:validated");
			expect(AUDIT_ACTIONS.EXECUTION_STARTED).toBe("execution:started");
			expect(AUDIT_ACTIONS.EXECUTION_COMPLETED).toBe("execution:completed");
			expect(AUDIT_ACTIONS.EXECUTION_FAILED).toBe("execution:failed");
			expect(AUDIT_ACTIONS.VALIDATION_REPORT_CREATED).toBe("validation:report:created");
			expect(AUDIT_ACTIONS.STATE_SNAPSHOT_CREATED).toBe("state:snapshot:created");
			expect(AUDIT_ACTIONS.STATE_ROLLBACK).toBe("state:rollback");
		});
	});
});
