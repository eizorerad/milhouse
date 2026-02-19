/**
 * Task Commit Matcher Utility
 *
 * Matches task IDs to git commits based on commit message patterns.
 * Used to determine which tasks were actually completed during partial execution.
 *
 * @module execution/utils/task-commit-matcher
 */

import type { Task } from "../../state/types.ts";
import { logDebug } from "../../ui/logger.ts";
import { getCommitsSinceBase } from "../../vcs/backends/git-cli.ts";
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

	// Match tasks to commits
	const matchResult = matchTasksToCommits(issueGroup.issueId, issueGroup.tasks, commits);

	logDebug("  Task completion analysis results:");
	logDebug(
		`    Completed: ${matchResult.completedTaskIds.length} task(s) - [${matchResult.completedTaskIds.join(", ")}]`,
	);
	logDebug(
		`    Uncommitted: ${matchResult.uncommittedTaskIds.length} task(s) - [${matchResult.uncommittedTaskIds.join(", ")}]`,
	);

	return {
		completedTaskIds: matchResult.completedTaskIds,
		failedTaskIds: matchResult.uncommittedTaskIds,
	};
}
