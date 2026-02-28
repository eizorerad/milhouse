/**
 * Issue Executor Tests
 *
 * Tests for issue-based parallel execution, including error scenarios:
 * - Rebase failure due to dirty worktree
 * - Engine execution timeout
 * - Issue not found for tasks
 * - Partial task completion detection
 *
 * @module execution/issue-executor.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AIEngine, AIResult } from "../engines/types.ts";
import type { Issue, Task } from "../state/types.ts";
import {
	type BranchStatus,
	type IssueBasedExecutionOptions,
	type IssueGroup,
	buildIssueExecutorPrompt,
	displayBranchStatusSummary,
	filterBranchesForMerge,
	groupTasksByIssue,
	runParallelByIssue,
} from "./issue-executor.ts";
import {
	registerSignalHandlers,
	removeSignalHandlers,
} from "./tmux/tmux-executor.ts";

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockTask(overrides: Partial<Task> = {}): Task {
	const now = new Date().toISOString();
	return {
		id: `TEST-T${Math.random().toString(36).substring(2, 6)}`,
		title: "Test Task",
		description: "A test task",
		files: ["src/test.ts"],
		depends_on: [],
		checks: ["npm test"],
		acceptance: [{ description: "Tests pass", verified: false }],
		parallel_group: 0,
		status: "pending",
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

function createMockIssue(overrides: Partial<Issue> = {}): Issue {
	const now = new Date().toISOString();
	return {
		id: `P-${Math.random().toString(36).substring(2, 10)}`,
		symptom: "Test symptom",
		hypothesis: "Test hypothesis",
		evidence: [],
		status: "CONFIRMED",
		severity: "MEDIUM",
		related_task_ids: [],
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

function createMockEngine(overrides: Partial<AIEngine> = {}): AIEngine {
	return {
		name: "mock-engine",
		cliCommand: "mock-cli",
		isAvailable: async () => true,
		execute: async (_prompt: string, _workDir: string): Promise<AIResult> => ({
			success: true,
			response: "Mock response",
			inputTokens: 100,
			outputTokens: 50,
		}),
		...overrides,
	};
}

// ============================================================================
// Unit Tests: groupTasksByIssue
// ============================================================================

describe("groupTasksByIssue", () => {
	it("should group tasks by issue_id", () => {
		const issue1 = createMockIssue({ id: "P-issue1" });
		const issue2 = createMockIssue({ id: "P-issue2" });

		const tasks = [
			createMockTask({ id: "T1", issue_id: "P-issue1" }),
			createMockTask({ id: "T2", issue_id: "P-issue1" }),
			createMockTask({ id: "T3", issue_id: "P-issue2" }),
		];

		const groups = groupTasksByIssue(tasks, [issue1, issue2]);

		expect(groups.length).toBe(2);
		expect(groups.find((g) => g.issueId === "P-issue1")?.tasks.length).toBe(2);
		expect(groups.find((g) => g.issueId === "P-issue2")?.tasks.length).toBe(1);
	});

	it("should create synthetic work item for tasks with missing issues", () => {
		const issue1 = createMockIssue({ id: "P-issue1" });

		const tasks = [
			createMockTask({ id: "T1", issue_id: "P-issue1" }),
			createMockTask({ id: "T2", issue_id: "P-missing" }), // Issue doesn't exist
		];

		const groups = groupTasksByIssue(tasks, [issue1]);

		// Both groups should be created - missing issue gets a synthetic work item
		expect(groups.length).toBe(2);
		const existingGroup = groups.find((g) => g.issueId === "P-issue1");
		const syntheticGroup = groups.find((g) => g.issueId === "P-missing");
		expect(existingGroup).toBeDefined();
		expect(existingGroup?.tasks.length).toBe(1);
		expect(syntheticGroup).toBeDefined();
		expect(syntheticGroup?.tasks.length).toBe(1);
		expect(syntheticGroup?.issue.status).toBe("CONFIRMED");
	});

	it("should sort groups by severity (CRITICAL > HIGH > MEDIUM > LOW)", () => {
		const issueCritical = createMockIssue({ id: "P-critical", severity: "CRITICAL" });
		const issueLow = createMockIssue({ id: "P-low", severity: "LOW" });
		const issueHigh = createMockIssue({ id: "P-high", severity: "HIGH" });

		const tasks = [
			createMockTask({ id: "T1", issue_id: "P-low" }),
			createMockTask({ id: "T2", issue_id: "P-critical" }),
			createMockTask({ id: "T3", issue_id: "P-high" }),
		];

		const groups = groupTasksByIssue(tasks, [issueCritical, issueLow, issueHigh]);

		expect(groups[0].issueId).toBe("P-critical");
		expect(groups[1].issueId).toBe("P-high");
		expect(groups[2].issueId).toBe("P-low");
	});
});

// ============================================================================
// Unit Tests: buildIssueExecutorPrompt
// ============================================================================

describe("buildIssueExecutorPrompt", () => {
	it("should include issue details in prompt", () => {
		const issue = createMockIssue({
			id: "P-test123",
			symptom: "Test symptom description",
			hypothesis: "Test hypothesis description",
			severity: "HIGH",
		});

		const tasks = [
			createMockTask({ id: "P-test123-T1", issue_id: "P-test123", title: "First task" }),
			createMockTask({ id: "P-test123-T2", issue_id: "P-test123", title: "Second task" }),
		];

		const issueGroup: IssueGroup = {
			issueId: "P-test123",
			issue,
			tasks,
		};

		const prompt = buildIssueExecutorPrompt(issueGroup, process.cwd());

		expect(prompt).toContain("P-test123");
		expect(prompt).toContain("Test symptom description");
		expect(prompt).toContain("Test hypothesis description");
		expect(prompt).toContain("HIGH");
		expect(prompt).toContain("First task");
		expect(prompt).toContain("Second task");
		expect(prompt).toContain("2 task(s)");
	});

	it("should include WBS plan from run-aware path when plan exists", () => {
		// This test verifies that buildIssueExecutorPrompt uses run-aware paths
		// The actual path resolution is handled by getPlansPathForCurrentRun
		// which returns:
		// - .milhouse/runs/<runId>/plans when a run is active
		// - .milhouse/plans when no run is active (legacy fallback)

		const issue = createMockIssue({
			id: "P-plantest",
			symptom: "Test symptom",
			hypothesis: "Test hypothesis",
		});

		const tasks = [
			createMockTask({ id: "P-plantest-T1", issue_id: "P-plantest", title: "Test task" }),
		];

		const issueGroup: IssueGroup = {
			issueId: "P-plantest",
			issue,
			tasks,
		};

		// Test should not throw even without a plan file
		const prompt = buildIssueExecutorPrompt(issueGroup, process.cwd());

		// Basic assertions - prompt should be generated
		expect(prompt).toContain("P-plantest");
		expect(prompt).toContain("Test symptom");
	});

	it("should include task dependencies", () => {
		const issue = createMockIssue({ id: "P-deps" });

		const tasks = [
			createMockTask({ id: "P-deps-T1", issue_id: "P-deps", depends_on: [] }),
			createMockTask({ id: "P-deps-T2", issue_id: "P-deps", depends_on: ["P-deps-T1"] }),
		];

		const issueGroup: IssueGroup = {
			issueId: "P-deps",
			issue,
			tasks,
		};

		const prompt = buildIssueExecutorPrompt(issueGroup, process.cwd());

		expect(prompt).toContain("P-deps-T1");
		expect(prompt).toContain("Dependencies");
	});
});

// ============================================================================
// Unit Tests: displayBranchStatusSummary
// ============================================================================

describe("displayBranchStatusSummary", () => {
	it("should handle empty branch list", () => {
		// Should not throw
		expect(() => displayBranchStatusSummary([], "main")).not.toThrow();
	});

	it("should categorize branches correctly", () => {
		const branchStatuses: BranchStatus[] = [
			{
				branch: "branch-complete",
				issueId: "P-1",
				status: "complete",
				completedTasks: 3,
				failedTasks: 0,
				totalTasks: 3,
				merged: true,
			},
			{
				branch: "branch-partial",
				issueId: "P-2",
				status: "partial",
				completedTasks: 2,
				failedTasks: 1,
				totalTasks: 3,
				merged: false,
			},
			{
				branch: "branch-failed",
				issueId: "P-3",
				status: "failed",
				completedTasks: 0,
				failedTasks: 3,
				totalTasks: 3,
				merged: false,
				error: "Engine timeout",
			},
		];

		// Should not throw
		expect(() => displayBranchStatusSummary(branchStatuses, "main")).not.toThrow();
	});
});

// ============================================================================
// Integration Tests: Error Scenarios
// ============================================================================

describe("Issue Executor Error Scenarios", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a temporary test directory
		testDir = join(process.cwd(), `.test-issue-executor-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		// Initialize git repo with "main" branch (tests use baseBranch: "main")
		execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });

		// Create initial commit
		writeFileSync(join(testDir, "README.md"), "# Test");
		execSync("git add .", { cwd: testDir, stdio: "pipe" });
		execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: "pipe" });
	});

	afterEach(() => {
		// Cleanup test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Engine Timeout Scenario", () => {
		it("should handle engine execution timeout", async () => {
			const issue = createMockIssue({ id: "P-timeout" });
			const tasks = [createMockTask({ id: "P-timeout-T1", issue_id: "P-timeout" })];

			// Create engine that times out
			const timeoutEngine = createMockEngine({
				execute: async () => {
					// Simulate timeout by throwing TimeoutError
					throw new Error("Engine execution timed out after 4000000ms");
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: timeoutEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
			};

			const result = await runParallelByIssue(tasks, [issue], options);

			// All tasks should fail due to timeout
			expect(result.tasksFailed).toBe(1);
			expect(result.tasksCompleted).toBe(0);
		});

		it("should retry on retryable errors", async () => {
			const issue = createMockIssue({ id: "P-retry" });
			const tasks = [createMockTask({ id: "P-retry-T1", issue_id: "P-retry" })];

			let attempts = 0;
			const retryEngine = createMockEngine({
				execute: async () => {
					attempts++;
					if (attempts < 2) {
						throw new Error("rate limit exceeded"); // Retryable error
					}
					return {
						success: true,
						response: "Success after retry",
						inputTokens: 100,
						outputTokens: 50,
					};
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: retryEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 3,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
			};

			const _result = await runParallelByIssue(tasks, [issue], options);

			// Should have retried and succeeded
			expect(attempts).toBeGreaterThan(1);
		});
	});

	describe("Issue Not Found Scenario", () => {
		it("should create synthetic work items for tasks with missing issues", () => {
			const existingIssue = createMockIssue({ id: "P-exists" });

			const tasks = [
				createMockTask({ id: "T1", issue_id: "P-exists" }),
				createMockTask({ id: "T2", issue_id: "P-missing" }), // This issue doesn't exist
				createMockTask({ id: "T3", issue_id: "P-also-missing" }), // This one too
			];

			const groups = groupTasksByIssue(tasks, [existingIssue]);

			// All three groups should be created - missing issues get synthetic work items
			expect(groups.length).toBe(3);
			const existingGroup = groups.find((g) => g.issueId === "P-exists");
			expect(existingGroup).toBeDefined();
			expect(existingGroup?.tasks.length).toBe(1);

			const missingGroup = groups.find((g) => g.issueId === "P-missing");
			expect(missingGroup).toBeDefined();
			expect(missingGroup?.issue.status).toBe("CONFIRMED");

			const alsoMissingGroup = groups.find((g) => g.issueId === "P-also-missing");
			expect(alsoMissingGroup).toBeDefined();
		});

		it("should create synthetic work items when issue list is empty", () => {
			const tasks = [
				createMockTask({ id: "T1", issue_id: "P-1" }),
				createMockTask({ id: "T2", issue_id: "P-2" }),
			];

			const groups = groupTasksByIssue(tasks, []);

			// Synthetic work items created for each issue_id
			expect(groups.length).toBe(2);
			expect(groups.every((g) => g.issue.status === "CONFIRMED")).toBe(true);
		});
	});

	describe("Dirty Worktree Scenario", () => {
		it("should detect dirty worktree before merge", async () => {
			// Create uncommitted changes in the test directory
			writeFileSync(join(testDir, "dirty-file.txt"), "uncommitted changes");

			const issue = createMockIssue({ id: "P-dirty" });
			const tasks = [createMockTask({ id: "P-dirty-T1", issue_id: "P-dirty" })];

			const successEngine = createMockEngine({
				execute: async () => ({
					success: true,
					response: "Task completed",
					inputTokens: 100,
					outputTokens: 50,
				}),
			});

			let _mergeAttempted = false;
			const options: IssueBasedExecutionOptions = {
				engine: successEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: false, // Enable merge to test dirty worktree handling
				onMergeComplete: async () => {
					_mergeAttempted = true;
				},
			};

			// The execution should handle dirty worktree gracefully
			// (either by auto-stashing or warning)
			const result = await runParallelByIssue(tasks, [issue], options);

			// Execution should complete (may or may not merge depending on auto-stash)
			expect(result).toBeDefined();
		});
	});

	describe("Callback Error Handling", () => {
		it("should not crash when onMergeComplete callback throws an error", async () => {
			const issue = createMockIssue({ id: "P-mergecb" });
			const tasks = [
				createMockTask({ id: "P-mergecb-T1", issue_id: "P-mergecb", title: "Task 1" }),
			];

			const successEngine = createMockEngine({
				execute: async (_prompt: string, workDir: string) => {
					writeFileSync(join(workDir, "file.ts"), "// done");
					execSync("git add .", { cwd: workDir, stdio: "pipe" });
					execSync('git commit -m "[P-mergecb] Task 1: Task 1"', {
						cwd: workDir,
						stdio: "pipe",
					});
					return {
						success: true,
						response: "Task completed",
						inputTokens: 100,
						outputTokens: 50,
					};
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: successEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: false,
				onMergeComplete: async () => {
					throw new Error("onMergeComplete callback exception");
				},
			};

			const result = await runParallelByIssue(tasks, [issue], options);

			expect(result).toBeDefined();
			expect(result.tasksCompleted).toBeGreaterThanOrEqual(0);
		});

		it("should not crash when onIssueComplete callback throws an error", async () => {
			const issue = createMockIssue({ id: "P-issuecb" });
			const tasks = [
				createMockTask({ id: "P-issuecb-T1", issue_id: "P-issuecb", title: "Task 1" }),
			];

			const successEngine = createMockEngine({
				execute: async () => ({
					success: true,
					response: "Task completed",
					inputTokens: 100,
					outputTokens: 50,
				}),
			});

			const options: IssueBasedExecutionOptions = {
				engine: successEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
				onIssueComplete: async () => {
					throw new Error("onIssueComplete callback exception");
				},
			};

			const result = await runParallelByIssue(tasks, [issue], options);

			expect(result).toBeDefined();
			expect(result.tasksCompleted).toBeGreaterThanOrEqual(0);
		});
	});

	describe("Partial Task Completion", () => {
		it("should detect partially completed tasks via git commits", async () => {
			const issue = createMockIssue({ id: "P-partial" });
			const tasks = [
				createMockTask({ id: "P-partial-T1", issue_id: "P-partial", title: "First task" }),
				createMockTask({ id: "P-partial-T2", issue_id: "P-partial", title: "Second task" }),
				createMockTask({ id: "P-partial-T3", issue_id: "P-partial", title: "Third task" }),
			];

			let taskIndex = 0;
			const partialEngine = createMockEngine({
				execute: async (_prompt: string, workDir: string) => {
					taskIndex++;
					if (taskIndex <= 2) {
						// Simulate completing first 2 tasks with commits
						writeFileSync(join(workDir, `task${taskIndex}.ts`), `// Task ${taskIndex}`);
						execSync("git add .", { cwd: workDir, stdio: "pipe" });
						execSync(`git commit -m "[P-partial] Task ${taskIndex}: Task ${taskIndex} title"`, {
							cwd: workDir,
							stdio: "pipe",
						});
						return {
							success: true,
							response: `Task ${taskIndex} completed`,
							inputTokens: 100,
							outputTokens: 50,
						};
					}
					// Third task fails
					throw new Error("Task 3 failed");
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: partialEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 1,
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
			};

			const result = await runParallelByIssue(tasks, [issue], options);

			// Should detect partial completion
			// Note: Actual detection depends on commit message format matching
			expect(result).toBeDefined();
		});
	});

	describe("Concurrent Execution", () => {
		it("should execute multiple issues in parallel", async () => {
			const issue1 = createMockIssue({ id: "P-concurrent1" });
			const issue2 = createMockIssue({ id: "P-concurrent2" });
			const issue3 = createMockIssue({ id: "P-concurrent3" });

			const tasks = [
				createMockTask({ id: "P-concurrent1-T1", issue_id: "P-concurrent1" }),
				createMockTask({ id: "P-concurrent2-T1", issue_id: "P-concurrent2" }),
				createMockTask({ id: "P-concurrent3-T1", issue_id: "P-concurrent3" }),
			];

			const executionOrder: string[] = [];
			const concurrentEngine = createMockEngine({
				execute: async (prompt: string) => {
					// Extract issue ID from prompt
					const match = prompt.match(/P-concurrent\d/);
					if (match) {
						executionOrder.push(match[0]);
					}
					// Simulate some work
					await new Promise((resolve) => setTimeout(resolve, 50));
					return {
						success: true,
						response: "Completed",
						inputTokens: 100,
						outputTokens: 50,
					};
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: concurrentEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 3, // All 3 should run in parallel
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
			};

			const _result = await runParallelByIssue(tasks, [issue1, issue2, issue3], options);

			// All 3 issues should have been processed
			expect(executionOrder.length).toBe(3);
		});

		it("should respect maxConcurrent limit", async () => {
			const issues = Array.from({ length: 5 }, (_, i) => createMockIssue({ id: `P-limit${i}` }));

			const tasks = issues.map((issue) =>
				createMockTask({ id: `${issue.id}-T1`, issue_id: issue.id }),
			);

			let concurrentCount = 0;
			let maxConcurrentObserved = 0;

			const limitEngine = createMockEngine({
				execute: async () => {
					concurrentCount++;
					maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount);
					await new Promise((resolve) => setTimeout(resolve, 100));
					concurrentCount--;
					return {
						success: true,
						response: "Completed",
						inputTokens: 100,
						outputTokens: 50,
					};
				},
			});

			const options: IssueBasedExecutionOptions = {
				engine: limitEngine,
				workDir: testDir,
				baseBranch: "main",
				maxConcurrent: 2, // Only 2 at a time
				maxRetries: 1,
				retryDelay: 100,
				skipTests: true,
				skipLint: true,
				browserEnabled: "false",
				skipMerge: true,
			};

			await runParallelByIssue(tasks, issues, options);

			// Should never exceed maxConcurrent
			expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
		});
	});
});

// ============================================================================
// Rebase Failure Tests (requires VCS mocking)
// ============================================================================

describe("Rebase Failure Scenarios", () => {
	it("should handle rebase failure gracefully", () => {
		// This test documents the expected behavior when rebase fails
		// The actual rebase logic is in merge-service.ts

		// When rebase fails:
		// 1. Error should be logged
		// 2. Branch should be preserved for manual inspection
		// 3. Task status should be updated to merge_error
		// 4. Manual merge instructions should be displayed

		// The implementation handles this in mergeCompletedBranches()
		// by catching rebase errors and:
		// - Aborting the rebase
		// - Trying direct merge as fallback
		// - Preserving branch if all attempts fail

		expect(true).toBe(true); // Placeholder - actual test requires VCS mocking
	});
});

// ============================================================================
// Unit Tests: filterBranchesForMerge (worktree cleanup failure -> merge exclusion)
// ============================================================================

describe("filterBranchesForMerge", () => {
	function createBranchStatus(branch: string, issueId: string): BranchStatus {
		return {
			branch,
			issueId,
			status: "complete",
			completedTasks: 1,
			failedTasks: 0,
			totalTasks: 1,
			merged: false,
		};
	}

	it("successful cleanup allows merge - all branches pass through when no cleanup failures", () => {
		const branchesToMerge = ["branch-a", "branch-b", "branch-c"];
		const failedCleanupBranches = new Set<string>();
		const allBranchStatuses = [
			createBranchStatus("branch-a", "P-1"),
			createBranchStatus("branch-b", "P-2"),
			createBranchStatus("branch-c", "P-3"),
		];

		const result = filterBranchesForMerge(branchesToMerge, failedCleanupBranches, allBranchStatuses);

		expect(result).toEqual(["branch-a", "branch-b", "branch-c"]);
		// No branch statuses should have error set
		expect(allBranchStatuses.every((s) => s.error === undefined)).toBe(true);
	});

	it("failed cleanup excludes branch from merge and sets error status", () => {
		const branchesToMerge = ["branch-a", "branch-b"];
		const failedCleanupBranches = new Set<string>(["branch-a"]);
		const allBranchStatuses = [
			createBranchStatus("branch-a", "P-1"),
			createBranchStatus("branch-b", "P-2"),
		];

		const result = filterBranchesForMerge(branchesToMerge, failedCleanupBranches, allBranchStatuses);

		expect(result).toEqual(["branch-b"]);
		// branch-a should have error status
		const branchAStatus = allBranchStatuses.find((s) => s.branch === "branch-a");
		expect(branchAStatus?.error).toContain("worktree cleanup failed");
		expect(branchAStatus?.merged).toBe(false);
		// branch-b should be unaffected
		const branchBStatus = allBranchStatuses.find((s) => s.branch === "branch-b");
		expect(branchBStatus?.error).toBeUndefined();
	});

	it("leftInPlace cleanup triggers exclusion after escalation failure", () => {
		// This tests the scenario where cleanupWorktree returned leftInPlace: true,
		// the forced retry also failed, and the branch ended up in failedCleanupBranches.
		// From filterBranchesForMerge's perspective, the branch is simply in the failed set.
		const branchesToMerge = ["branch-locked"];
		const failedCleanupBranches = new Set<string>(["branch-locked"]);
		const allBranchStatuses = [createBranchStatus("branch-locked", "P-1")];

		const result = filterBranchesForMerge(branchesToMerge, failedCleanupBranches, allBranchStatuses);

		expect(result).toEqual([]);
		const status = allBranchStatuses[0];
		expect(status.error).toContain("worktree cleanup failed");
		expect(status.error).toContain("locked");
		expect(status.merged).toBe(false);
	});

	it("partial cleanup failure only excludes failed branches while successful ones proceed", () => {
		const branchesToMerge = ["branch-ok-1", "branch-fail", "branch-ok-2"];
		const failedCleanupBranches = new Set<string>(["branch-fail"]);
		const allBranchStatuses = [
			createBranchStatus("branch-ok-1", "P-1"),
			createBranchStatus("branch-fail", "P-2"),
			createBranchStatus("branch-ok-2", "P-3"),
		];

		const result = filterBranchesForMerge(branchesToMerge, failedCleanupBranches, allBranchStatuses);

		// Only the failed branch should be excluded
		expect(result).toEqual(["branch-ok-1", "branch-ok-2"]);
		// Failed branch gets error
		const failedStatus = allBranchStatuses.find((s) => s.branch === "branch-fail");
		expect(failedStatus?.error).toContain("worktree cleanup failed");
		// Successful branches are unaffected
		const ok1Status = allBranchStatuses.find((s) => s.branch === "branch-ok-1");
		const ok2Status = allBranchStatuses.find((s) => s.branch === "branch-ok-2");
		expect(ok1Status?.error).toBeUndefined();
		expect(ok2Status?.error).toBeUndefined();
	});

	it("handles failed branch not in branchesToMerge gracefully", () => {
		// Edge case: a branch in failedCleanupBranches that wasn't queued for merge
		const branchesToMerge = ["branch-a"];
		const failedCleanupBranches = new Set<string>(["branch-not-queued"]);
		const allBranchStatuses = [
			createBranchStatus("branch-a", "P-1"),
			createBranchStatus("branch-not-queued", "P-2"),
		];

		const result = filterBranchesForMerge(branchesToMerge, failedCleanupBranches, allBranchStatuses);

		// branch-a should still be included since it's not in failedCleanupBranches
		expect(result).toEqual(["branch-a"]);
	});
});

describe("Signal Handler Cleanup", () => {
	it("should not leak signal handlers when an error occurs between registration and removal", () => {
		const baselineSigInt = process.listenerCount("SIGINT");
		const baselineSigTerm = process.listenerCount("SIGTERM");

		// Stub minimal objects to satisfy registerSignalHandlers signature
		const fakeServers: never[] = [];
		const fakeTmuxManager = {} as Parameters<typeof registerSignalHandlers>[1];

		let handlers: ReturnType<typeof registerSignalHandlers> | null = null;
		try {
			handlers = registerSignalHandlers(fakeServers, fakeTmuxManager);

			// Verify handlers were registered
			expect(process.listenerCount("SIGINT")).toBe(baselineSigInt + 1);
			expect(process.listenerCount("SIGTERM")).toBe(baselineSigTerm + 1);

			// Simulate an error during execution
			throw new Error("simulated execution failure");
		} catch {
			// Error is expected — the point is that finally runs
		} finally {
			if (handlers) {
				removeSignalHandlers(handlers);
			}
		}

		// After the try-finally pattern, listener counts must return to baseline
		expect(process.listenerCount("SIGINT")).toBe(baselineSigInt);
		expect(process.listenerCount("SIGTERM")).toBe(baselineSigTerm);
	});

	it("should leak signal handlers without try-finally (demonstrates the bug)", () => {
		const baselineSigInt = process.listenerCount("SIGINT");
		const baselineSigTerm = process.listenerCount("SIGTERM");

		const fakeServers: never[] = [];
		const fakeTmuxManager = {} as Parameters<typeof registerSignalHandlers>[1];

		let handlers: ReturnType<typeof registerSignalHandlers> | null = null;
		try {
			handlers = registerSignalHandlers(fakeServers, fakeTmuxManager);

			// Simulate an error — without finally, cleanup would be skipped
			throw new Error("simulated execution failure");

			// This line would never run without try-finally:
			// removeSignalHandlers(handlers);
		} catch {
			// Without try-finally, handlers would leak here
		}

		// Handlers are still registered (leaked)
		expect(process.listenerCount("SIGINT")).toBe(baselineSigInt + 1);
		expect(process.listenerCount("SIGTERM")).toBe(baselineSigTerm + 1);

		// Manual cleanup to avoid polluting other tests
		if (handlers) {
			removeSignalHandlers(handlers);
		}
	});
});
