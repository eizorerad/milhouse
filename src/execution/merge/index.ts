/**
 * Execution Merge Module
 *
 * Shared rebase-then-merge orchestration for the exec phase.
 * Extracts the sequential merge strategy from issue-executor.
 *
 * @module execution/merge
 * @since 0.2.0
 */

export {
	// Types
	type IssueInfo,
	type BranchMergeResult,
	type RebaseMergeOptions,
	// Main function
	mergeCompletedBranches,
} from "./rebase-merge.ts";
