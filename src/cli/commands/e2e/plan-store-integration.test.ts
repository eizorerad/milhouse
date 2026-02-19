/**
 * End-to-end integration tests for Plan Store (run-aware plans)
 *
 * These tests verify the full flow of the run-aware plan system:
 * - Pipeline flow: scan → validate → plan → consolidate
 * - View synchronization: .milhouse/plans reflects current run
 * - Legacy migration: import-legacy-plans command
 * - Executor integration: plans are read from correct run-scoped directory
 *
 * @module cli/commands/e2e/plan-store-integration.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
	createRun,
	getCurrentPlansDir,
	getCurrentRunId,
	getLegacyPlansDir,
	getRunDir,
	hasLegacyPlansToImport,
	importLegacyPlans,
	listPlanFiles,
	readExecutionPlan,
	readIssueWbsPlan,
	readProblemBrief,
	setCurrentRun,
	syncLegacyPlansView,
	writeExecutionPlan,
	writeIssueWbsPlan,
	writeProblemBrief,
} from "../../../state/index.ts";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a unique temporary directory for test isolation
 */
function createTempDir(): string {
	const tempBase = join(tmpdir(), "plan-store-integration-");
	const tempDir = `${tempBase}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Initialize a git repository in the given directory
 */
function initGitRepo(dir: string): void {
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });

	// Create initial commit
	writeFileSync(join(dir, "README.md"), "# Test Project\n\nThis is a test project.");
	execSync("git add .", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "Initial commit"', { cwd: dir, stdio: "pipe" });
}

/**
 * Creates a simple test project structure
 */
function createTestProject(dir: string): void {
	// Create package.json
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "test-project",
				version: "1.0.0",
				dependencies: {
					lodash: "^4.17.21",
				},
			},
			null,
			2,
		),
	);

	// Create a simple source file
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "index.ts"),
		`
export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
	);

	// Commit the project files
	execSync("git add .", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "Add project files"', { cwd: dir, stdio: "pipe" });
}

/**
 * Sets up legacy plans directory with files (not a symlink)
 */
function setupLegacyPlans(workDir: string, files: Record<string, string>): void {
	const legacyPlansDir = join(workDir, ".milhouse", "plans");
	mkdirSync(legacyPlansDir, { recursive: true });

	for (const [filename, content] of Object.entries(files)) {
		writeFileSync(join(legacyPlansDir, filename), content);
	}
}

/**
 * Creates a run and sets it as current
 */
function setupRun(workDir: string, runId?: string): string {
	const run = createRun({ workDir, scope: "test scope" });
	return run.id;
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("Plan Store Integration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		initGitRepo(tempDir);
		createTestProject(tempDir);
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ==========================================================================
	// Pipeline Flow Tests
	// ==========================================================================

	describe("Pipeline Flow (scan → validate → plan → consolidate)", () => {
		test("plans are written to runs/<runId>/plans when run is active", () => {
			// Create a run
			const runId = setupRun(tempDir);

			// Verify run is active
			expect(getCurrentRunId(tempDir)).toBe(runId);

			// Write problem brief (simulating scan)
			const problemBrief = "# Problem Brief\n\n## Summary\nTest problem description.";
			writeProblemBrief(tempDir, problemBrief);

			// Verify it was written to run-scoped directory
			const runPlansDir = join(tempDir, ".milhouse", "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, "problem_brief.md"))).toBe(true);

			// Verify content
			const content = readFileSync(join(runPlansDir, "problem_brief.md"), "utf-8");
			expect(content).toBe(problemBrief);
		});

		test("issue WBS plans are written to run-scoped directory", () => {
			const runId = setupRun(tempDir);

			// Write WBS plan for an issue (simulating plan command)
			const issueId = "ISS-001";
			const wbsPlan = "# WBS Plan for ISS-001\n\n## Tasks\n- Task 1\n- Task 2";
			writeIssueWbsPlan(tempDir, issueId, wbsPlan);

			// Verify it was written to run-scoped directory
			const runPlansDir = join(tempDir, ".milhouse", "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, `plan_${issueId}.md`))).toBe(true);

			// Verify content via read function
			const content = readIssueWbsPlan(tempDir, issueId);
			expect(content).toBe(wbsPlan);
		});

		test("execution plan is written to run-scoped directory", () => {
			const runId = setupRun(tempDir);

			// Write execution plan (simulating consolidate command)
			const executionPlan = "# Execution Plan\n\n## Phase 1\n- Step 1\n- Step 2";
			writeExecutionPlan(tempDir, executionPlan);

			// Verify it was written to run-scoped directory
			const runPlansDir = join(tempDir, ".milhouse", "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, "execution_plan.md"))).toBe(true);

			// Verify content via read function
			const content = readExecutionPlan(tempDir);
			expect(content).toBe(executionPlan);
		});

		test("getCurrentPlansDir returns run-scoped path when run is active", () => {
			const runId = setupRun(tempDir);

			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "runs", runId, "plans"));
		});

		test("getCurrentPlansDir returns legacy path when no run is active", () => {
			// No run created
			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("full pipeline writes all artifacts to run-scoped directory", () => {
			const runId = setupRun(tempDir);

			// Simulate full pipeline
			// 1. Scan - writes problem brief
			writeProblemBrief(tempDir, "# Problem Brief\n\nScanned issues.");

			// 2. Validate - updates problem brief (in real scenario)
			// For test, we just verify it exists

			// 3. Plan - writes WBS plans for each issue
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS for ISS-001");
			writeIssueWbsPlan(tempDir, "ISS-002", "# WBS for ISS-002");

			// 4. Consolidate - writes execution plan
			writeExecutionPlan(tempDir, "# Execution Plan\n\nConsolidated tasks.");

			// Verify all files are in run-scoped directory
			const runPlansDir = join(tempDir, ".milhouse", "runs", runId, "plans");
			const files = readdirSync(runPlansDir);

			expect(files).toContain("problem_brief.md");
			expect(files).toContain("plan_ISS-001.md");
			expect(files).toContain("plan_ISS-002.md");
			expect(files).toContain("execution_plan.md");
		});
	});

	// ==========================================================================
	// View Synchronization Tests
	// ==========================================================================

	describe("View Synchronization", () => {
		test("syncLegacyPlansView creates symlink to run plans", () => {
			const runId = setupRun(tempDir);

			// Write some plans
			writeProblemBrief(tempDir, "# Problem Brief");
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS Plan");

			// Sync legacy view
			syncLegacyPlansView(tempDir);

			const legacyPlansDir = join(tempDir, ".milhouse", "plans");

			// Check if it exists
			expect(existsSync(legacyPlansDir)).toBe(true);

			// Check if it's a symlink (on Unix) or directory (on Windows/fallback)
			const stats = lstatSync(legacyPlansDir);
			if (stats.isSymbolicLink()) {
				// Verify symlink points to correct target
				const target = readlinkSync(legacyPlansDir);
				expect(target).toContain(runId);
			} else {
				// Fallback: should be a directory with copied files
				expect(stats.isDirectory()).toBe(true);
				const files = readdirSync(legacyPlansDir);
				expect(files).toContain("problem_brief.md");
			}
		});

		test("legacy view reflects current run plans", () => {
			const runId = setupRun(tempDir);

			// Write plans
			writeProblemBrief(tempDir, "# Problem Brief from Run");
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS from Run");

			// Sync view
			syncLegacyPlansView(tempDir);

			// Read from legacy path
			const legacyPlansDir = getLegacyPlansDir(tempDir);
			const problemBrief = readFileSync(join(legacyPlansDir, "problem_brief.md"), "utf-8");
			const wbsPlan = readFileSync(join(legacyPlansDir, "plan_ISS-001.md"), "utf-8");

			expect(problemBrief).toBe("# Problem Brief from Run");
			expect(wbsPlan).toBe("# WBS from Run");
		});

		test("view updates when switching runs", () => {
			// Create first run
			const run1 = createRun({ workDir: tempDir, scope: "run 1" });
			writeProblemBrief(tempDir, "# Problem Brief from Run 1");
			syncLegacyPlansView(tempDir);

			// Create second run
			const run2 = createRun({ workDir: tempDir, scope: "run 2" });
			writeProblemBrief(tempDir, "# Problem Brief from Run 2");
			syncLegacyPlansView(tempDir);

			// Verify legacy view shows run 2 content
			const legacyPlansDir = getLegacyPlansDir(tempDir);
			const content = readFileSync(join(legacyPlansDir, "problem_brief.md"), "utf-8");
			expect(content).toBe("# Problem Brief from Run 2");

			// Switch back to run 1
			setCurrentRun(run1.id, tempDir);
			syncLegacyPlansView(tempDir);

			// Verify legacy view now shows run 1 content
			const content1 = readFileSync(join(legacyPlansDir, "problem_brief.md"), "utf-8");
			expect(content1).toBe("# Problem Brief from Run 1");
		});

		test("sync is idempotent", () => {
			const runId = setupRun(tempDir);
			writeProblemBrief(tempDir, "# Problem Brief");

			// Sync multiple times
			syncLegacyPlansView(tempDir);
			syncLegacyPlansView(tempDir);
			syncLegacyPlansView(tempDir);

			// Should not throw and legacy view should exist
			const legacyPlansDir = getLegacyPlansDir(tempDir);
			expect(existsSync(legacyPlansDir)).toBe(true);
		});

		test("sync replaces existing directory with symlink", () => {
			// Create legacy plans directory with files first
			setupLegacyPlans(tempDir, {
				"old_plan.md": "# Old Plan",
				"legacy_brief.md": "# Legacy Brief",
			});

			// Now create a run
			const runId = setupRun(tempDir);
			writeProblemBrief(tempDir, "# New Problem Brief");

			// Sync should replace the directory
			syncLegacyPlansView(tempDir);

			// Legacy view should now point to run plans
			const legacyPlansDir = getLegacyPlansDir(tempDir);
			const files = readdirSync(legacyPlansDir);

			// Should have new content, not old
			expect(files).toContain("problem_brief.md");
			// Old files should not exist (unless they were in run plans)
			expect(files).not.toContain("old_plan.md");
			expect(files).not.toContain("legacy_brief.md");
		});
	});

	// ==========================================================================
	// Legacy Migration Tests
	// ==========================================================================

	describe("Legacy Migration", () => {
		test("hasLegacyPlansToImport returns true when legacy plans exist", () => {
			// Create legacy plans first (before run)
			setupLegacyPlans(tempDir, {
				"problem_brief.md": "# Legacy Problem Brief",
				"plan_ISS-001.md": "# Legacy WBS",
			});

			// Create a run (but don't write any plans to it)
			const milhouse = join(tempDir, ".milhouse");
			const runId = "run_test_legacy";
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Should detect legacy plans to import
			expect(hasLegacyPlansToImport(tempDir)).toBe(true);
		});

		test("hasLegacyPlansToImport returns false when no legacy plans", () => {
			const runId = setupRun(tempDir);

			// No legacy plans exist
			expect(hasLegacyPlansToImport(tempDir)).toBe(false);
		});

		test("hasLegacyPlansToImport returns false when run already has plans", () => {
			// Create legacy plans first
			setupLegacyPlans(tempDir, {
				"problem_brief.md": "# Legacy Brief",
			});

			// Create run and write plans to it
			const milhouse = join(tempDir, ".milhouse");
			const runId = "run_with_plans";
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Create run plans directory with a file
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			mkdirSync(runPlansDir, { recursive: true });
			writeFileSync(join(runPlansDir, "problem_brief.md"), "# Run Brief");

			// Should not detect legacy plans to import (run already has plans)
			expect(hasLegacyPlansToImport(tempDir)).toBe(false);
		});

		test("importLegacyPlans copies files to current run", () => {
			// Create legacy plans
			setupLegacyPlans(tempDir, {
				"problem_brief.md": "# Legacy Problem Brief",
				"plan_ISS-001.md": "# Legacy WBS for ISS-001",
				"wbs_ISS-001.json": '{"tasks": []}',
			});

			// Create run without plans
			const milhouse = join(tempDir, ".milhouse");
			const runId = "run_import_test";
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Import legacy plans
			const imported = importLegacyPlans(tempDir);

			// Should have imported 3 files
			expect(imported).toBe(3);

			// Verify files were copied
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(join(runPlansDir, "problem_brief.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "plan_ISS-001.md"))).toBe(true);
			expect(existsSync(join(runPlansDir, "wbs_ISS-001.json"))).toBe(true);

			// Verify content
			const content = readFileSync(join(runPlansDir, "problem_brief.md"), "utf-8");
			expect(content).toBe("# Legacy Problem Brief");
		});

		test("importLegacyPlans creates marker file", () => {
			// Create legacy plans
			setupLegacyPlans(tempDir, {
				"problem_brief.md": "# Legacy Brief",
			});

			// Create run
			const milhouse = join(tempDir, ".milhouse");
			const runId = "run_marker_test";
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Import
			importLegacyPlans(tempDir);

			// Check marker file
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			const markerPath = join(runPlansDir, ".imported-from-legacy.json");
			expect(existsSync(markerPath)).toBe(true);

			// Verify marker content
			const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
			expect(marker).toHaveProperty("imported_at");
			expect(marker).toHaveProperty("files_imported");
			expect(marker.files_imported).toBe(1);
		});

		test("importLegacyPlans returns 0 when legacy dir is already a symlink", () => {
			// Create run and write plans
			const runId = setupRun(tempDir);
			writeProblemBrief(tempDir, "# Run Brief");

			// Sync creates symlink
			syncLegacyPlansView(tempDir);

			// Try to import - should return 0
			const imported = importLegacyPlans(tempDir);
			expect(imported).toBe(0);
		});

		test("dry-run mode lists files without importing", () => {
			// Create legacy plans
			setupLegacyPlans(tempDir, {
				"problem_brief.md": "# Legacy Brief",
				"plan_ISS-001.md": "# Legacy WBS",
			});

			// Create run
			const milhouse = join(tempDir, ".milhouse");
			const runId = "run_dryrun_test";
			const runsIndex = {
				current_run: runId,
				runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
			};
			writeFileSync(join(milhouse, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

			// Verify hasLegacyPlansToImport works (this is what dry-run would check)
			expect(hasLegacyPlansToImport(tempDir)).toBe(true);

			// In dry-run mode, we would NOT call importLegacyPlans
			// Just verify the files are still in legacy location
			const legacyPlansDir = getLegacyPlansDir(tempDir);
			const files = readdirSync(legacyPlansDir);
			expect(files).toContain("problem_brief.md");
			expect(files).toContain("plan_ISS-001.md");

			// Run plans should be empty
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(runPlansDir)).toBe(false);
		});
	});

	// ==========================================================================
	// Executor Integration Tests
	// ==========================================================================

	describe("Executor Integration", () => {
		test("plans are read from run-scoped directory", () => {
			const runId = setupRun(tempDir);

			// Write plans to run
			const wbsContent = "# WBS Plan\n\n## Tasks\n- Implement feature X";
			writeIssueWbsPlan(tempDir, "ISS-001", wbsContent);

			// Read via PlanStore API (this is what executor would use)
			const content = readIssueWbsPlan(tempDir, "ISS-001");
			expect(content).toBe(wbsContent);

			// Verify it's reading from run-scoped directory
			const currentPlansDir = getCurrentPlansDir(tempDir);
			expect(currentPlansDir).toContain(runId);
		});

		test("listPlanFiles returns files from run-scoped directory", () => {
			const runId = setupRun(tempDir);

			// Write multiple plans
			writeProblemBrief(tempDir, "# Brief");
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS 1");
			writeIssueWbsPlan(tempDir, "ISS-002", "# WBS 2");
			writeExecutionPlan(tempDir, "# Execution Plan");

			// List files
			const files = listPlanFiles(tempDir);

			expect(files).toContain("problem_brief.md");
			expect(files).toContain("plan_ISS-001.md");
			expect(files).toContain("plan_ISS-002.md");
			expect(files).toContain("execution_plan.md");
		});

		test("executor reads correct WBS for each issue", () => {
			const runId = setupRun(tempDir);

			// Write different WBS plans for different issues
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS for Issue 1\n\nFix authentication bug");
			writeIssueWbsPlan(tempDir, "ISS-002", "# WBS for Issue 2\n\nAdd new API endpoint");
			writeIssueWbsPlan(tempDir, "ISS-003", "# WBS for Issue 3\n\nRefactor database layer");

			// Simulate executor reading plans for each issue
			const wbs1 = readIssueWbsPlan(tempDir, "ISS-001");
			const wbs2 = readIssueWbsPlan(tempDir, "ISS-002");
			const wbs3 = readIssueWbsPlan(tempDir, "ISS-003");

			expect(wbs1).toContain("authentication bug");
			expect(wbs2).toContain("API endpoint");
			expect(wbs3).toContain("database layer");
		});

		test("plans directory is isolated per run", () => {
			// Create first run with plans
			const run1 = createRun({ workDir: tempDir, scope: "run 1" });
			writeProblemBrief(tempDir, "# Brief for Run 1");
			writeIssueWbsPlan(tempDir, "ISS-001", "# WBS for Run 1");

			// Create second run with different plans
			const run2 = createRun({ workDir: tempDir, scope: "run 2" });
			writeProblemBrief(tempDir, "# Brief for Run 2");
			writeIssueWbsPlan(tempDir, "ISS-002", "# WBS for Run 2");

			// Verify run 2 is current
			expect(getCurrentRunId(tempDir)).toBe(run2.id);

			// Read plans - should get run 2 content
			const brief = readProblemBrief(tempDir);
			expect(brief).toBe("# Brief for Run 2");

			// ISS-001 should not exist in run 2
			const wbs1 = readIssueWbsPlan(tempDir, "ISS-001");
			expect(wbs1).toBeNull();

			// ISS-002 should exist in run 2
			const wbs2 = readIssueWbsPlan(tempDir, "ISS-002");
			expect(wbs2).toBe("# WBS for Run 2");

			// Switch to run 1
			setCurrentRun(run1.id, tempDir);

			// Now should get run 1 content
			const brief1 = readProblemBrief(tempDir);
			expect(brief1).toBe("# Brief for Run 1");

			// ISS-001 should exist in run 1
			const wbs1Again = readIssueWbsPlan(tempDir, "ISS-001");
			expect(wbs1Again).toBe("# WBS for Run 1");

			// ISS-002 should not exist in run 1
			const wbs2Again = readIssueWbsPlan(tempDir, "ISS-002");
			expect(wbs2Again).toBeNull();
		});
	});

	// ==========================================================================
	// Edge Cases and Error Handling
	// ==========================================================================

	describe("Edge Cases", () => {
		test("handles missing .milhouse directory gracefully", () => {
			// Don't create any .milhouse structure
			// getCurrentPlansDir should return legacy path without error
			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("handles corrupted runs-index.json gracefully", () => {
			// Create corrupted runs-index.json
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			writeFileSync(join(milhouse, "runs-index.json"), "not valid json {{{");

			// Should fall back to legacy path
			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("handles empty runs-index.json gracefully", () => {
			// Create empty runs-index.json
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			writeFileSync(join(milhouse, "runs-index.json"), "{}");

			// Should fall back to legacy path
			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("handles run with null current_run", () => {
			// Create runs-index with null current_run
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			writeFileSync(
				join(milhouse, "runs-index.json"),
				JSON.stringify({ current_run: null, runs: [] }),
			);

			// Should fall back to legacy path
			const plansDir = getCurrentPlansDir(tempDir);
			expect(plansDir).toBe(join(tempDir, ".milhouse", "plans"));
		});

		test("sync handles missing run plans directory", () => {
			// Create run but don't create plans directory
			const milhouse = join(tempDir, ".milhouse");
			mkdirSync(milhouse, { recursive: true });
			const runId = "run_no_plans_dir";
			writeFileSync(
				join(milhouse, "runs-index.json"),
				JSON.stringify({
					current_run: runId,
					runs: [{ id: runId, created_at: new Date().toISOString(), phase: "scan" }],
				}),
			);

			// Sync should create the directory
			syncLegacyPlansView(tempDir);

			// Run plans directory should now exist
			const runPlansDir = join(milhouse, "runs", runId, "plans");
			expect(existsSync(runPlansDir)).toBe(true);
		});

		test("read returns null for non-existent plan files", () => {
			const runId = setupRun(tempDir);

			// Try to read non-existent files
			expect(readProblemBrief(tempDir)).toBeNull();
			expect(readIssueWbsPlan(tempDir, "NON-EXISTENT")).toBeNull();
			expect(readExecutionPlan(tempDir)).toBeNull();
		});
	});
});
