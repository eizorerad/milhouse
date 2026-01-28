/**
 * Git CLI Backend
 *
 * Low-level Git command execution using child_process.spawn.
 * Provides deterministic parsing of porcelain output formats.
 *
 * @module vcs/backends/git-cli
 */

import { spawn } from "node:child_process";
import type { GitCommandError, GitCommandOptions, GitCommandResult, VcsResult } from "../types.ts";
import { createVcsError, err, ok } from "../types.ts";
import {
	type BranchEntry,
	type CommitEntry,
	DEFAULT_GIT_ENV,
	DEFAULT_GIT_TIMEOUT,
	type DiffStats,
	type StatusEntry,
	type VcsBackend,
	type WorktreeEntry,
} from "./types.ts";

/**
 * Custom error class for Git command failures
 */
export class GitCliError extends Error implements GitCommandError {
	code: "COMMAND_FAILED" | "COMMAND_TIMEOUT";
	command: string;
	args: string[];
	exitCode?: number;
	stderr?: string;
	cause?: Error;
	context?: Record<string, unknown>;

	constructor(
		code: "COMMAND_FAILED" | "COMMAND_TIMEOUT",
		message: string,
		options: {
			command: string;
			args: string[];
			exitCode?: number;
			stderr?: string;
			cause?: Error;
			context?: Record<string, unknown>;
		},
	) {
		super(message);
		this.name = "GitCliError";
		this.code = code;
		this.command = options.command;
		this.args = options.args;
		this.exitCode = options.exitCode;
		this.stderr = options.stderr;
		this.cause = options.cause;
		this.context = options.context;
	}
}

/**
 * Execute a git command using child_process.spawn
 *
 * @param args - Command arguments (without 'git' prefix)
 * @param workDir - Working directory for the command
 * @param options - Execution options
 * @returns Command result with stdout, stderr, exit code
 */
export async function runGitCommand(
	args: string[],
	workDir?: string,
	options?: GitCommandOptions,
): Promise<VcsResult<GitCommandResult>> {
	const cwd = options?.cwd ?? workDir ?? process.cwd();
	const timeout = options?.timeout ?? DEFAULT_GIT_TIMEOUT;
	const env = {
		...process.env,
		...DEFAULT_GIT_ENV,
		...options?.env,
	};

	const startTime = Date.now();

	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		// Set up timeout
		const timeoutId = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			// Force kill after 5 seconds if SIGTERM doesn't work
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 5000);
		}, timeout);

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (error: Error) => {
			clearTimeout(timeoutId);
			const duration = Date.now() - startTime;

			resolve(
				err(
					new GitCliError("COMMAND_FAILED", `Failed to execute git command: ${error.message}`, {
						command: "git",
						args,
						cause: error,
						context: { cwd, duration },
					}),
				),
			);
		});

		child.on("close", (exitCode: number | null) => {
			clearTimeout(timeoutId);
			const duration = Date.now() - startTime;

			if (timedOut) {
				resolve(
					err(
						new GitCliError("COMMAND_TIMEOUT", `Git command timed out after ${timeout}ms`, {
							command: "git",
							args,
							stderr,
							context: { cwd, duration, timeout },
						}),
					),
				);
				return;
			}

			resolve(
				ok({
					exitCode: exitCode ?? 1,
					stdout,
					stderr,
					timedOut: false,
					duration,
				}),
			);
		});
	});
}

/**
 * Parse git status --porcelain output
 *
 * Format: XY PATH
 * Where X is index status, Y is worktree status
 * For renames: XY ORIG_PATH -> NEW_PATH
 *
 * @param output - Raw porcelain output
 * @returns Parsed status entries
 */
export function parseStatusPorcelain(output: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	const lines = output.split("\n").filter((line) => line.length > 0);

	for (const line of lines) {
		if (line.length < 3) continue;

		const index = line[0];
		const worktree = line[1];
		const pathPart = line.slice(3);

		// Check for rename (contains " -> ")
		const renameMatch = pathPart.match(/^(.+) -> (.+)$/);
		if (renameMatch) {
			entries.push({
				index,
				worktree,
				path: renameMatch[2],
				origPath: renameMatch[1],
			});
		} else {
			entries.push({
				index,
				worktree,
				path: pathPart,
			});
		}
	}

	return entries;
}

/**
 * Parse git worktree list --porcelain output
 *
 * Format:
 * worktree /path/to/worktree
 * HEAD abc123...
 * branch refs/heads/branch-name
 * (blank line)
 *
 * @param output - Raw porcelain output
 * @returns Parsed worktree entries
 */
export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = output.split("\n\n").filter((block) => block.trim().length > 0);

	for (const block of blocks) {
		const lines = block.split("\n");
		const entry: Partial<WorktreeEntry> = {
			detached: false,
			bare: false,
		};

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				entry.worktree = line.slice(9);
			} else if (line.startsWith("HEAD ")) {
				entry.head = line.slice(5);
			} else if (line.startsWith("branch ")) {
				// Remove refs/heads/ prefix
				const branch = line.slice(7);
				entry.branch = branch.replace(/^refs\/heads\//, "");
			} else if (line === "detached") {
				entry.detached = true;
			} else if (line === "bare") {
				entry.bare = true;
			}
		}

		if (entry.worktree && entry.head) {
			entries.push(entry as WorktreeEntry);
		}
	}

	return entries;
}

/**
 * Parse git branch --list output
 *
 * Format:
 * * current-branch
 *   other-branch
 *   another-branch
 *
 * With -v flag:
 * * current-branch abc1234 Commit message
 *   other-branch   def5678 Another commit
 *
 * @param output - Raw branch list output
 * @returns Parsed branch entries
 */
export function parseBranchListPorcelain(output: string): BranchEntry[] {
	const entries: BranchEntry[] = [];
	const lines = output.split("\n").filter((line) => line.length > 0);

	for (const line of lines) {
		const current = line.startsWith("*");
		// Remove leading "* " or "  "
		const content = line.slice(2).trim();

		// Try to parse with commit hash (from -v output)
		// Use case-insensitive hex matching [a-fA-F0-9]+ to handle uppercase hex in commit hashes
		const verboseMatch = content.match(/^(\S+)\s+([a-fA-F0-9]+)\s/);
		if (verboseMatch) {
			entries.push({
				name: verboseMatch[1],
				current,
				commit: verboseMatch[2],
			});
		} else {
			// Simple format without commit
			const name = content.split(/\s/)[0];
			if (name) {
				entries.push({
					name,
					current,
				});
			}
		}
	}

	return entries;
}

/**
 * Parse git diff --name-only output
 *
 * @param output - Raw diff output
 * @returns Array of file paths
 */
export function parseDiffNameOnly(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Parse git log --oneline output
 *
 * Format: <hash> <message>
 * Example: abc1234 Fix bug in parser
 *
 * @param output - Raw git log --oneline output
 * @returns Parsed commit entries
 */
export function parseGitLogOneline(output: string): CommitEntry[] {
	const entries: CommitEntry[] = [];
	const lines = output.split("\n").filter((line) => line.length > 0);

	for (const line of lines) {
		// Match hash (7+ hex chars, case-insensitive) followed by single space and message
		// Use a single space literal instead of \s+ to preserve any leading spaces in the message
		// and to match git's exact output format (hash + single space + message)
		const match = line.match(/^([a-fA-F0-9]+) (.*)$/);
		if (match) {
			entries.push({
				hash: match[1].toLowerCase(),
				message: match[2],
			});
		}
	}

	return entries;
}

/**
 * Get commits since a base branch/commit.
 *
 * Retrieves all commits in the current branch that are not in the base branch.
 * Uses `git log --oneline baseBranch..HEAD` to find divergent commits.
 *
 * @param worktreeDir - The worktree directory to run the command in
 * @param baseBranch - The base branch/commit to compare against
 * @returns VcsResult containing array of commit entries
 */
export async function getCommitsSinceBase(
	worktreeDir: string,
	baseBranch: string,
): Promise<VcsResult<CommitEntry[]>> {
	const result = await runGitCommand(["log", "--oneline", `${baseBranch}..HEAD`], worktreeDir);

	if (!result.ok) {
		return result;
	}

	// Non-zero exit code but successful execution (e.g., no commits found)
	if (result.value.exitCode !== 0) {
		return err(
			createVcsError(
				"GIT_LOG_FAILED",
				`git log failed with exit code ${result.value.exitCode}: ${result.value.stderr}`,
			),
		);
	}

	const commits = parseGitLogOneline(result.value.stdout);
	return ok(commits);
}

/**
 * Parse git diff --numstat output
 *
 * Format: ADDED\tREMOVED\tFILE
 * For binary files: -\t-\tFILE
 * For renames: ADDED\tREMOVED\tprefix{old => new}suffix or old => new
 *
 * @param output - Raw numstat output
 * @returns Parsed diff stats entries
 */
export function parseDiffNumstat(output: string): DiffStats[] {
	const stats: DiffStats[] = [];
	const lines = output.trim().split("\n").filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;

		const [addedStr, removedStr, filePath] = parts;
		const isBinary = addedStr === "-" && removedStr === "-";

		// Handle renames (format: {old => new} or old => new)
		let file = filePath;
		let originalPath: string | undefined;
		let isRenamed = false;

		const renameMatch = filePath.match(/^(.+?)\{(.+?) => (.+?)\}(.*)$|^(.+?) => (.+?)$/);
		if (renameMatch) {
			isRenamed = true;
			if (renameMatch[1] !== undefined) {
				// Format: prefix{old => new}suffix
				originalPath = `${renameMatch[1]}${renameMatch[2]}${renameMatch[4]}`;
				file = `${renameMatch[1]}${renameMatch[3]}${renameMatch[4]}`;
			} else {
				// Format: old => new
				originalPath = renameMatch[5];
				file = renameMatch[6];
			}
		}

		stats.push({
			file,
			linesAdded: isBinary ? 0 : Number.parseInt(addedStr, 10),
			linesRemoved: isBinary ? 0 : Number.parseInt(removedStr, 10),
			isNew: false, // Will be determined by status if needed
			isDeleted: false, // Will be determined by status if needed
			isRenamed,
			originalPath,
			isBinary,
		});
	}

	return stats;
}

/**
 * Get diff stats for files
 *
 * Unified function to get diff statistics supporting staged, unstaged, and ref comparisons.
 *
 * @param workDir - Working directory for the command
 * @param options - Optional configuration (cached for staged, ref for comparison)
 * @returns VcsResult containing array of diff stats
 */
export async function getDiffStats(
	workDir: string,
	options?: { cached?: boolean; ref?: string },
): Promise<VcsResult<DiffStats[]>> {
	const args = ["diff", "--numstat"];

	if (options?.cached) {
		args.push("--cached");
	}

	if (options?.ref) {
		args.push(options.ref);
	}

	const result = await runGitCommand(args, workDir);

	if (!result.ok) {
		return result;
	}

	// Non-zero exit code but successful execution
	if (result.value.exitCode !== 0) {
		return err(
			createVcsError(
				"COMMAND_FAILED",
				`git diff --numstat failed with exit code ${result.value.exitCode}: ${result.value.stderr}`,
			),
		);
	}

	const stats = parseDiffNumstat(result.value.stdout);
	return ok(stats);
}

/**
 * Get diff content for files
 *
 * Unified function to get diff content supporting staged, unstaged, ref comparisons, and file-specific diffs.
 *
 * @param workDir - Working directory for the command
 * @param options - Optional configuration (cached for staged, ref for comparison, file for specific file, unified for context lines)
 * @returns VcsResult containing diff content as string
 */
export async function getDiffContent(
	workDir: string,
	options?: { cached?: boolean; ref?: string; file?: string; unified?: number },
): Promise<VcsResult<string>> {
	const args = ["diff"];

	if (options?.cached) {
		args.push("--cached");
	}

	if (options?.ref) {
		args.push(options.ref);
	}

	if (options?.unified !== undefined) {
		args.push(`--unified=${options.unified}`);
	}

	if (options?.file) {
		args.push("--", options.file);
	}

	const result = await runGitCommand(args, workDir);

	if (!result.ok) {
		return result;
	}

	// Non-zero exit code but successful execution
	if (result.value.exitCode !== 0) {
		return err(
			createVcsError(
				"COMMAND_FAILED",
				`git diff failed with exit code ${result.value.exitCode}: ${result.value.stderr}`,
			),
		);
	}

	return ok(result.value.stdout);
}

/**
 * Git CLI Backend implementation
 */
export const gitCliBackend: VcsBackend = {
	async runCommand(
		args: string[],
		options?: GitCommandOptions,
	): Promise<VcsResult<GitCommandResult>> {
		return runGitCommand(args, options?.cwd, options);
	},

	parseStatusPorcelain,
	parseWorktreeListPorcelain,
	parseBranchListPorcelain,
	parseDiffNameOnly,
	parseGitLogOneline,
	parseDiffNumstat,
};

export default gitCliBackend;
