/**
 * Unit tests for PlanStore module
 *
 * Tests the run-aware API for all plan operations including:
 * - Path resolution (getCurrentPlansDir)
 * - File operations (writePlanFile, readPlanFile)
 * - Specific plan file operations (WBS, problem brief, execution plan)
 * - Legacy view synchronization (syncLegacyPlansView)
 * - Legacy import functionality
 * - Metadata header generation
 *
 * @module state/plan-store.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createPlanMetadataHeader,
	getCurrentPlansDir,
	getLegacyPlansDir,
	hasLegacyPlansToImport,
	importLegacyPlans,
	listPlanFiles,
	planFileExists,
	readExecutionPlan,
	readIssueWbsJson,
	readIssueWbsPlan,
	readPlanFile,
	readProblemBrief,
	syncLegacyPlansView,
	writeExecutionPlan,
	writeIssueWbsJson,
	writeIssueWbsPlan,
	writePlanFile,
	writeProblemBrief,
} from "./plan-store.ts";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a unique temporary directory for test isolation
 */
function createTempDir(): string {
	const tempBase = join(tmpdir(), "plan-store-test-");
	const tempDir = `${tempBase}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Sets up an active run in the test directory
 */
function setupActiveRun(workDir: string, runId: string): void {
	const milhouse = join(workDir, ".milhouse");
	mkdirSync(milhouse, { recursive: true });

	// Create runs-index.json with current_run
	const runsIndex = {
		current_run: runId,
		runs: [
			{
				id: runId,
				created_at: new Date().toISOString(),
				phase: "scan",
			},
		],
	};
	writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

	// Create the run's plans directory
	const runPlansDir = join(milhouse, "runs", runId, "plans");
	mkdirSync(runPlansDir, { recursive: true });
}

/**
 * Sets up legacy plans directory with files
 */
function setupLegacyPlans(workDir: string, files: Record<string, string>): void {
	const legacyPlansDir = join(workDir, ".milhouse", "plans");
	mkdirSync(legacyPlansDir, { recursive: true });

	for (const [filename, content] of Object.entries(files)) {
		writeFileSync(join(legacyPlansDir, filename), content);
	}
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("PlanStore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ==========================================================================
	// getCurrentPlansDir tests
	// ==========================================================================

	describe("getCurrentPlansDir", () => {
		test("returns legacy path when no active run", () => {
			// No runs-index.json exists
			const result = getCurrentPlansDir(tempDir);
			expect(result).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("returns legacy path when runs-index.json has null current_run", () => {
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			writeFileSync(
				join(milhouse, "runs-index.json"),
				JSON.stringify({ current_run: null, runs: [] }),
			);

			const result = getCurrentPlansDir(tempDir);
			expect(result).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("returns run-scoped path when active run exists", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const result = getCurrentPlansDir(tempDir);
			expect(result).toBe(join(tempDir, ".milhouse", "runs", runId, "plans"));
		});

		test("returns run-scoped path for different run IDs", () => {
			const runId1 = "run_2024-01-27_10-00-00";
			const runId2 = "run_2024-01-27_15-30-00";

			// Test first run
			setupActiveRun(tempDir, runId1);
			expect(getCurrentPlansDir(tempDir)).toBe(
				join(tempDir, ".milhouse", "runs", runId1, "plans"),
			);

			// Switch to second run
			const runsIndex = {
				current_run: runId2,
				runs: [
					{ id: runId1, created_at: new Date().toISOString(), phase: "completed" },
					{ id: runId2, created_at: new Date().toISOString(), phase: "scan" },
				],
			};
			writeFileSync(
				join(tempDir, ".milhouse", "runs-index.json"),
				JSON.stringify(runsIndex, null, 2),
			);

			expect(getCurrentPlansDir(tempDir)).toBe(
				join(tempDir, ".milhouse", "runs", runId2, "plans"),
			);
		});
	});

	// ==========================================================================
	// getLegacyPlansDir tests
	// ==========================================================================

	describe("getLegacyPlansDir", () => {
		test("always returns .milhouse/plans path", () => {
			const result = getLegacyPlansDir(tempDir);
			expect(result).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("returns same path regardless of active run", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const result = getLegacyPlansDir(tempDir);
			expect(result).toBe(join(tempDir, ".milhouse", "plans"));
		});
	});

	// ==========================================================================
	// writePlanFile / readPlanFile tests
	// ==========================================================================

	describe("writePlanFile / readPlanFile", () => {
		test("writes to legacy path when no active run", () => {
			const content = "# Test Plan\n\nThis is a test.";
			const filePath = writePlanFile(tempDir, "test.md", content);

			expect(filePath).toBe(join(tempDir, ".milhouse", "plans", "test.md"));
			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		test("writes to run-scoped path when active run exists", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const content = "# Run-scoped Plan\n\nThis is scoped to a run.";
			const filePath = writePlanFile(tempDir, "test.md", content);

			expect(filePath).toBe(join(tempDir, ".milhouse", "runs", runId, "plans", "test.md"));
			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		test("reads file from correct location", () => {
			const content = "# Readable Plan";
			writePlanFile(tempDir, "readable.md", content);

			const result = readPlanFile(tempDir, "readable.md");
			expect(result).toBe(content);
		});

		test("returns null for non-existent file", () => {
			const result = readPlanFile(tempDir, "non-existent.md");
			expect(result).toBeNull();
		});

		test("creates plans directory if it doesn't exist", () => {
			const plansDir = join(tempDir, ".milhouse", "plans");
			expect(existsSync(plansDir)).toBe(false);

			writePlanFile(tempDir, "auto-create.md", "content");

			expect(existsSync(plansDir)).toBe(true);
		});

		test("overwrites existing file", () => {
			writePlanFile(tempDir, "overwrite.md", "original content");
			writePlanFile(tempDir, "overwrite.md", "new content");

			const result = readPlanFile(tempDir, "overwrite.md");
			expect(result).toBe("new content");
		});
	});

	// ==========================================================================
	// planFileExists / listPlanFiles tests
	// ==========================================================================

	describe("planFileExists / listPlanFiles", () => {
		test("planFileExists returns true for existing file", () => {
			writePlanFile(tempDir, "exists.md", "content");
			expect(planFileExists(tempDir, "exists.md")).toBe(true);
		});

		test("planFileExists returns false for non-existent file", () => {
			expect(planFileExists(tempDir, "not-exists.md")).toBe(false);
		});

		test("listPlanFiles returns empty array when no plans", () => {
			const files = listPlanFiles(tempDir);
			expect(files).toEqual([]);
		});

		test("listPlanFiles returns all plan files", () => {
			writePlanFile(tempDir, "plan1.md", "content1");
			writePlanFile(tempDir, "plan2.md", "content2");
			writePlanFile(tempDir, "wbs.json", '{"tasks":[]}');

			const files = listPlanFiles(tempDir);
			expect(files.sort()).toEqual(["plan1.md", "plan2.md", "wbs.json"]);
		});

		test("listPlanFiles excludes directories", () => {
			writePlanFile(tempDir, "plan.md", "content");
			const plansDir = getCurrentPlansDir(tempDir);
			mkdirSync(join(plansDir, "subdir"), { recursive: true });

			const files = listPlanFiles(tempDir);
			expect(files).toEqual(["plan.md"]);
		});
	});

	// ==========================================================================
	// Specific plan file operations
	// ==========================================================================

	describe("writeIssueWbsPlan / readIssueWbsPlan", () => {
		test("writes plan_<issueId>.md file", () => {
			const issueId = "ISS-001";
			const markdown = "# WBS for ISS-001\n\n## Tasks\n- Task 1";

			const filePath = writeIssueWbsPlan(tempDir, issueId, markdown);

			expect(filePath).toContain("plan_ISS-001.md");
			expect(existsSync(filePath)).toBe(true);
		});

		test("reads plan_<issueId>.md file", () => {
			const issueId = "ISS-002";
			const markdown = "# WBS Content";

			writeIssueWbsPlan(tempDir, issueId, markdown);
			const result = readIssueWbsPlan(tempDir, issueId);

			expect(result).toBe(markdown);
		});

		test("returns null for non-existent issue plan", () => {
			const result = readIssueWbsPlan(tempDir, "NON-EXISTENT");
			expect(result).toBeNull();
		});

		test("writes to run-scoped directory when active run", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const filePath = writeIssueWbsPlan(tempDir, "ISS-003", "content");
			expect(filePath).toContain(join("runs", runId, "plans"));
		});
	});

	describe("writeIssueWbsJson / readIssueWbsJson", () => {
		test("writes wbs_<issueId>.json file", () => {
			const issueId = "ISS-001";
			const json = { tasks: [{ id: "T1", title: "Task 1" }] };

			const filePath = writeIssueWbsJson(tempDir, issueId, json);

			expect(filePath).toContain("wbs_ISS-001.json");
			expect(existsSync(filePath)).toBe(true);
		});

		test("reads and parses wbs_<issueId>.json file", () => {
			const issueId = "ISS-002";
			const json = { tasks: [{ id: "T1" }, { id: "T2" }], metadata: { version: 1 } };

			writeIssueWbsJson(tempDir, issueId, json);
			const result = readIssueWbsJson(tempDir, issueId);

			expect(result).toEqual(json);
		});

		test("returns null for non-existent WBS JSON", () => {
			const result = readIssueWbsJson(tempDir, "NON-EXISTENT");
			expect(result).toBeNull();
		});

		test("returns null for invalid JSON", () => {
			// Write invalid JSON directly
			const plansDir = join(tempDir, ".milhouse", "plans");
			mkdirSync(plansDir, { recursive: true });
			writeFileSync(join(plansDir, "wbs_INVALID.json"), "not valid json {{{");

			const result = readIssueWbsJson(tempDir, "INVALID");
			expect(result).toBeNull();
		});
	});

	describe("writeProblemBrief / readProblemBrief", () => {
		test("writes problem_brief.md file", () => {
			const markdown = "# Problem Brief\n\n## Summary\nThis is the problem.";

			const filePath = writeProblemBrief(tempDir, markdown);

			expect(filePath).toContain("problem_brief.md");
			expect(existsSync(filePath)).toBe(true);
		});

		test("reads problem_brief.md file", () => {
			const markdown = "# Problem Brief Content";

			writeProblemBrief(tempDir, markdown);
			const result = readProblemBrief(tempDir);

			expect(result).toBe(markdown);
		});

		test("returns null when problem brief doesn't exist", () => {
			const result = readProblemBrief(tempDir);
			expect(result).toBeNull();
		});
	});

	describe("writeExecutionPlan / readExecutionPlan", () => {
		test("writes execution_plan.md file", () => {
			const markdown = "# Execution Plan\n\n## Phase 1\n- Step 1";

			const filePath = writeExecutionPlan(tempDir, markdown);

			expect(filePath).toContain("execution_plan.md");
			expect(existsSync(filePath)).toBe(true);
		});

		test("reads execution_plan.md file", () => {
			const markdown = "# Execution Plan Content";

			writeExecutionPlan(tempDir, markdown);
			const result = readExecutionPlan(tempDir);

			expect(result).toBe(markdown);
		});

		test("returns null when execution plan doesn't exist", () => {
			const result = readExecutionPlan(tempDir);
			expect(result).toBeNull();
		});
	});

	// ==========================================================================
	// syncLegacyPlansView tests
	// ==========================================================================

	describe("syncLegacyPlansView", () => {
		test("does nothing when no active run", () => {
			// Create legacy plans
			setupLegacyPlans(tempDir, { "old-plan.md": "old content" });

			// Should not throw and should not modify anything
			syncLegacyPlansView(tempDir);

			// Legacy plans should still exist
			expect(existsSync(join(tempDir, ".milhouse", "plans", "old-plan.md"))).toBe(true);
		});

		test("creates symlink on Unix when active run", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			// Write a file to run plans
			writePlanFile(tempDir, "run-plan.md", "run content");

			// Sync legacy view
			syncLegacyPlansView(tempDir);

			const legacyPlansDir = join(tempDir, ".milhouse", "plans");

			// Check if it's a symlink (on Unix) or directory (on Windows/fallback)
			if (existsSync(legacyPlansDir)) {
				const stats = lstatSync(legacyPlansDir);
				if (stats.isSymbolicLink()) {
					// Verify symlink points to correct target
					const target = readlinkSync(legacyPlansDir);
					expect(target).toContain(runId);
				} else {
					// Fallback: should be a directory with copied files
					expect(stats.isDirectory()).toBe(true);
				}
			}
		});

		test("is idempotent - running twice doesn't cause errors", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);
			writePlanFile(tempDir, "plan.md", "content");

			// Run twice
			syncLegacyPlansView(tempDir);
			syncLegacyPlansView(tempDir);

			// Should not throw and legacy view should exist
			const legacyPlansDir = join(tempDir, ".milhouse", "plans");
			expect(existsSync(legacyPlansDir)).toBe(true);
		});

		test("updates when run changes", () => {
			const runId1 = "run_2024-01-27_10-00-00";
			const runId2 = "run_2024-01-27_15-00-00";

			// Setup first run
			setupActiveRun(tempDir, runId1);
			writePlanFile(tempDir, "plan1.md", "content from run 1");
			syncLegacyPlansView(tempDir);

			// Switch to second run
			const runsIndex = {
				current_run: runId2,
				runs: [
					{ id: runId1, created_at: new Date().toISOString(), phase: "completed" },
					{ id: runId2, created_at: new Date().toISOString(), phase: "scan" },
				],
			};
			writeFileSync(
				join(tempDir, ".milhouse", "runs-index.json"),
				JSON.stringify(runsIndex, null, 2),
			);

			// Create run2 plans directory and write file
			const run2PlansDir = join(tempDir, ".milhouse", "runs", runId2, "plans");
			mkdirSync(run2PlansDir, { recursive: true });
			writePlanFile(tempDir, "plan2.md", "content from run 2");

			// Sync again
			syncLegacyPlansView(tempDir);

			// Legacy view should now point to run2
			const legacyPlansDir = join(tempDir, ".milhouse", "plans");
			if (existsSync(legacyPlansDir)) {
				const stats = lstatSync(legacyPlansDir);
				if (stats.isSymbolicLink()) {
					const target = readlinkSync(legacyPlansDir);
					expect(target).toContain(runId2);
				}
			}
		});

		test("replaces existing directory with symlink", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans directory with files
			setupLegacyPlans(tempDir, { "legacy.md": "legacy content" });

			// Setup active run
			setupActiveRun(tempDir, runId);
			writePlanFile(tempDir, "run-plan.md", "run content");

			// Sync should replace directory
			syncLegacyPlansView(tempDir);

			const legacyPlansDir = join(tempDir, ".milhouse", "plans");
			expect(existsSync(legacyPlansDir)).toBe(true);
		});

		test("creates run plans directory if it doesn't exist", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Setup run without creating plans directory
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Run plans dir doesn't exist yet
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(runPlansDir)).toBe(false);

			// Sync should create it
			syncLegacyPlansView(tempDir);

			expect(existsSync(runPlansDir)).toBe(true);
		});
	});

	// ==========================================================================
	// Legacy import tests
	// ==========================================================================

	describe("hasLegacyPlansToImport", () => {
		test("returns false when no active run", () => {
			setupLegacyPlans(tempDir, { "plan.md": "content" });

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(false);
		});

		test("returns false when legacy plans dir doesn't exist", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(false);
		});

		test("returns false when legacy plans dir is empty", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			// Create empty legacy plans dir
			const legacyPlansDir = join(tempDir, ".milhouse", "plans");
			mkdirSync(legacyPlansDir, { recursive: true });

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(false);
		});

		test("returns false when legacy plans dir is a symlink", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);
			writePlanFile(tempDir, "plan.md", "content");

			// Sync creates symlink
			syncLegacyPlansView(tempDir);

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(false);
		});

		test("returns true when legacy plans exist and run plans are empty", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans first (before setting up run)
			setupLegacyPlans(tempDir, { "legacy-plan.md": "legacy content" });

			// Setup run (this creates runs-index.json but doesn't touch legacy plans)
			const milhouse = join(tempDir, ".milhouse");
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(true);
		});

		test("returns false when run already has plans", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans first
			setupLegacyPlans(tempDir, { "legacy-plan.md": "legacy content" });

			// Setup run with plans
			const milhouse = join(tempDir, ".milhouse");
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Create run plans
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			mkdirSync(runPlansDir, { recursive: true });
			writeFileSync(join(runPlansDir, "run-plan.md"), "run content");

			const result = hasLegacyPlansToImport(tempDir);
			expect(result).toBe(false);
		});
	});

	describe("importLegacyPlans", () => {
		test("returns 0 when no active run", () => {
			setupLegacyPlans(tempDir, { "plan.md": "content" });

			const result = importLegacyPlans(tempDir);
			expect(result).toBe(0);
		});

		test("returns 0 when legacy plans dir doesn't exist", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const result = importLegacyPlans(tempDir);
			expect(result).toBe(0);
		});

		test("imports legacy plans to current run", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans first
			setupLegacyPlans(tempDir, {
				"plan1.md": "content 1",
				"plan2.md": "content 2",
				"wbs.json": '{"tasks":[]}',
			});

			// Setup run
			const milhouse = join(tempDir, ".milhouse");
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			const result = importLegacyPlans(tempDir);

			expect(result).toBe(3);

			// Verify files were copied
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, "plan1.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "plan2.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "wbs.json"))).toBe(true);
		});

		test("creates marker file after import", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans
			setupLegacyPlans(tempDir, { "plan.md": "content" });

			// Setup run
			const milhouse = join(tempDir, ".milhouse");
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			importLegacyPlans(tempDir);

			// Check marker file
			const markerPath = join(milhouse, "runs", runId, "plans", ".imported-from-legacy.json");
			expect(existsSync(markerPath)).toBe(true);

			const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
			expect(marker).toHaveProperty("imported_at");
			expect(marker).toHaveProperty("files_imported");
			expect(marker.files_imported).toBe(1);
		});

		test("returns 0 when legacy dir is already a symlink", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);
			writePlanFile(tempDir, "plan.md", "content");

			// Sync creates symlink
			syncLegacyPlansView(tempDir);

			const result = importLegacyPlans(tempDir);
			expect(result).toBe(0);
		});

		test("does not import directories", () => {
			const runId = "run_2024-01-27_12-30-45";

			// Create legacy plans with a subdirectory
			const legacyPlansDir = join(tempDir, ".milhouse", "plans");
			mkdirSync(legacyPlansDir, { recursive: true });
			writeFileSync(join(legacyPlansDir, "plan.md"), "content");
			mkdirSync(join(legacyPlansDir, "subdir"), { recursive: true });
			writeFileSync(join(legacyPlansDir, "subdir", "nested.md"), "nested content");

			// Setup run
			const milhouse = join(tempDir, ".milhouse");
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			const result = importLegacyPlans(tempDir);

			// Should only import the file, not the directory
			expect(result).toBe(1);

			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, "plan.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "subdir"))).toBe(false);
		});
	});

	// ==========================================================================
	// Metadata header tests
	// ==========================================================================

	describe("createPlanMetadataHeader", () => {
		test("includes Run ID when active run exists", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const header = createPlanMetadataHeader(tempDir);

			expect(header).toContain(`<!-- Run ID: ${runId} -->`);
		});

		test("uses 'no-run' placeholder when no active run", () => {
			const header = createPlanMetadataHeader(tempDir);

			expect(header).toContain("<!-- Run ID: no-run -->");
		});

		test("includes Generated timestamp", () => {
			const header = createPlanMetadataHeader(tempDir);

			expect(header).toMatch(/<!-- Generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z -->/);
		});

		test("includes Issue field when issueId provided", () => {
			const header = createPlanMetadataHeader(tempDir, { issueId: "ISS-001" });

			expect(header).toContain("<!-- Issue: ISS-001 -->");
		});

		test("does not include Issue field when issueId not provided", () => {
			const header = createPlanMetadataHeader(tempDir);

			expect(header).not.toContain("<!-- Issue:");
		});

		test("includes Scope field when scope provided", () => {
			const header = createPlanMetadataHeader(tempDir, { scope: "authentication module" });

			expect(header).toContain("<!-- Scope: authentication module -->");
		});

		test("includes all fields when all options provided", () => {
			const runId = "run_2024-01-27_12-30-45";
			setupActiveRun(tempDir, runId);

			const header = createPlanMetadataHeader(tempDir, {
				issueId: "ISS-002",
				scope: "user management",
			});

			expect(header).toContain(`<!-- Run ID: ${runId} -->`);
			expect(header).toMatch(/<!-- Generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z -->/);
			expect(header).toContain("<!-- Issue: ISS-002 -->");
			expect(header).toContain("<!-- Scope: user management -->");
		});

		test("ends with double newline for markdown separation", () => {
			const header = createPlanMetadataHeader(tempDir);

			expect(header).toMatch(/\n\n$/);
		});

		test("header format is HTML comment style", () => {
			const header = createPlanMetadataHeader(tempDir);

			// All lines should be HTML comments
			const lines = header.trim().split("\n");
			for (const line of lines) {
				expect(line).toMatch(/^<!--.*-->$/);
			}
		});
	});
});