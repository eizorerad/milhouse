/**
 * Migration Tests for State Management
 *
 * Tests the migration functionality from legacy state structure to runs-based system.
 * Verifies that migrateLegacyToRun(), hasLegacyState(), and cloneRunState() work correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	migrateLegacyToRun,
	hasLegacyState,
	getLegacyStateFiles,
	cleanupLegacyState,
	cloneRunState,
	getMigrationStatus,
} from "./migration.ts";
import {
	createRun,
	loadRunMeta,
	loadRunsIndex,
	getRunStateDir,
	getRunDir,
} from "./runs.ts";
import { loadTasks } from "./tasks.ts";
import { loadIssues } from "./issues.ts";
import type { Issue, Task } from "./types.ts";

describe("Migration Tests", () => {
	const testDir = join(process.cwd(), ".test-migration");
	const milhouseDir = join(testDir, ".milhouse");
	const legacyStateDir = join(milhouseDir, "state");
	const legacyPlansDir = join(milhouseDir, "plans");
	const legacyProbesDir = join(milhouseDir, "probes");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(milhouseDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("hasLegacyState", () => {
		test("should return false when no legacy state exists", () => {
			expect(hasLegacyState(testDir)).toBe(false);
		});

		test("should return false when legacy state directory is empty", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			expect(hasLegacyState(testDir)).toBe(false);
		});

		test("should return true when legacy state has files", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			expect(hasLegacyState(testDir)).toBe(true);
		});

		test("should return true when legacy state has multiple files", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			writeFileSync(join(legacyStateDir, "tasks.json"), "[]");
			writeFileSync(join(legacyStateDir, "run.json"), "{}");
			expect(hasLegacyState(testDir)).toBe(true);
		});
	});

	describe("getLegacyStateFiles", () => {
		test("should return empty array when no legacy state exists", () => {
			const files = getLegacyStateFiles(testDir);
			expect(files).toEqual([]);
		});

		test("should return file paths when legacy state exists", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			writeFileSync(join(legacyStateDir, "tasks.json"), "[]");

			const files = getLegacyStateFiles(testDir);
			expect(files.length).toBe(2);
			expect(files.some((f) => f.endsWith("issues.json"))).toBe(true);
			expect(files.some((f) => f.endsWith("tasks.json"))).toBe(true);
		});
	});

	describe("migrateLegacyToRun", () => {
		test("should return null when no legacy state exists", () => {
			const result = migrateLegacyToRun({ workDir: testDir });
			expect(result).toBeNull();
		});

		test("should return null when legacy state directory is empty", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			const result = migrateLegacyToRun({ workDir: testDir });
			expect(result).toBeNull();
		});

		test("should migrate legacy state to a new run", () => {
			// Create legacy state
			mkdirSync(legacyStateDir, { recursive: true });

			const now = new Date().toISOString();
			const legacyIssues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Test symptom",
					hypothesis: "Test hypothesis",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(legacyStateDir, "issues.json"), JSON.stringify(legacyIssues, null, 2));

			const legacyTasks: Task[] = [
				{
					id: "TASK-1",
					title: "Test task",
					description: "Test description",
					files: [],
					depends_on: [],
					checks: [],
					acceptance: [],
					parallel_group: 0,
					status: "pending",
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(legacyStateDir, "tasks.json"), JSON.stringify(legacyTasks, null, 2));

			// Migrate
			const run = migrateLegacyToRun({
				scope: "migrated scope",
				name: "migrated run",
				workDir: testDir,
			});

			// Verify run was created
			expect(run).not.toBeNull();
			expect(run!.scope).toBe("migrated scope");
			expect(run!.name).toBe("migrated run");

			// Verify state files were copied
			const runStateDir = getRunStateDir(run!.id, testDir);
			expect(existsSync(join(runStateDir, "issues.json"))).toBe(true);
			expect(existsSync(join(runStateDir, "tasks.json"))).toBe(true);

			// Verify content was preserved
			const migratedIssues = JSON.parse(readFileSync(join(runStateDir, "issues.json"), "utf-8"));
			expect(migratedIssues.length).toBe(1);
			expect(migratedIssues[0].id).toBe("ISSUE-1");

			const migratedTasks = JSON.parse(readFileSync(join(runStateDir, "tasks.json"), "utf-8"));
			expect(migratedTasks.length).toBe(1);
			expect(migratedTasks[0].id).toBe("TASK-1");
		});

		test("should migrate legacy plans to new run", () => {
			// Create legacy state and plans
			mkdirSync(legacyStateDir, { recursive: true });
			mkdirSync(legacyPlansDir, { recursive: true });

			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			writeFileSync(join(legacyPlansDir, "problem_brief.md"), "# Problem Brief\n\nTest content");
			writeFileSync(join(legacyPlansDir, "execution_plan.md"), "# Execution Plan\n\nTest plan");

			// Migrate
			const run = migrateLegacyToRun({ workDir: testDir });

			// Verify plans were copied
			const runPlansDir = join(getRunDir(run!.id, testDir), "plans");
			expect(existsSync(join(runPlansDir, "problem_brief.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "execution_plan.md"))).toBe(true);

			// Verify content
			const briefContent = readFileSync(join(runPlansDir, "problem_brief.md"), "utf-8");
			expect(briefContent).toContain("# Problem Brief");
		});

		test("should migrate legacy probes to new run", () => {
			// Create legacy state and probes
			mkdirSync(legacyStateDir, { recursive: true });
			mkdirSync(join(legacyProbesDir, "validation"), { recursive: true });

			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			writeFileSync(
				join(legacyProbesDir, "validation", "probe-1.json"),
				JSON.stringify({ probe_id: "probe-1", success: true })
			);

			// Migrate
			const run = migrateLegacyToRun({ workDir: testDir });

			// Verify probes were copied
			const runProbesDir = join(getRunDir(run!.id, testDir), "probes", "validation");
			expect(existsSync(join(runProbesDir, "probe-1.json"))).toBe(true);
		});

		test("should set migrated run as current run", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");

			const run = migrateLegacyToRun({ workDir: testDir });

			const index = loadRunsIndex(testDir);
			expect(index.current_run).toBe(run!.id);
		});
	});

	describe("cleanupLegacyState", () => {
		test("should return false when no legacy state exists", () => {
			const result = cleanupLegacyState(testDir);
			expect(result).toBe(false);
		});

		test("should delete legacy state directory", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");

			expect(existsSync(legacyStateDir)).toBe(true);

			const result = cleanupLegacyState(testDir);

			expect(result).toBe(true);
			expect(existsSync(legacyStateDir)).toBe(false);
		});
	});

	describe("cloneRunState", () => {
		test("should return null when source run does not exist", () => {
			const result = cloneRunState("non-existent-run", {}, testDir);
			expect(result).toBeNull();
		});

		test("should create independent copy of run state", () => {
			// Create source run with state
			const sourceRun = createRun({ scope: "source run", workDir: testDir });

			// Add some state to source run
			const sourceStateDir = getRunStateDir(sourceRun.id, testDir);
			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Source symptom",
					hypothesis: "Source hypothesis",
					evidence: [],
					status: "CONFIRMED",
					severity: "HIGH",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(sourceStateDir, "issues.json"), JSON.stringify(issues, null, 2));

			// Clone the run
			const clonedRun = cloneRunState(
				sourceRun.id,
				{ scope: "cloned run", name: "clone" },
				testDir
			);

			// Verify clone was created
			expect(clonedRun).not.toBeNull();
			expect(clonedRun!.id).not.toBe(sourceRun.id);
			expect(clonedRun!.scope).toBe("cloned run");
			expect(clonedRun!.name).toBe("clone");

			// Verify state was copied
			const clonedStateDir = getRunStateDir(clonedRun!.id, testDir);
			expect(existsSync(join(clonedStateDir, "issues.json"))).toBe(true);

			// Verify content was preserved
			const clonedIssues = JSON.parse(readFileSync(join(clonedStateDir, "issues.json"), "utf-8"));
			expect(clonedIssues.length).toBe(1);
			expect(clonedIssues[0].id).toBe("ISSUE-1");
			expect(clonedIssues[0].status).toBe("CONFIRMED");
		});

		test("should clone plans directory", () => {
			// Create source run with plans
			const sourceRun = createRun({ scope: "source with plans", workDir: testDir });
			const sourcePlansDir = join(getRunDir(sourceRun.id, testDir), "plans");
			writeFileSync(join(sourcePlansDir, "problem_brief.md"), "# Source Brief");

			// Clone
			const clonedRun = cloneRunState(sourceRun.id, {}, testDir);

			// Verify plans were copied
			const clonedPlansDir = join(getRunDir(clonedRun!.id, testDir), "plans");
			expect(existsSync(join(clonedPlansDir, "problem_brief.md"))).toBe(true);

			const content = readFileSync(join(clonedPlansDir, "problem_brief.md"), "utf-8");
			expect(content).toBe("# Source Brief");
		});

		test("should create truly independent copy (modifications don't affect source)", () => {
			// Create source run
			const sourceRun = createRun({ scope: "source", workDir: testDir });
			const sourceStateDir = getRunStateDir(sourceRun.id, testDir);

			const now = new Date().toISOString();
			const originalIssues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Original",
					hypothesis: "Original",
					evidence: [],
					status: "UNVALIDATED",
					severity: "MEDIUM",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(sourceStateDir, "issues.json"), JSON.stringify(originalIssues, null, 2));

			// Clone
			const clonedRun = cloneRunState(sourceRun.id, {}, testDir);
			const clonedStateDir = getRunStateDir(clonedRun!.id, testDir);

			// Modify cloned state
			const modifiedIssues: Issue[] = [
				{
					id: "ISSUE-1",
					symptom: "Modified",
					hypothesis: "Modified",
					evidence: [],
					status: "CONFIRMED",
					severity: "HIGH",
					related_task_ids: [],
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(clonedStateDir, "issues.json"), JSON.stringify(modifiedIssues, null, 2));

			// Verify source was not affected
			const sourceIssues = JSON.parse(readFileSync(join(sourceStateDir, "issues.json"), "utf-8"));
			expect(sourceIssues[0].symptom).toBe("Original");
			expect(sourceIssues[0].status).toBe("UNVALIDATED");
		});
	});

	describe("getMigrationStatus", () => {
		test("should report no state when nothing exists", () => {
			const status = getMigrationStatus(testDir);

			expect(status.hasLegacy).toBe(false);
			expect(status.hasRuns).toBe(false);
			expect(status.legacyFileCount).toBe(0);
			expect(status.runCount).toBe(0);
			expect(status.recommendation).toContain("No state found");
		});

		test("should recommend migration when only legacy exists", () => {
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");
			writeFileSync(join(legacyStateDir, "tasks.json"), "[]");

			const status = getMigrationStatus(testDir);

			expect(status.hasLegacy).toBe(true);
			expect(status.hasRuns).toBe(false);
			expect(status.legacyFileCount).toBe(2);
			expect(status.runCount).toBe(0);
			expect(status.recommendation).toContain("migrate");
		});

		test("should recommend cleanup when both legacy and runs exist", () => {
			// Create legacy state
			mkdirSync(legacyStateDir, { recursive: true });
			writeFileSync(join(legacyStateDir, "issues.json"), "[]");

			// Create a run
			createRun({ scope: "test run", workDir: testDir });

			const status = getMigrationStatus(testDir);

			expect(status.hasLegacy).toBe(true);
			expect(status.hasRuns).toBe(true);
			expect(status.legacyFileCount).toBe(1);
			expect(status.runCount).toBe(1);
			expect(status.recommendation).toContain("cleaning up");
		});

		test("should report no migration needed when only runs exist", () => {
			createRun({ scope: "test run", workDir: testDir });

			const status = getMigrationStatus(testDir);

			expect(status.hasLegacy).toBe(false);
			expect(status.hasRuns).toBe(true);
			expect(status.legacyFileCount).toBe(0);
			expect(status.runCount).toBe(1);
			expect(status.recommendation).toContain("No migration needed");
		});
	});

	describe("Full Migration Workflow", () => {
		test("should complete full migration workflow: detect → migrate → cleanup", () => {
			// Step 1: Create legacy state
			mkdirSync(legacyStateDir, { recursive: true });
			mkdirSync(legacyPlansDir, { recursive: true });

			const now = new Date().toISOString();
			const issues: Issue[] = [
				{
					id: "LEGACY-ISSUE-1",
					symptom: "Legacy symptom",
					hypothesis: "Legacy hypothesis",
					evidence: [],
					status: "CONFIRMED",
					severity: "HIGH",
					related_task_ids: ["LEGACY-TASK-1"],
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(legacyStateDir, "issues.json"), JSON.stringify(issues, null, 2));

			const tasks: Task[] = [
				{
					id: "LEGACY-TASK-1",
					issue_id: "LEGACY-ISSUE-1",
					title: "Legacy task",
					description: "Legacy description",
					files: ["file1.ts"],
					depends_on: [],
					checks: ["bun test"],
					acceptance: [],
					parallel_group: 0,
					status: "done",
					created_at: now,
					updated_at: now,
				},
			];
			writeFileSync(join(legacyStateDir, "tasks.json"), JSON.stringify(tasks, null, 2));
			writeFileSync(join(legacyPlansDir, "problem_brief.md"), "# Legacy Problem Brief");

			// Step 2: Detect legacy state
			expect(hasLegacyState(testDir)).toBe(true);
			const initialStatus = getMigrationStatus(testDir);
			expect(initialStatus.hasLegacy).toBe(true);
			expect(initialStatus.hasRuns).toBe(false);

			// Step 3: Migrate
			const run = migrateLegacyToRun({
				scope: "migrated from legacy",
				name: "legacy-migration",
				workDir: testDir,
			});

			expect(run).not.toBeNull();

			// Step 4: Verify migration
			const postMigrationStatus = getMigrationStatus(testDir);
			expect(postMigrationStatus.hasLegacy).toBe(true); // Still exists
			expect(postMigrationStatus.hasRuns).toBe(true);

			// Verify data integrity
			const runStateDir = getRunStateDir(run!.id, testDir);
			const migratedIssues = JSON.parse(readFileSync(join(runStateDir, "issues.json"), "utf-8"));
			expect(migratedIssues[0].id).toBe("LEGACY-ISSUE-1");
			expect(migratedIssues[0].status).toBe("CONFIRMED");

			const migratedTasks = JSON.parse(readFileSync(join(runStateDir, "tasks.json"), "utf-8"));
			expect(migratedTasks[0].id).toBe("LEGACY-TASK-1");
			expect(migratedTasks[0].status).toBe("done");

			// Step 5: Cleanup legacy
			const cleanupResult = cleanupLegacyState(testDir);
			expect(cleanupResult).toBe(true);

			// Step 6: Verify final state
			const finalStatus = getMigrationStatus(testDir);
			expect(finalStatus.hasLegacy).toBe(false);
			expect(finalStatus.hasRuns).toBe(true);
			expect(finalStatus.recommendation).toContain("No migration needed");
		});
	});
});
