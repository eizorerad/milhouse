/**
 * Validation Index Module Tests
 *
 * Tests for validation report indexing functionality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getValidationIndexPath,
	getValidationReportsDir,
	loadValidationIndex,
	saveValidationIndex,
	addValidationReportToIndex,
	updateValidationIndex,
	getValidationReportsForRun,
	getValidationReportsByIssue,
	getLatestValidationReport,
	getValidationReportsByStatus,
	countValidationReportsByStatus,
	isIssueValidated,
	getUnvalidatedIssueIds,
	removeValidationReportFromIndex,
	clearValidationIndex,
	rebuildValidationIndex,
} from "./validation-index.ts";
import { createRun, getRunDir } from "./runs.ts";

describe("Validation Index Module Tests", () => {
	const testDir = join(process.cwd(), ".test-validation-index");

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
		test("getValidationIndexPath should return correct path", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const path = getValidationIndexPath(run.id, testDir);

			expect(path).toContain(run.id);
			expect(path).toEndWith("validation-index.json");
		});

		test("getValidationReportsDir should return correct path", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const dir = getValidationReportsDir(run.id, testDir);

			expect(dir).toContain(run.id);
			expect(dir).toContain("validation-reports");
		});
	});

	describe("Index Operations", () => {
		test("loadValidationIndex should return empty index when file does not exist", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const index = loadValidationIndex(run.id, testDir);

			expect(index.run_id).toBe(run.id);
			expect(index.reports).toEqual([]);
			expect(index.updated_at).toBeDefined();
		});

		test("saveValidationIndex should create index file", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			saveValidationIndex(
				{
					run_id: run.id,
					reports: [],
					updated_at: new Date().toISOString(),
				},
				testDir
			);

			const indexPath = getValidationIndexPath(run.id, testDir);
			expect(existsSync(indexPath)).toBe(true);
		});

		test("saveValidationIndex should update updated_at timestamp", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const oldTimestamp = "2024-01-01T00:00:00.000Z";

			saveValidationIndex(
				{
					run_id: run.id,
					reports: [],
					updated_at: oldTimestamp,
				},
				testDir
			);

			const loaded = loadValidationIndex(run.id, testDir);
			expect(loaded.updated_at).not.toBe(oldTimestamp);
		});

		test("addValidationReportToIndex should add new report", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			addValidationReportToIndex(
				run.id,
				{
					issue_id: "ISSUE-1",
					report_path: "reports/issue-1.json",
					status: "valid",
				},
				testDir
			);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(1);
			expect(index.reports[0].issue_id).toBe("ISSUE-1");
			expect(index.reports[0].status).toBe("valid");
			expect(index.reports[0].created_at).toBeDefined();
		});

		test("addValidationReportToIndex should update existing report", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			// Add initial report
			addValidationReportToIndex(
				run.id,
				{
					issue_id: "ISSUE-1",
					report_path: "reports/issue-1.json",
					status: "partial",
				},
				testDir
			);

			// Update same report
			addValidationReportToIndex(
				run.id,
				{
					issue_id: "ISSUE-1",
					report_path: "reports/issue-1.json",
					status: "valid",
				},
				testDir
			);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(1);
			expect(index.reports[0].status).toBe("valid");
		});

		test("updateValidationIndex should add report with correct status", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "reports/issue-1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "reports/issue-2.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "reports/issue-3.json", "partial", testDir);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(3);
		});
	});

	describe("Query Operations", () => {
		test("getValidationReportsForRun should return all reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "invalid", testDir);

			const reports = getValidationReportsForRun(run.id, testDir);
			expect(reports.length).toBe(2);
		});

		test("getValidationReportsByIssue should filter by issue ID", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-1", "r1-v2.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "invalid", testDir);

			const issue1Reports = getValidationReportsByIssue(run.id, "ISSUE-1", testDir);
			expect(issue1Reports.length).toBe(2);

			const issue2Reports = getValidationReportsByIssue(run.id, "ISSUE-2", testDir);
			expect(issue2Reports.length).toBe(1);
		});

		test("getLatestValidationReport should return most recent report", async () => {
			const run = createRun({ scope: "test", workDir: testDir });

			addValidationReportToIndex(
				run.id,
				{
					issue_id: "ISSUE-1",
					report_path: "r1.json",
					status: "partial",
					created_at: "2024-01-01T00:00:00Z",
				},
				testDir
			);

			addValidationReportToIndex(
				run.id,
				{
					issue_id: "ISSUE-1",
					report_path: "r1-v2.json",
					status: "valid",
					created_at: "2024-01-15T00:00:00Z",
				},
				testDir
			);

			const latest = getLatestValidationReport(run.id, "ISSUE-1", testDir);
			expect(latest).not.toBeNull();
			expect(latest!.report_path).toBe("r1-v2.json");
			expect(latest!.status).toBe("valid");
		});

		test("getLatestValidationReport should return null when no reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const latest = getLatestValidationReport(run.id, "ISSUE-1", testDir);

			expect(latest).toBeNull();
		});

		test("getValidationReportsByStatus should filter by status", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "r3.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-4", "r4.json", "partial", testDir);

			const validReports = getValidationReportsByStatus(run.id, "valid", testDir);
			expect(validReports.length).toBe(2);

			const invalidReports = getValidationReportsByStatus(run.id, "invalid", testDir);
			expect(invalidReports.length).toBe(1);

			const partialReports = getValidationReportsByStatus(run.id, "partial", testDir);
			expect(partialReports.length).toBe(1);
		});

		test("countValidationReportsByStatus should return correct counts", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "r3.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-4", "r4.json", "partial", testDir);

			const counts = countValidationReportsByStatus(run.id, testDir);

			expect(counts.valid).toBe(2);
			expect(counts.invalid).toBe(1);
			expect(counts.partial).toBe(1);
			expect(counts.total).toBe(4);
		});

		test("isIssueValidated should return true when issue has reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);

			expect(isIssueValidated(run.id, "ISSUE-1", testDir)).toBe(true);
			expect(isIssueValidated(run.id, "ISSUE-2", testDir)).toBe(false);
		});

		test("getUnvalidatedIssueIds should return issues without reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "r3.json", "invalid", testDir);

			const allIssueIds = ["ISSUE-1", "ISSUE-2", "ISSUE-3", "ISSUE-4"];
			const unvalidated = getUnvalidatedIssueIds(run.id, allIssueIds, testDir);

			expect(unvalidated).toEqual(["ISSUE-2", "ISSUE-4"]);
		});
	});

	describe("Cleanup Operations", () => {
		test("removeValidationReportFromIndex should remove specific report", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "invalid", testDir);

			const removed = removeValidationReportFromIndex(run.id, "ISSUE-1", "r1.json", testDir);
			expect(removed).toBe(true);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(1);
			expect(index.reports[0].issue_id).toBe("ISSUE-2");
		});

		test("removeValidationReportFromIndex should return false when not found", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const removed = removeValidationReportFromIndex(run.id, "ISSUE-1", "r1.json", testDir);
			expect(removed).toBe(false);
		});

		test("clearValidationIndex should remove all reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "r3.json", "partial", testDir);

			clearValidationIndex(run.id, testDir);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(0);
		});
	});

	describe("Rebuild Index", () => {
		test("rebuildValidationIndex should create empty index when no reports dir", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			const count = rebuildValidationIndex(run.id, testDir);
			expect(count).toBe(0);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(0);
		});

		test("rebuildValidationIndex should index existing report files", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const reportsDir = getValidationReportsDir(run.id, testDir);
			mkdirSync(reportsDir, { recursive: true });

			// Create some report files
			writeFileSync(
				join(reportsDir, "ISSUE-1.json"),
				JSON.stringify({
					issue_id: "ISSUE-1",
					verdict: "CONFIRMED",
					created_at: "2024-01-15T00:00:00Z",
				})
			);

			writeFileSync(
				join(reportsDir, "ISSUE-2.json"),
				JSON.stringify({
					issue_id: "ISSUE-2",
					verdict: "FALSE",
					timestamp: "2024-01-16T00:00:00Z",
				})
			);

			const count = rebuildValidationIndex(run.id, testDir);
			expect(count).toBe(2);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports.length).toBe(2);

			// Check status mapping
			const issue1Report = index.reports.find((r) => r.issue_id === "ISSUE-1");
			expect(issue1Report!.status).toBe("valid");

			const issue2Report = index.reports.find((r) => r.issue_id === "ISSUE-2");
			expect(issue2Report!.status).toBe("invalid");
		});

		test("rebuildValidationIndex should handle invalid report files", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const reportsDir = getValidationReportsDir(run.id, testDir);
			mkdirSync(reportsDir, { recursive: true });

			// Create valid report
			writeFileSync(
				join(reportsDir, "ISSUE-1.json"),
				JSON.stringify({ issue_id: "ISSUE-1", verdict: "CONFIRMED" })
			);

			// Create invalid report
			writeFileSync(join(reportsDir, "invalid.json"), "{ invalid json }");

			const count = rebuildValidationIndex(run.id, testDir);
			expect(count).toBe(1); // Only valid report indexed
		});

		test("rebuildValidationIndex should extract issue_id from filename if not in content", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const reportsDir = getValidationReportsDir(run.id, testDir);
			mkdirSync(reportsDir, { recursive: true });

			// Create report without issue_id in content
			writeFileSync(
				join(reportsDir, "ISSUE-123.json"),
				JSON.stringify({ verdict: "CONFIRMED" })
			);

			rebuildValidationIndex(run.id, testDir);

			const index = loadValidationIndex(run.id, testDir);
			expect(index.reports[0].issue_id).toBe("ISSUE-123");
		});
	});

	describe("Edge Cases", () => {
		test("should handle empty issue IDs array in getUnvalidatedIssueIds", () => {
			const run = createRun({ scope: "test", workDir: testDir });
			const unvalidated = getUnvalidatedIssueIds(run.id, [], testDir);

			expect(unvalidated).toEqual([]);
		});

		test("should handle multiple reports for same issue with different paths", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1-v1.json", "partial", testDir);
			updateValidationIndex(run.id, "ISSUE-1", "r1-v2.json", "valid", testDir);

			const reports = getValidationReportsByIssue(run.id, "ISSUE-1", testDir);
			expect(reports.length).toBe(2);
		});

		test("should preserve report order when adding multiple reports", () => {
			const run = createRun({ scope: "test", workDir: testDir });

			updateValidationIndex(run.id, "ISSUE-1", "r1.json", "valid", testDir);
			updateValidationIndex(run.id, "ISSUE-2", "r2.json", "invalid", testDir);
			updateValidationIndex(run.id, "ISSUE-3", "r3.json", "partial", testDir);

			const reports = getValidationReportsForRun(run.id, testDir);
			expect(reports[0].issue_id).toBe("ISSUE-1");
			expect(reports[1].issue_id).toBe("ISSUE-2");
			expect(reports[2].issue_id).toBe("ISSUE-3");
		});
	});
});
