/**
 * Task Commit Matcher Utility
 *
 * Matches task IDs to git commits based on commit message patterns
 * AND validates that matching commits contain actual code changes.
 * Used to determine which tasks were actually completed during partial execution.
 *
 * @module execution/utils/task-commit-matcher
 */

import type { Task } from "../../state/types.ts";
import { logDebug, logWarn } from "../../ui/logger.ts";
import { getCommitDiffStats, getCommitsSinceBase } from "../../vcs/backends/git-cli.ts";
import type { CommitEntry } from "../../vcs/backends/types.ts";

/**
 * Result of matching tasks to commits
 */
export interface TaskMatchResult {
	/** Task IDs that have matching commits */
	completedTaskIds: string[];
	/** Task IDs that do not have matching commits */
	uncommittedTaskIds: string[];
}

/**
 * Match tasks to commits based on commit message patterns.
 *
 * Commits are expected to match the pattern: `[{issueId}] Task N: <title>`
 * where N is the 1-indexed task number.
 *
 * Also matches by task title substring for robustness.
 *
 * @param issueId - The issue ID to match against
 * @param tasks - Array of tasks to match
 * @param commits - Array of commits to search
 * @returns Object with completedTaskIds and uncommittedTaskIds
 */
export function matchTasksToCommits(
	issueId: string,
	tasks: Task[],
	commits: CommitEntry[],
): TaskMatchResult {
	const completedTaskIds: string[] = [];
	const uncommittedTaskIds: string[] = [];

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		const taskNumber = i + 1;

		// Pattern: [ISSUE_ID] Task N:
		const exactPattern = `[${issueId}] Task ${taskNumber}:`;

		// Check if any commit matches
		const hasMatchingCommit = commits.some((commit) => {
			// Check exact pattern match
			if (commit.message.includes(exactPattern)) {
				return true;
			}

			// Check title substring match (case insensitive)
			// Only match if the commit message contains the issue ID
			if (commit.message.includes(`[${issueId}]`)) {
				const titleLower = task.title.toLowerCase();
				const messageLower = commit.message.toLowerCase();
				if (messageLower.includes(titleLower)) {
					return true;
				}
			}

			return false;
		});

		if (hasMatchingCommit) {
			completedTaskIds.push(task.id);
		} else {
			uncommittedTaskIds.push(task.id);
		}
	}

	return {
		completedTaskIds,
		uncommittedTaskIds,
	};
}

/**
 * Result of analyzing issue task completion
 */
export interface IssueTaskCompletionResult {
	/** Task IDs that were successfully completed (committed) */
	completedTaskIds: string[];
	/** Task IDs that failed or were not completed */
	failedTaskIds: string[];
}

/**
 * Issue group structure for task completion analysis
 */
export interface IssueGroupForAnalysis {
	/** Issue ID */
	issueId: string;
	/** Tasks in this issue group */
	tasks: Task[];
}

/**
 * Analyze task completion for an issue by checking git commits.
 *
 * Retrieves commits from the worktree branch and matches them to tasks
 * to determine which tasks were actually completed.
 *
 * @param issueGroup - The issue group containing tasks to analyze
 * @param worktreeDir - The worktree directory containing the commits
 * @param baseBranch - The base branch to compare against
 * @returns Object with completedTaskIds and failedTaskIds
 */
export async function analyzeIssueTaskCompletion(
	issueGroup: IssueGroupForAnalysis,
	worktreeDir: string,
	baseBranch: string,
): Promise<IssueTaskCompletionResult> {
	logDebug(`Analyzing task completion for issue ${issueGroup.issueId}`);
	logDebug(`  Worktree: ${worktreeDir}`);
	logDebug(`  Base branch: ${baseBranch}`);
	logDebug(`  Tasks to analyze: ${issueGroup.tasks.length}`);

	// Get commits since base branch
	const commitsResult = await getCommitsSinceBase(worktreeDir, baseBranch);

	if (!commitsResult.ok) {
		// If we can't get commits, treat all tasks as failed
		logDebug(`  Failed to get commits: ${commitsResult.error?.message}`);
		return {
			completedTaskIds: [],
			failedTaskIds: issueGroup.tasks.map((t) => t.id),
		};
	}

	const commits = commitsResult.value;
	logDebug(`  Found ${commits.length} commit(s) since ${baseBranch}`);
	for (const commit of commits) {
		logDebug(`    - ${commit.hash.slice(0, 7)}: ${commit.message.slice(0, 60)}`);
	}

	// Match tasks to commits (by message pattern)
	const matchResult = matchTasksToCommits(issueGroup.issueId, issueGroup.tasks, commits);

	// Verify matched commits have actual code changes (prevent phantom completions)
	// Agents sometimes create commits with matching messages but zero diffs
	const verifiedCompletedIds: string[] = [];
	const phantomTaskIds: string[] = [];

	for (const taskId of matchResult.completedTaskIds) {
		const taskIndex = issueGroup.tasks.findIndex((t) => t.id === taskId);
		if (taskIndex < 0) {
			verifiedCompletedIds.push(taskId);
			continue;
		}

		const task = issueGroup.tasks[taskIndex];
		const taskNumber = taskIndex + 1;
		const exactPattern = `[${issueGroup.issueId}] Task ${taskNumber}:`;

		// Find the matching commit(s) for this task
		const matchingCommits = commits.filter(
			(c) =>
				c.message.includes(exactPattern) ||
				(c.message.includes(`[${issueGroup.issueId}]`) &&
					c.message.toLowerCase().includes(task.title.toLowerCase())),
		);

		// Check if any matching commit has actual diffs
		let hasRealChanges = false;
		for (const commit of matchingCommits) {
			const statsResult = await getCommitDiffStats(worktreeDir, commit.hash);
			if (statsResult.ok) {
				const stats = statsResult.value;
				if (stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0) {
					hasRealChanges = true;
					break;
				}
			}
		}

		if (hasRealChanges) {
			verifiedCompletedIds.push(taskId);
		} else {
			phantomTaskIds.push(taskId);
			logWarn(
				`Task ${taskId} has matching commit(s) but ZERO code changes — marking as failed (phantom completion)`,
			);
		}
	}

	logDebug("  Task completion analysis results:");
	logDebug(
		`    Verified completed: ${verifiedCompletedIds.length} task(s) - [${verifiedCompletedIds.join(", ")}]`,
	);
	logDebug(
		`    Uncommitted: ${matchResult.uncommittedTaskIds.length} task(s) - [${matchResult.uncommittedTaskIds.join(", ")}]`,
	);
	if (phantomTaskIds.length > 0) {
		logDebug(
			`    Phantom (empty commits): ${phantomTaskIds.length} task(s) - [${phantomTaskIds.join(", ")}]`,
		);
	}

	return {
		completedTaskIds: verifiedCompletedIds,
		failedTaskIds: [...matchResult.uncommittedTaskIds, ...phantomTaskIds],
	};
}
