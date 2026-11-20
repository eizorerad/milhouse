/** Git helpers. Every function takes the directory to run in first. Nothing here touches the user's files. */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunResult, run } from "./proc.ts";
import { MINUTE, tail } from "./util.ts";

/** A hook or a lock that never finishes must not hang milhouse forever. */
const GIT_TIMEOUT_MS = 10 * MINUTE;

/**
 * Variables that point git at a repository other than the working directory. A caller such as a git
 * hook sets them; they must never reach the worktrees, the agents or the checks.
 */
const ROUTING_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
];

/** The environment of a process that works in a repository of its own. */
export function withoutGitRouting(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of ROUTING_VARS) delete clean[name];
	return clean;
}

/** Set when git has no author for commits (a fresh container): a neutral one is used instead of failing. */
let fallbackIdentity: NodeJS.ProcessEnv = {};

/** Environment for commits made by milhouse and its agents. */
export const identityEnv = (): NodeJS.ProcessEnv => fallbackIdentity;

export async function detectIdentity(cwd: string): Promise<void> {
	const known =
		(await git(cwd, "var", "GIT_AUTHOR_IDENT")).ok &&
		(await git(cwd, "var", "GIT_COMMITTER_IDENT")).ok;
	const who = { NAME: "milhouse", EMAIL: "milhouse@localhost" };
	fallbackIdentity = known
		? {}
		: {
				GIT_AUTHOR_NAME: who.NAME,
				GIT_AUTHOR_EMAIL: who.EMAIL,
				GIT_COMMITTER_NAME: who.NAME,
				GIT_COMMITTER_EMAIL: who.EMAIL,
			};
}

const gitEnv = (): NodeJS.ProcessEnv => ({
	...withoutGitRouting(process.env),
	...fallbackIdentity,
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: "C",
});

export interface GitResult {
	ok: boolean;
	out: string;
	err: string;
}

export async function git(cwd: string, ...args: string[]): Promise<GitResult> {
	const result = await run("git", args, { cwd, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS });
	return { ok: result.code === 0, out: result.stdout.trimEnd(), err: result.stderr.trim() };
}

/** The finished process (stdout raw: trailing whitespace on the last line intact). Throws when git fails. */
async function gitRun(cwd: string, ...args: string[]): Promise<RunResult> {
	const result = await run("git", args, { cwd, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${tail(result.stderr || result.stdout, 500)}`);
	}
	return result;
}

/** Stdout without its last newline. Never a part of it: a cut-off log or path list could hide a task or a protected file. */
export async function gitOrThrow(cwd: string, ...args: string[]): Promise<string> {
	const result = await gitRun(cwd, ...args);
	if (result.truncated) {
		throw new Error(`git ${args[0]} printed too much (over 32 MB) to be read in full.`);
	}
	return result.stdout.trimEnd();
}

// ─── Repository state ────────────────────────────────────────────────

/** Top-level directory of the repository containing `cwd` (or `cwd` itself outside a repository). */
export async function repoRoot(cwd: string): Promise<string> {
	const top = await git(cwd, "rev-parse", "--show-toplevel");
	return top.ok ? top.out : cwd;
}

export const isRepo = async (cwd: string): Promise<boolean> =>
	(await git(cwd, "rev-parse", "--is-inside-work-tree")).ok;

export const hasCommits = (cwd: string): Promise<boolean> => refExists(cwd, "HEAD");

/** Name of the checked-out branch, or "" on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string> {
	return (await git(cwd, "symbolic-ref", "--short", "-q", "HEAD")).out;
}

export const revParse = (cwd: string, ref: string): Promise<string> =>
	gitOrThrow(cwd, "rev-parse", "--verify", ref);

/** The commit a ref points at, or null when there is no such ref. */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
	const found = await git(cwd, "rev-parse", "--verify", "-q", ref);
	return found.ok ? found.out : null;
}

export const refExists = async (cwd: string, ref: string): Promise<boolean> =>
	(await resolveRef(cwd, ref)) !== null;

/** A local branch: a tag of the same name does not count. */
export const branchExists = (cwd: string, branch: string): Promise<boolean> =>
	refExists(cwd, `refs/heads/${branch}`);

export async function isAncestor(
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	return (await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant)).ok;
}

/**
 * Uncommitted changes to tracked files, outside .milhouse/ (milhouse's own state never counts).
 * Untracked files count only with `untracked`: at the start of a run they matter (exec works from the
 * last commit and would not see them), but one that an editor creates during the run must not stop its
 * merge, and git itself refuses to overwrite an untracked file.
 */
export async function isDirty(cwd: string, opts: { untracked?: boolean } = {}): Promise<boolean> {
	const status = await gitOrThrow(
		cwd,
		"status",
		"--porcelain",
		`--untracked-files=${opts.untracked ? "all" : "no"}`,
		"--",
		".",
		":(exclude).milhouse",
	);
	return status.length > 0;
}

// ─── History between two commits ─────────────────────────────────────

/** Commit subjects in `from..to`, newest first. */
export async function commitSubjects(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
	return (await gitOrThrow(cwd, "log", "--format=%s", `${from}..${to}`))
		.split("\n")
		.filter(Boolean);
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
	const result = await gitRun(
		cwd,
		"-c",
		"core.quotePath=false", // the names of non-ASCII files as they are
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
	if (result.truncated) {
		throw new Error(
			"The change is too large to check (more than 32 MB of added lines). Keep generated, vendored and binary files out of the commits.",
		);
	}
	const added: AddedLine[] = [];
	const rows = result.stdout.split("\n");
	let file = "";
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.startsWith("+++ ")) {
			file = row.slice(4).replace(/\t.*$/, "").replace(/^b\//, ""); // git ends a name with a space in it with a tab
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
	// --text prints a binary file too, as lines with NUL bytes in them: they are not text to check.
	const binary = new Set(added.filter(({ text }) => text.includes("\0")).map(({ file }) => file));
	return added.filter(({ file }) => !binary.has(file));
}

// The reviewer only ever reads the start of these, so a huge diff is cut off instead of refused.
export async function diffStat(cwd: string, from: string, to = "HEAD"): Promise<string> {
	return (await gitRun(cwd, "diff", "--stat", "--no-color", from, to, "--")).stdout.trimEnd();
}

export async function diffPatch(cwd: string, from: string, to = "HEAD"): Promise<string> {
	return (
		await gitRun(cwd, "diff", "--text", "--no-color", "--no-ext-diff", from, to, "--")
	).stdout.trimEnd();
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
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // it holds a copy of the project: the owner only
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
 * Throws when the attempt could not be kept: the caller must not discard the worktree then.
 */
export async function parkWorktree(
	repo: string,
	path: string,
	parkBranch: string,
	accepted?: string,
): Promise<void> {
	const cannotKeep = (why: string) => new Error(`The failed attempt could not be kept: ${why}`);
	// All of it: a user's status.showUntrackedFiles=no would hide new files, and the attempt would be dropped.
	const status = await git(path, "status", "--porcelain", "--untracked-files=all");
	if (!status.ok) throw cannotKeep(status.err);
	if (status.out) {
		const added = await git(path, "add", "-A");
		if (!added.ok) throw cannotKeep(added.err);
		const committed = await git(
			path,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			"wip: failed attempt",
		);
		if (!committed.ok) throw cannotKeep(committed.err);
	}
	const head = await git(path, "rev-parse", "HEAD");
	if (!head.ok) throw cannotKeep(head.err);
	// An attempt that produced nothing (the agent could not even run) must not replace an earlier one.
	if (!status.out && head.out === accepted) return;
	const parked = await git(repo, "branch", "-f", parkBranch, head.out);
	if (!parked.ok) throw cannotKeep(parked.err);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
	await git(repo, "branch", "-D", branch);
}

/** A killed git leaves `index.lock` behind, and every later git command in that worktree would fail on it. */
export async function clearIndexLock(cwd: string): Promise<void> {
	const gitDir = await git(cwd, "rev-parse", "--absolute-git-dir");
	if (gitDir.ok) rmSync(join(gitDir.out, "index.lock"), { force: true });
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
	const removed = await git(repo, "worktree", "remove", "--force", path);
	if (!removed.ok) {
		// A lock is somebody's request to keep the directory (for inspection, say): it is not ours to override.
		if (/locked/i.test(removed.err)) {
			throw new Error(
				`The worktree ${path} is locked. Unlock it with: git worktree unlock "${path}"`,
			);
		}
		rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
	}
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
		"--no-verify", // the user's hooks are for their own commits; milhouse checks the result itself
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
 * --no-overwrite-ignore: git would otherwise replace an ignored local file (a .env, say) with a tracked one.
 */
export async function publish(repo: string, sha: string): Promise<{ ok: boolean; error?: string }> {
	const merged = await git(repo, "merge", "--ff-only", "--no-squash", "--no-overwrite-ignore", sha);
	if (!merged.ok) return { ok: false, error: tail(merged.err || merged.out, 500) };
	const reached = (await git(repo, "rev-parse", "HEAD")).out === sha;
	return reached
		? { ok: true }
		: { ok: false, error: "the branch did not move to the merged commit" };
}
