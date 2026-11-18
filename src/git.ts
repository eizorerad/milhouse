/** Git helpers. Every function takes the directory to run in first. Nothing here touches the user's files. */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";
import { tail } from "./util.ts";

/** A hook or a lock that never finishes must not hang milhouse forever. */
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

export interface GitResult {
	ok: boolean;
	out: string;
	err: string;
}

export async function git(cwd: string, ...args: string[]): Promise<GitResult> {
	const result = await run("git", args, { cwd, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS });
	return { ok: result.code === 0, out: result.stdout.trimEnd(), err: result.stderr.trim() };
}

/** Raw stdout (trailing whitespace on the last line intact). Throws when git fails. */
async function gitText(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, { cwd, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${tail(result.stderr || result.stdout, 500)}`);
	}
	return result.stdout;
}

export async function gitOrThrow(cwd: string, ...args: string[]): Promise<string> {
	return (await gitText(cwd, ...args)).trimEnd();
}

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

// ─── Repository state ────────────────────────────────────────────────

/** Top-level directory of the repository containing `cwd` (or `cwd` itself outside a repository). */
export async function repoRoot(cwd: string): Promise<string> {
	const top = await git(cwd, "rev-parse", "--show-toplevel");
	return top.ok ? top.out : cwd;
}

export const isRepo = async (cwd: string): Promise<boolean> =>
	(await git(cwd, "rev-parse", "--is-inside-work-tree")).ok;

export const hasCommits = async (cwd: string): Promise<boolean> =>
	(await git(cwd, "rev-parse", "--verify", "-q", "HEAD")).ok;

/** Name of the checked-out branch, or "" on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string> {
	return (await git(cwd, "symbolic-ref", "--short", "-q", "HEAD")).out;
}

export const revParse = (cwd: string, ref: string): Promise<string> =>
	gitOrThrow(cwd, "rev-parse", "--verify", ref);

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	return (await git(cwd, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)).ok;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
	return (await git(cwd, "rev-parse", "--verify", "-q", ref)).ok;
}

export async function isAncestor(
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	return (await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant)).ok;
}

/** Uncommitted changes outside .milhouse/ (milhouse's own state never counts). */
export async function isDirty(cwd: string): Promise<boolean> {
	const status = await git(cwd, "status", "--porcelain", "--", ".", ":(exclude).milhouse");
	return status.out.length > 0;
}

// ─── History between two commits ─────────────────────────────────────

/** Commit subjects in `from..to`, newest first. */
export async function commitSubjects(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
	return lines(await gitOrThrow(cwd, "log", "--format=%s", `${from}..${to}`));
}

/**
 * Every file touched by any commit in `from..to`: a file changed and reverted still counts, a moved
 * file counts under both names (--no-renames), merge commits are included (-m), and -z keeps
 * non-ASCII names unquoted.
 */
export async function touchedFiles(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
	const out = await gitOrThrow(
		cwd,
		"log",
		"-m",
		"--no-renames",
		"--name-only",
		"-z",
		"--format=",
		`${from}..${to}`,
	);
	return [...new Set(out.split("\0").filter(Boolean))];
}

export interface AddedLine {
	file: string;
	text: string;
}

/**
 * Lines added by `from..to`, with the file they belong to. --text: a .gitattributes entry such as
 * `* -diff` must not hide the changes. Hunk headers say how many lines follow, so a content line
 * that looks like a file header (`+++ x`) is never mistaken for one.
 */
export async function addedLines(cwd: string, from: string, to = "HEAD"): Promise<AddedLine[]> {
	// Raw output: trailing whitespace on the very last added line must survive.
	const diff = await gitText(
		cwd,
		"diff",
		"--text",
		"-U0",
		"--inter-hunk-context=0", // a user's diff.interHunkContext must not add context lines
		"--src-prefix=a/",
		"--dst-prefix=b/",
		"--no-color",
		"--no-ext-diff",
		from,
		to,
		"--",
	);
	const added: AddedLine[] = [];
	const rows = diff.split("\n");
	let file = "";
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.startsWith("+++ ")) {
			file = row.slice(4).replace(/^b\//, "");
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(row);
		if (!hunk) continue;
		const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		i += removed; // skip the removed lines
		for (let n = 0; n < count && i + 1 < rows.length; n++) {
			i++;
			if (rows[i].startsWith("\\")) {
				n--; // "\ No newline at end of file" belongs to no line
				continue;
			}
			added.push({ file, text: rows[i].slice(1) });
		}
	}
	return added;
}

export async function diffStat(cwd: string, from: string, to = "HEAD"): Promise<string> {
	return gitOrThrow(cwd, "diff", "--stat", "--no-color", from, to, "--");
}

export async function diffPatch(cwd: string, from: string, to = "HEAD"): Promise<string> {
	return gitOrThrow(cwd, "diff", "--text", "--no-color", "--no-ext-diff", from, to, "--");
}

// ─── The run's worktree and accepted work ────────────────────────────

/**
 * Make sure `path` is a worktree, creating `ref` at `baseSha` first when needed. `ref` lives outside
 * refs/heads on purpose: an agent that switches branches or runs `git branch -f` cannot move it.
 * Returns whether the worktree is new (a fresh checkout has no installed dependencies).
 */
export async function ensureWorktree(
	repo: string,
	path: string,
	ref: string,
	baseSha: string,
): Promise<{ created: boolean }> {
	if (!(await refExists(repo, ref))) await gitOrThrow(repo, "update-ref", ref, baseSha);
	if (existsSync(join(path, ".git"))) return { created: false };

	rmSync(path, { recursive: true, force: true }); // a leftover directory that is not a worktree
	await git(repo, "worktree", "prune");
	await gitOrThrow(repo, "worktree", "add", "--detach", path, ref);
	return { created: true };
}

/** Back to the commit `to` (a ref) with a detached HEAD and no local changes. */
export async function resetWorktree(path: string, to: string): Promise<void> {
	await gitOrThrow(path, "checkout", "-f", "--detach", to);
	await gitOrThrow(path, "clean", "-fd");
}

/** Accept `sha`: it becomes the tip of the run's ref. */
export async function acceptCommit(repo: string, ref: string, sha: string): Promise<void> {
	await gitOrThrow(repo, "update-ref", ref, sha);
}

export async function deleteRef(repo: string, ref: string): Promise<void> {
	await git(repo, "update-ref", "-d", ref);
}

/**
 * Keep a failed attempt for inspection on its own branch. Uncommitted files are committed first;
 * a clean worktree is parked exactly as it is, so the branch can be resumed and accepted as is.
 */
export async function parkWorktree(repo: string, path: string, parkBranch: string): Promise<void> {
	if ((await git(path, "status", "--porcelain")).out) {
		await git(path, "add", "-A");
		await git(
			path,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			"wip: failed attempt",
		);
	}
	const head = await git(path, "rev-parse", "HEAD");
	if (head.ok) await git(repo, "branch", "-f", parkBranch, head.out);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
	await git(repo, "branch", "-D", branch);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
	const removed = await git(repo, "worktree", "remove", "--force", path);
	if (!removed.ok) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
	await git(repo, "worktree", "prune");
}

// ─── Merging the result ──────────────────────────────────────────────

/** Merge `sha` into the commit checked out in `cwd` with a merge commit. A failed merge is aborted. */
export async function mergeInto(
	cwd: string,
	sha: string,
	message: string,
): Promise<{ ok: boolean; error?: string }> {
	// Explicit flags: a user's merge.* / branch.*.mergeOptions must not turn this into something else.
	const merged = await git(
		cwd,
		"-c",
		"commit.gpgsign=false",
		"merge",
		"--no-ff",
		"--no-squash",
		"--commit",
		"-m",
		message,
		sha,
	);
	if (merged.ok) return { ok: true };
	await git(cwd, "merge", "--abort");
	return { ok: false, error: tail(merged.err || merged.out, 500) };
}

/**
 * Move the branch checked out in `repo` forward to `sha` and confirm that it got there. A fast-forward
 * that cannot happen changes nothing, so the user's checkout (staged edits included) is never reset.
 */
export async function publish(repo: string, sha: string): Promise<boolean> {
	await git(repo, "merge", "--ff-only", "--no-squash", sha);
	return (await git(repo, "rev-parse", "HEAD")).out === sha;
}
