/**
 * @fileoverview Tests for verification-report.ts
 *
 * Tests for verification report generation and saving functions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	generateVerificationMarkdownReport,
	getVerificationReportsDir,
	saveVerificationReport,
	updateVerificationIndex,
} from "./verification-report.ts";
import type {
	VerificationReport,
	VerificationIndex,
	VerificationIndexEntry,
} from "./verification-types.ts";

// Test directory for file operations
const TEST_DIR = `.test-verification-report-${Date.now()}`;
const MILHOUSE_DIR = join(TEST_DIR, ".milhouse");
const RUNS_DIR = join(MILHOUSE_DIR, "runs");

// Create a mock verification report for testing
const createMockReport = (overrides: Partial<VerificationReport> = {}): VerificationReport => ({
	run_id: "test-run-123",
	created_at: "2024-01-15T10:30:00Z",
	duration_ms: 5000,
	overall_success: true,
	gates: {
		total: 3,
		passed: 2,
		failed: 1,
		results: [
			{
				gate: "diff-hygiene",
				passed: true,
				message: "No issues found",
				evidence: [],
			},
			{
				gate: "env-consistency",
				passed: true,
				message: "Environment is consistent",
				evidence: [],
			},
			{
				gate: "dod",
				passed: false,
				message: "Definition of Done not met",
				evidence: [
					{
						type: "file",
						file: "src/test.ts",
						line_start: 10,
						timestamp: "2024-01-15T10:30:00Z",
					},
				],
			},
		],
	},
	issues: [
		{
			gate: "dod",
			severity: "ERROR",
			file: "src/test.ts",
			line: 10,
			message: "Missing test coverage",
			evidence: {
				type: "file",
				file: "src/test.ts",
				line_start: 10,
				timestamp: "2024-01-15T10:30:00Z",
			},
		},
	],
	ai_verification: {
		overall_pass: true,
		recommendations: ["Add more unit tests", "Improve error handling"],
		regressions_found: false,
		summary: "Code changes look good overall with minor improvements needed.",
	},
	tokens: {
		input: 1500,
		output: 500,
	},
	tasks: {
		completed: 5,
		failed: 1,
		total: 6,
	},
	...overrides,
});

describe("verification-report", () => {
	beforeEach(() => {
		// Create test directory structure
		mkdirSync(MILHOUSE_DIR, { recursive: true });
		mkdirSync(RUNS_DIR, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	describe("getVerificationReportsDir", () => {
		it("should create verification reports directory if it doesn't exist", () => {
			const reportsDir = getVerificationReportsDir(TEST_DIR);

			expect(existsSync(reportsDir)).toBe(true);
			expect(reportsDir).toContain("verification-reports");
		});

		it("should return correct path", () => {
			const reportsDir = getVerificationReportsDir(TEST_DIR);

			expect(reportsDir).toBe(join(MILHOUSE_DIR, "verification-reports"));
		});

		it("should not fail if directory already exists", () => {
			// Create directory first
			const expectedDir = join(MILHOUSE_DIR, "verification-reports");
			mkdirSync(expectedDir, { recursive: true });

			// Should not throw
			const reportsDir = getVerificationReportsDir(TEST_DIR);
			expect(reportsDir).toBe(expectedDir);
		});
	});

	describe("saveVerificationReport", () => {
		it("should save report to global reports directory", () => {
			const report = createMockReport();
			const runId = "save-test-run-1";

			// Create run directory
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			const savedPath = saveVerificationReport(report, TEST_DIR, runId);

			expect(existsSync(savedPath)).toBe(true);
			expect(savedPath).toContain("verification-reports");
			expect(savedPath).toContain(`${runId}.json`);

			// Verify content
			const content = JSON.parse(readFileSync(savedPath, "utf-8"));
			expect(content.run_id).toBe(runId);
			expect(content.overall_success).toBe(true);
		});

		it("should save report to run directory", () => {
			const report = createMockReport();
			const runId = "save-test-run-2";

			// Create run directory
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			saveVerificationReport(report, TEST_DIR, runId);

			const runReportPath = join(runDir, "verification-report.json");
			expect(existsSync(runReportPath)).toBe(true);

			// Verify content
			const content = JSON.parse(readFileSync(runReportPath, "utf-8"));
			expect(content.run_id).toBe(runId);
		});

		it("should update verification index", () => {
			const report = createMockReport();
			const runId = "save-test-run-3";

			// Create run directory
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			saveVerificationReport(report, TEST_DIR, runId);

			const indexPath = join(runDir, "verification-index.json");
			expect(existsSync(indexPath)).toBe(true);

			// Verify index content
			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as VerificationIndex;
			expect(index.run_id).toBe(runId);
			expect(index.reports.length).toBe(1);
			expect(index.reports[0].run_id).toBe(runId);
			expect(index.reports[0].overall_success).toBe(true);
		});

		it("should enrich report with run_id and created_at", () => {
			const report = createMockReport({ run_id: "", created_at: "" });
			const runId = "save-test-run-4";

			// Create run directory
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			const savedPath = saveVerificationReport(report, TEST_DIR, runId);

			const content = JSON.parse(readFileSync(savedPath, "utf-8"));
			expect(content.run_id).toBe(runId);
			expect(content.created_at).toBeTruthy();
		});
	});

	describe("updateVerificationIndex", () => {
		it("should create new index if it doesn't exist", () => {
			const runId = "index-test-run-1";
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			const entry: VerificationIndexEntry = {
				run_id: runId,
				report_path: "/path/to/report.json",
				created_at: "2024-01-15T10:30:00Z",
				overall_success: true,
				gates_passed: 3,
				gates_failed: 0,
			};

			updateVerificationIndex(runId, entry, TEST_DIR);

			const indexPath = join(runDir, "verification-index.json");
			expect(existsSync(indexPath)).toBe(true);

			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as VerificationIndex;
			expect(index.run_id).toBe(runId);
			expect(index.reports.length).toBe(1);
			expect(index.reports[0]).toEqual(entry);
		});

		it("should update existing entry", () => {
			const runId = "index-test-run-2";
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			// Create initial entry
			const initialEntry: VerificationIndexEntry = {
				run_id: runId,
				report_path: "/path/to/report.json",
				created_at: "2024-01-15T10:30:00Z",
				overall_success: false,
				gates_passed: 2,
				gates_failed: 1,
			};

			updateVerificationIndex(runId, initialEntry, TEST_DIR);

			// Update with new entry (same run_id)
			const updatedEntry: VerificationIndexEntry = {
				run_id: runId,
				report_path: "/path/to/report.json",
				created_at: "2024-01-15T11:00:00Z",
				overall_success: true,
				gates_passed: 3,
				gates_failed: 0,
			};

			updateVerificationIndex(runId, updatedEntry, TEST_DIR);

			const indexPath = join(runDir, "verification-index.json");
			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as VerificationIndex;

			// Should still have only one entry (updated)
			expect(index.reports.length).toBe(1);
			expect(index.reports[0].overall_success).toBe(true);
			expect(index.reports[0].gates_passed).toBe(3);
			expect(index.reports[0].created_at).toBe("2024-01-15T11:00:00Z");
		});

		it("should add new entry with different run_id", () => {
			const runId = "index-test-run-3";
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			// Create first entry
			const entry1: VerificationIndexEntry = {
				run_id: "run-a",
				report_path: "/path/to/report-a.json",
				created_at: "2024-01-15T10:30:00Z",
				overall_success: true,
				gates_passed: 3,
				gates_failed: 0,
			};

			updateVerificationIndex(runId, entry1, TEST_DIR);

			// Add second entry with different run_id
			const entry2: VerificationIndexEntry = {
				run_id: "run-b",
				report_path: "/path/to/report-b.json",
				created_at: "2024-01-15T11:00:00Z",
				overall_success: false,
				gates_passed: 2,
				gates_failed: 1,
			};

			updateVerificationIndex(runId, entry2, TEST_DIR);

			const indexPath = join(runDir, "verification-index.json");
			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as VerificationIndex;

			// Should have two entries
			expect(index.reports.length).toBe(2);
			expect(index.reports[0].run_id).toBe("run-a");
			expect(index.reports[1].run_id).toBe("run-b");
		});

		it("should handle corrupted index file gracefully", () => {
			const runId = "index-test-run-4";
			const runDir = join(RUNS_DIR, runId);
			mkdirSync(runDir, { recursive: true });

			// Write corrupted JSON
			const indexPath = join(runDir, "verification-index.json");
			const { writeFileSync } = require("node:fs");
			writeFileSync(indexPath, "{ invalid json }");

			const entry: VerificationIndexEntry = {
				run_id: runId,
				report_path: "/path/to/report.json",
				created_at: "2024-01-15T10:30:00Z",
				overall_success: true,
				gates_passed: 3,
				gates_failed: 0,
			};

			// Should not throw, should create new index
			updateVerificationIndex(runId, entry, TEST_DIR);

			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as VerificationIndex;
			expect(index.run_id).toBe(runId);
			expect(index.reports.length).toBe(1);
		});
	});

	describe("generateVerificationMarkdownReport", () => {
		it("should generate markdown with correct status emoji for success", () => {
			const report = createMockReport({ overall_success: true });
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("# Verification Report ✅");
			expect(markdown).toContain("**Overall Status**: PASSED");
		});

		it("should generate markdown with correct status emoji for failure", () => {
			const report = createMockReport({ overall_success: false });
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("# Verification Report ❌");
			expect(markdown).toContain("**Overall Status**: FAILED");
		});

		it("should include run ID and timestamp", () => {
			const report = createMockReport({
				run_id: "my-test-run-id",
				created_at: "2024-01-15T10:30:00Z",
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("`my-test-run-id`");
			expect(markdown).toContain("2024-01-15T10:30:00Z");
		});

		it("should include summary table", () => {
			const report = createMockReport({
				gates: {
					total: 5,
					passed: 4,
					failed: 1,
					results: [],
				},
				tasks: {
					completed: 10,
					failed: 2,
					total: 12,
				},
				tokens: {
					input: 2500,
					output: 800,
				},
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("| Gates Total | 5 |");
			expect(markdown).toContain("| Gates Passed | 4 |");
			expect(markdown).toContain("| Gates Failed | 1 |");
			expect(markdown).toContain("| Tasks Completed | 10 |");
			expect(markdown).toContain("| Tasks Failed | 2 |");
			expect(markdown).toContain("| Tasks Total | 12 |");
			expect(markdown).toContain("| Input Tokens | 2,500 |");
			expect(markdown).toContain("| Output Tokens | 800 |");
		});

		it("should include gate results", () => {
			const report = createMockReport();
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("## Gate Results");
			expect(markdown).toContain("| diff-hygiene | ✅ PASSED | No issues found |");
			expect(markdown).toContain("| env-consistency | ✅ PASSED | Environment is consistent |");
			expect(markdown).toContain("| dod | ❌ FAILED | Definition of Done not met |");
		});

		it("should include gate evidence details for failed gates", () => {
			const report = createMockReport();
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("### Gate Evidence Details");
			expect(markdown).toContain("#### dod");
			expect(markdown).toContain("`src/test.ts`");
		});

		it("should include issues section when issues exist", () => {
			const report = createMockReport();
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("## Issues Found");
			expect(markdown).toContain("| 🔴 ERROR | dod | `src/test.ts:10` | Missing test coverage |");
		});

		it("should show no issues message when no issues exist", () => {
			const report = createMockReport({ issues: [] });
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("✅ *No issues found during verification.*");
		});

		it("should include AI verification section when present", () => {
			const report = createMockReport();
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("## AI Verification");
			expect(markdown).toContain("| Overall Pass | ✅ Yes |");
			expect(markdown).toContain("| Regressions Found | ✅ No |");
			expect(markdown).toContain("### Summary");
			expect(markdown).toContain("Code changes look good overall with minor improvements needed.");
			expect(markdown).toContain("### Recommendations");
			expect(markdown).toContain("- Add more unit tests");
			expect(markdown).toContain("- Improve error handling");
		});

		it("should handle missing AI verification", () => {
			const report = createMockReport({ ai_verification: undefined });
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("*AI verification was not performed or failed.*");
		});

		it("should include task completion section", () => {
			const report = createMockReport({
				tasks: {
					completed: 8,
					failed: 2,
					total: 10,
				},
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("## Task Completion");
			expect(markdown).toContain("| Completed | 8 |");
			expect(markdown).toContain("| Failed | 2 |");
			expect(markdown).toContain("| Total | 10 |");
			expect(markdown).toContain("**Completion Rate**: 80.0%");
		});

		it("should handle zero total tasks", () => {
			const report = createMockReport({
				tasks: {
					completed: 0,
					failed: 0,
					total: 0,
				},
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("**Completion Rate**: 0%");
		});

		it("should include duration in seconds", () => {
			const report = createMockReport({ duration_ms: 12345 });
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("**Duration**: 12.35s");
		});

		it("should show warning emoji for WARNING severity issues", () => {
			const report = createMockReport({
				issues: [
					{
						gate: "diff-hygiene",
						severity: "WARNING",
						message: "Minor style issue",
					},
				],
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("| 🟡 WARNING | diff-hygiene |");
		});

		it("should handle no gates executed", () => {
			const report = createMockReport({
				gates: {
					total: 0,
					passed: 0,
					failed: 0,
					results: [],
				},
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("*No gates were executed.*");
		});

		it("should include issue evidence details", () => {
			const report = createMockReport({
				issues: [
					{
						gate: "dod",
						severity: "ERROR",
						file: "src/main.ts",
						line: 25,
						message: "Test failure detected",
						evidence: {
							type: "command",
							command: "npm test",
							output: "FAIL: Expected 1 but got 2",
							timestamp: "2024-01-15T10:30:00Z",
						},
					},
				],
			});
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown).toContain("### Issue Evidence Details");
			expect(markdown).toContain("#### dod: Test failure detected");
			expect(markdown).toContain("FAIL: Expected 1 but got 2");
		});

		it("should return a non-empty markdown string", () => {
			const report = createMockReport();
			const markdown = generateVerificationMarkdownReport(report);

			expect(markdown.length).toBeGreaterThan(100);
			expect(markdown).toContain("#"); // Should have markdown headers
		});
	});
});
