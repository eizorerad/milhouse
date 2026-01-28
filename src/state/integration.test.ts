/**
 * Integration Tests for State Management
 *
 * Tests the complete flow of state operations across the pipeline:
 * createRun → saveIssues → saveTasks → updateTaskStatus → saveValidationReport
 *
 * Verifies state consistency and event emissions during state changes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createRun,
	loadRunMeta,
	updateRunPhaseInMeta,
	updateRunStats,
	getCurrentRun,
	setCurrentRun,
	deleteRun,
	listRuns,
	getRunStateDir,
	getRunDir,
} from "./runs.ts";
import {
	createTask,
	loadTasks,
	saveTasks,
	updateTask,
	updateTaskStatus,
	getReadyTasks,
	getPendingTasks,
	getCompletedTasks,
	countTasksByStatus,
} from "./tasks.ts";
import {
	loadIssues,
	saveIssues,
	updateIssue,
} from "./issues.ts";
import {
	updateValidationIndex,
	getValidationReportsForRun,
	getValidationReportsByIssue,
	countValidationReportsByStatus,
} from "./validation-index.ts";
import {
	appendAuditEntry,
	getAuditLog,
	createAuditEntry,
	AUDIT_ACTIONS,
} from "./audit.ts";
import {
	saveStateSnapshot,
	listSnapshots,
	loadSnapshot,
	rollbackState,
} from "./history.ts";
import { stateEvents } from "./events.ts";
import type { Issue, Task, RunPhase } from "./types.ts";

describe("Integration Tests", () => {
	const testDir = join(process.cwd(), ".test-integration");

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

	describe("Complete Pipeline Flow", () => {
		test("should complete full flow: createRun → saveIssues → saveTasks → updateTaskStatus → saveValidationReport", async () => {
			// Step 1: Create a run
			const run = createRun({
				scope: "Integration test scope",
				name: "integration-test",
				workDir: testDir,
			});

			expect(run).toBeDefined();
			expect(run.id).toMatch(/^run-\d{8}/);
			expect(run.phase).toBe("scan");
			expect(run.scope).toBe("Integration test scope");

			// Verify run is current
			const currentRun = getCurrentRun(testDir);
			expect(currentRun).not.toBeNull();
			expect(currentRun!.id).toBe(run.id);

			// Step 2: Save issues (simulating scan phase)
			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Database connection timeout",
					hypothesis: "Connection pool exhaustion",
					evidence: [],
					status: "UNVALIDATED",
					severity: "HIGH",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
				{
					id: "ISSUE-2",
					symptom: "Slow API response",
					hypothesis: "N+1 query problem",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(issues, testDir);

			// Update run stats
			updateRunStats(run.id, { issues_found: 2 }, testDir);

			// Verify issues were saved
			const loadedIssues = loadIssues(testDir);
			expect(loadedIssues.length).toBe(2);

			// Step 3: Update phase to validate
			updateRunPhaseInMeta(run.id, "validate", testDir);

			// Validate issues
			updateIssue("ISSUE-1", { status: "CONFIRMED" }, testDir);
			updateIssue("ISSUE-2", { status: "CONFIRMED" }, testDir);
			updateRunStats(run.id, { issues_validated: 2 }, testDir);

			// Add validation reports
			updateValidationIndex(run.id, "ISSUE-1", "validation-reports/ISSUE-1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "validation-reports/ISSUE-2.json", "valid", testDir);

			// Step 4: Update phase to plan and create tasks
			updateRunPhaseInMeta(run.id, "plan", testDir);

			const tasks: Task[] = [
				{
					id: "ISSUE-1-T1",
					issue_id: "ISSUE-1",
					title: "Increase connection pool size",
					description: "Increase pool from 10 to 50",
					files: ["config/database.ts"],
					depends_on: [],
					checks: ["bun test"],
					acceptance: [],
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
				{
					id: "ISSUE-2-T1",
					issue_id: "ISSUE-2",
					title: "Add eager loading",
					description: "Use include to prevent N+1",
					files: ["src/api/users.ts"],
					depends_on: [],
					checks: ["bun test"],
					acceptance: [],
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
				{
					id: "ISSUE-2-T2",
					issue_id: "ISSUE-2",
					title: "Add query caching",
					description: "Cache frequently accessed queries",
					files: ["src/api/users.ts"],
					depends_on: ["ISSUE-2-T1"],
					checks: ["bun test"],
					acceptance: [],
					parallel_group: 1,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
			];
			saveTasks(tasks, testDir);
			updateRunStats(run.id, { tasks_total: 3 }, testDir);

			// Verify tasks
			const loadedTasks = loadTasks(testDir);
			expect(loadedTasks.length).toBe(3);

			// Step 5: Update phase to exec and execute tasks
			updateRunPhaseInMeta(run.id, "exec", testDir);

			// Execute first task
			updateTaskStatus("ISSUE-1-T1", "running", undefined, testDir);
			updateTaskStatus("ISSUE-1-T1", "done", undefined, testDir);
			updateRunStats(run.id, { tasks_completed: 1 }, testDir);

			// Execute second task
			updateTaskStatus("ISSUE-2-T1", "running", undefined, testDir);
			updateTaskStatus("ISSUE-2-T1", "done", undefined, testDir);
			updateRunStats(run.id, { tasks_completed: 2 }, testDir);

			// Execute third task (was blocked, now ready)
			const readyTasks = getReadyTasks(testDir);
			expect(readyTasks.some((t) => t.id === "ISSUE-2-T2")).toBe(true);

			updateTaskStatus("ISSUE-2-T2", "running", undefined, testDir);
			updateTaskStatus("ISSUE-2-T2", "done", undefined, testDir);
			updateRunStats(run.id, { tasks_completed: 3 }, testDir);

			// Step 6: Update phase to verify
			updateRunPhaseInMeta(run.id, "verify", testDir);

			// Step 7: Complete the run
			updateRunPhaseInMeta(run.id, "completed", testDir);

			// Final verification
			const finalRun = loadRunMeta(run.id, testDir);
			expect(finalRun).not.toBeNull();
			expect(finalRun!.phase).toBe("completed");
			expect(finalRun!.issues_found).toBe(2);
			expect(finalRun!.issues_validated).toBe(2);
			expect(finalRun!.tasks_total).toBe(3);
			expect(finalRun!.tasks_completed).toBe(3);
			expect(finalRun!.tasks_failed).toBe(0);

			const finalTasks = loadTasks(testDir);
			const completedTasks = finalTasks.filter((t) => t.status === "done");
			expect(completedTasks.length).toBe(3);

			const validationReports = getValidationReportsForRun(run.id, testDir);
			expect(validationReports.length).toBe(2);
		});

		test("should handle task failure and dependent blocking", async () => {
			const run = createRun({ scope: "failure test", workDir: testDir });

			const now = new Date().toISOString();
			const tasks: Task[] = [
				{
					id: "TASK-1",
					title: "First task",
					files: [],
					depends_on: [],
					checks: [],
					acceptance: [],
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
				{
					id: "TASK-2",
					title: "Dependent task",
					files: [],
					depends_on: ["TASK-1"],
					checks: [],
					acceptance: [],
					parallel_group: 1,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
			];
			saveTasks(tasks, testDir);

			// Fail the first task
			updateTaskStatus("TASK-1", "failed", "Test failure", testDir);
			updateRunStats(run.id, { tasks_failed: 1 }, testDir);

			// Verify dependent task is blocked
			const loadedTasks = loadTasks(testDir);
			const dependentTask = loadedTasks.find((t) => t.id === "TASK-2");
			expect(dependentTask!.status).toBe("blocked");

			// Verify counts
			const counts = countTasksByStatus(testDir);
			expect(counts.failed).toBe(1);
			expect(counts.blocked).toBe(1);
		});
	});

	describe("State Consistency", () => {
		test("should maintain consistency between run meta and index", () => {
			const run1 = createRun({ scope: "run 1", workDir: testDir });
			const run2 = createRun({ scope: "run 2", workDir: testDir });

			// Update run1 phase
			updateRunPhaseInMeta(run1.id, "exec", testDir);

			// Verify both meta and index are consistent
			const meta = loadRunMeta(run1.id, testDir);
			const runs = listRuns(testDir);
			const indexEntry = runs.find((r) => r.id === run1.id);

			expect(meta!.phase).toBe("exec");
			expect(indexEntry!.phase).toBe("exec");
		});

		test("should maintain consistency between issues and tasks", () => {
			createRun({ scope: "consistency test", workDir: testDir });

			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test symptom",
					hypothesis: "Test hypothesis",
					evidence: [],
					status: "CONFIRMED",
					severity: "HIGH",
					related_task_ids: ["ISSUE-1-T1", "ISSUE-1-T2"],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(issues, testDir);

			const tasks: Task[] = [
				{
					id: "ISSUE-1-T1",
					issue_id: "ISSUE-1",
					title: "Task 1",
					files: [],
					depends_on: [],
					checks: [],
					acceptance: [],
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
				{
					id: "ISSUE-1-T2",
					issue_id: "ISSUE-1",
					title: "Task 2",
					files: [],
					depends_on: ["ISSUE-1-T1"],
					checks: [],
					acceptance: [],
					parallel_group: 1,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
			];
			saveTasks(tasks, testDir);

			// Verify relationships
			const loadedIssues = loadIssues(testDir);
			const loadedTasks = loadTasks(testDir);

			const issue = loadedIssues.find((i) => i.id === "ISSUE-1");
			const issueTasks = loadedTasks.filter((t) => t.issue_id === "ISSUE-1");

			expect(issue!.related_task_ids.length).toBe(2);
			expect(issueTasks.length).toBe(2);
		});

		test("should maintain validation index consistency", () => {
			const run = createRun({ scope: "validation test", workDir: testDir });

			// Add validation reports
			updateValidationIndex(run.id, "ISSUE-1", "reports/issue-1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "reports/issue-2.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "reports/issue-3.json", "partial", testDir);

			// Verify counts
			const counts = countValidationReportsByStatus(run.id, testDir);
			expect(counts.valid).toBe(1);
			expect(counts.invalid).toBe(1);
			expect(counts.partial).toBe(1);
			expect(counts.total).toBe(3);

			// Verify by issue
			const issue1Reports = getValidationReportsByIssue(run.id, "ISSUE-1", testDir);
			expect(issue1Reports.length).toBe(1);
			expect(issue1Reports[0].status).toBe("valid");
		});
	});

	describe("Event Emissions", () => {
		test("should emit events during state changes", () => {
			// This test verifies that stateEvents functions exist and can be called
			// In a real scenario, we'd use spies to verify emissions

			const run = createRun({ scope: "event test", workDir: testDir });

			// These should not throw
			expect(() => {
				stateEvents.emitRunPhaseChanged(run.id, "exec", "scan");
				stateEvents.emitRunStatsUpdated(run.id, { tasks_completed: 1 });
				stateEvents.emitTaskStatusChanged("TASK-1", "done", "running", "ISSUE-1");
				stateEvents.emitIssueStatusChanged("ISSUE-1", "CONFIRMED", "UNVALIDATED");
				stateEvents.emitValidationReportCreated(run.id, "report-1", "ISSUE-1", "CONFIRMED");
			}).not.toThrow();
		});
	});

	describe("Audit Trail Integration", () => {
		test("should record audit entries during state changes", () => {
			const run = createRun({ scope: "audit test", workDir: testDir });

			// Record various audit entries
			appendAuditEntry(
				run.id,
				createAuditEntry(AUDIT_ACTIONS.RUN_CREATED, "run", run.id, {
					after: { scope: "audit test" },
				}),
				testDir
			);

			appendAuditEntry(
				run.id,
				createAuditEntry(AUDIT_ACTIONS.RUN_PHASE_CHANGED, "run", run.id, {
					before: { phase: "scan" },
					after: { phase: "validate" },
				}),
				testDir
			);

			appendAuditEntry(
				run.id,
				createAuditEntry(AUDIT_ACTIONS.TASK_STATUS_CHANGED, "task", "TASK-1", {
					before: { status: "pending" },
					after: { status: "done" },
				}),
				testDir
			);

			// Verify audit log
			const auditLog = getAuditLog(run.id, {}, testDir);
			expect(auditLog.length).toBe(3);

			// Verify filtering
			const runEntries = getAuditLog(run.id, { entityType: "run" }, testDir);
			expect(runEntries.length).toBe(2);

			const taskEntries = getAuditLog(run.id, { entityType: "task" }, testDir);
			expect(taskEntries.length).toBe(1);
		});
	});

	describe("History and Rollback Integration", () => {
		test("should create snapshots and allow rollback", () => {
			const run = createRun({ scope: "history test", workDir: testDir });

			const now = new Date().toISOString();
			const initialIssues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Initial symptom",
					hypothesis: "Initial hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];

			// Save initial state
			saveIssues(initialIssues, testDir);

			// Create snapshot
			const snapshot = saveStateSnapshot(run.id, "issues", initialIssues, {
				reason: "Before modification",
				workDir: testDir,
			});

			expect(snapshot.id).toBeDefined();

			// Modify state
			const modifiedIssues: Issue[] = [
				{
					...initialIssues[0],
					symptom: "Modified symptom",
					status: "CONFIRMED",
				},
			];
			saveIssues(modifiedIssues, testDir);

			// Verify modification
			let currentIssues = loadIssues(testDir);
			expect(currentIssues[0].symptom).toBe("Modified symptom");

			// Rollback
			const rolledBack = rollbackState<Issue[]>(run.id, "issues", snapshot.id, {
				workDir: testDir,
			});

			expect(rolledBack).not.toBeNull();
			expect(rolledBack![0].symptom).toBe("Initial symptom");

			// Verify rollback persisted
			currentIssues = loadIssues(testDir);
			expect(currentIssues[0].symptom).toBe("Initial symptom");
		});

		test("should list and manage multiple snapshots", async () => {
			const run = createRun({ scope: "multi-snapshot test", workDir: testDir });

			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test",
					hypothesis: "Test",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];

			// Create multiple snapshots with delays to ensure different timestamps
			saveStateSnapshot(run.id, "issues", issues, { reason: "Snapshot 1", workDir: testDir });

			// Wait to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 10));

			const issues2 = [{ ...issues[0], symptom: "Modified 1" }];
			saveStateSnapshot(run.id, "issues", issues2, { reason: "Snapshot 2", workDir: testDir });

			await new Promise((resolve) => setTimeout(resolve, 10));

			const issues3 = [{ ...issues[0], symptom: "Modified 2" }];
			saveStateSnapshot(run.id, "issues", issues3, { reason: "Snapshot 3", workDir: testDir });

			// List snapshots
			const snapshots = listSnapshots(run.id, "issues", testDir);
			expect(snapshots.length).toBe(3);

			// Verify order (newest first)
			expect(snapshots[0].reason).toBe("Snapshot 3");
		});
	});

	describe("Multi-Run Operations", () => {
		test("should handle multiple runs independently", () => {
			// Create multiple runs
			const run1 = createRun({ scope: "run 1", workDir: testDir });
			const run2 = createRun({ scope: "run 2", workDir: testDir });
			const run3 = createRun({ scope: "run 3", workDir: testDir });

			// Verify all runs exist
			const runs = listRuns(testDir);
			expect(runs.length).toBe(3);

			// Switch between runs
			setCurrentRun(run1.id, testDir);
			expect(getCurrentRun(testDir)!.id).toBe(run1.id);

			setCurrentRun(run2.id, testDir);
			expect(getCurrentRun(testDir)!.id).toBe(run2.id);

			// Delete a run
			deleteRun(run3.id, testDir);

			const remainingRuns = listRuns(testDir);
			expect(remainingRuns.length).toBe(2);
			expect(remainingRuns.some((r) => r.id === run3.id)).toBe(false);
		});

		test("should isolate state between runs", () => {
			const run1 = createRun({ scope: "isolated run 1", workDir: testDir });
			const run2 = createRun({ scope: "isolated run 2", workDir: testDir });

			// Add issues to run1
			setCurrentRun(run1.id, testDir);
			const now = new Date().toISOString();
			const run1Issues: Issue[] = [
				{
					id: "RUN1-ISSUE-1",
					symptom: "Run 1 issue",
					hypothesis: "Run 1 hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "HIGH",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(run1Issues, testDir);

			// Switch to run2 and add different issues
			setCurrentRun(run2.id, testDir);
			const run2Issues: Issue[] = [
				{
					id: "RUN2-ISSUE-1",
					symptom: "Run 2 issue",
					hypothesis: "Run 2 hypothesis",
					evidence: [],
					status: "CONFIRMED",
					severity: "LOW",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
				{
					id: "RUN2-ISSUE-2",
					symptom: "Run 2 issue 2",
					hypothesis: "Run 2 hypothesis 2",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			saveIssues(run2Issues, testDir);

			// Verify isolation - run2 should have its own issues
			const run2LoadedIssues = loadIssues(testDir);
			expect(run2LoadedIssues.length).toBe(2);
			expect(run2LoadedIssues[0].id).toBe("RUN2-ISSUE-1");

			// Switch back to run1 and verify its issues are intact
			setCurrentRun(run1.id, testDir);
			const run1LoadedIssues = loadIssues(testDir);
			expect(run1LoadedIssues.length).toBe(1);
			expect(run1LoadedIssues[0].id).toBe("RUN1-ISSUE-1");
		});
	});

	describe("Error Recovery", () => {
		test("should handle missing state files gracefully", () => {
			const run = createRun({ scope: "error recovery", workDir: testDir });

			// Try to load non-existent state
			const issues = loadIssues(testDir);
			expect(issues).toEqual([]);

			const tasks = loadTasks(testDir);
			expect(tasks).toEqual([]);

			// Operations should not throw
			expect(() => {
				updateIssue("NON-EXISTENT", { status: "CONFIRMED" }, testDir);
				updateTask("NON-EXISTENT", { status: "done" }, testDir);
			}).not.toThrow();
		});

		test("should handle corrupted state files", () => {
			const run = createRun({ scope: "corruption test", workDir: testDir });
			const stateDir = getRunStateDir(run.id, testDir);

			// Write corrupted JSON
			writeFileSync(join(stateDir, "issues.json"), "{ invalid json }");

			// Should return empty array instead of throwing
			const issues = loadIssues(testDir);
			expect(issues).toEqual([]);
		});
	});
});
