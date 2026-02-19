/**
 * VCS Backends
 *
 * Low-level Git command execution and output parsing.
 *
 * @module vcs/backends
 */

export {
	runGitCommand,
	parseStatusPorcelain,
	parseWorktreeListPorcelain,
	parseBranchListPorcelain,
	parseDiffNameOnly,
	GitCliError,
	gitCliBackend,
} from "./git-cli.ts";

export type {
	VcsBackend,
	StatusEntry,
	WorktreeEntry,
	BranchEntry,
} from "./types.ts";

export {
	DEFAULT_GIT_TIMEOUT,
	DEFAULT_GIT_ENV,
} from "./types.ts";
