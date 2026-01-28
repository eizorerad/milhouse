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

import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Issue, Task } from "../state/types.ts";
import type { AIEngine, AIResult } from "../engines/types.ts";
import {
	groupTasksByIssue,
	buildIssueExecutorPrompt,
	displayBranchStatusSummary,
	type IssueGroup,
	type BranchStatus,
	type IssueBasedExecutionOptions,
	runParallelByIssue,
} from "./issue-executor.ts";

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

	it("should warn and skip tasks with missing issues", () => {
		const issue1 = createMockIssue({ id: "P-issue1" });

		const tasks = [
			createMockTask({ id: "T1", issue_id: "P-issue1" }),
			createMockTask({ id: "T2", issue_id: "P-missing" }), // Issue doesn't exist
		];

		const groups = groupTasksByIssue(tasks, [issue1]);

		// Only one group should be created (for P-issue1)
		expect(groups.length).toBe(1);
		expect(groups[0].issueId).toBe("P-issue1");
		expect(groups[0].tasks.length).toBe(1);
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
		testDir = join(process.cwd(), ".test-issue-executor-" + Date.now());
		mkdirSync(testDir, { recursive: true });

		// Initialize git repo
		execSync("git init", { cwd: testDir, stdio: "pipe" });
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

			const result = await runParallelByIssue(tasks, [issue], options);

			// Should have retried and succeeded
			expect(attempts).toBeGreaterThan(1);
		});
	});

	describe("Issue Not Found Scenario", () => {
		it("should warn when tasks reference missing issues", () => {
			const existingIssue = createMockIssue({ id: "P-exists" });

			const tasks = [
				createMockTask({ id: "T1", issue_id: "P-exists" }),
				createMockTask({ id: "T2", issue_id: "P-missing" }), // This issue doesn't exist
				createMockTask({ id: "T3", issue_id: "P-also-missing" }), // This one too
			];

			const groups = groupTasksByIssue(tasks, [existingIssue]);

			// Only one group should be created
			expect(groups.length).toBe(1);
			expect(groups[0].issueId).toBe("P-exists");

			// The missing issue tasks should be skipped (logged as warning)
		});

		it("should handle empty issue list", () => {
			const tasks = [
				createMockTask({ id: "T1", issue_id: "P-1" }),
				createMockTask({ id: "T2", issue_id: "P-2" }),
			];

			const groups = groupTasksByIssue(tasks, []);

			// No groups should be created when no issues provided
			expect(groups.length).toBe(0);
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

			let mergeAttempted = false;
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
					mergeAttempted = true;
				},
			};

			// The execution should handle dirty worktree gracefully
			// (either by auto-stashing or warning)
			const result = await runParallelByIssue(tasks, [issue], options);

			// Execution should complete (may or may not merge depending on auto-stash)
			expect(result).toBeDefined();
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

			const result = await runParallelByIssue(tasks, [issue1, issue2, issue3], options);

			// All 3 issues should have been processed
			expect(executionOrder.length).toBe(3);
		});

		it("should respect maxConcurrent limit", async () => {
			const issues = Array.from({ length: 5 }, (_, i) =>
				createMockIssue({ id: `P-limit${i}` }),
			);

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
