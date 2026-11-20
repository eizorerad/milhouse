import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	acceptCommit,
	addedLines,
	branchExists,
	clearIndexLock,
	commitSubjects,
	currentBranch,
	deleteRef,
	detectIdentity,
	diffPatch,
	ensureWorktree,
	hasCommits,
	isAncestor,
	isDirty,
	isRepo,
	mergeInto,
	parkWorktree,
	publish,
	refExists,
	removeWorktree,
	repoRoot,
	resetWorktree,
	resolveRef,
	revParse,
	touchedFiles,
} from "../src/git.ts";
import {
	cleanupTempDirs,
	commitFile,
	git,
	makeRepo,
	readFile,
	tempDir,
	unsetEnv,
	writeFile,
} from "./helpers.ts";

afterEach(cleanupTempDirs);

const REF = "refs/milhouse/run-1";

describe("repository state", () => {
	it("recognises repositories, commits, branches and refs", async () => {
		const repo = await makeRepo();
		expect(await isRepo(repo)).toBe(true);
		expect(await hasCommits(repo)).toBe(true);
		expect(await currentBranch(repo)).toBe("main");
		expect(await branchExists(repo, "main")).toBe(true);
		expect(await branchExists(repo, "nope")).toBe(false);
		expect(await refExists(repo, "refs/heads/main")).toBe(true);
		expect(await refExists(repo, REF)).toBe(false);
		expect(await isRepo(tempDir())).toBe(false);
	});

	it("resolves a ref to its commit, or to null when there is none", async () => {
		const repo = await makeRepo();
		const head = await revParse(repo, "HEAD");
		expect(await resolveRef(repo, "HEAD")).toBe(head);
		expect(await resolveRef(repo, "refs/heads/main")).toBe(head);
		expect(await resolveRef(repo, REF)).toBeNull();

		const empty = tempDir();
		await git(empty, "init", "-q");
		expect(await resolveRef(empty, "HEAD")).toBeNull(); // no commit yet
	});

	it("reports an empty repository and a detached HEAD", async () => {
		const empty = tempDir();
		await git(empty, "init", "-q");
		expect(await hasCommits(empty)).toBe(false);

		const repo = await makeRepo();
		await git(repo, "checkout", "-q", "--detach");
		expect(await currentBranch(repo)).toBe("");
	});

	it("finds the repository root from a subdirectory, and falls back outside a repository", async () => {
		const repo = await makeRepo();
		expect(await repoRoot(join(repo, "src"))).toBe(repo);
		const plain = tempDir();
		expect(await repoRoot(plain)).toBe(plain);
	});

	it("knows whether a commit is an ancestor of another", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const next = await commitFile(repo, "a.txt", "a", "next");
		expect(await isAncestor(repo, base, next)).toBe(true);
		expect(await isAncestor(repo, next, base)).toBe(false);
	});

	it("is dirty for changes to tracked files; untracked files count only when asked, .milhouse/ never", async () => {
		const repo = await makeRepo();
		expect(await isDirty(repo)).toBe(false);

		writeFile(repo, ".milhouse/config.ts", "export default {};");
		writeFile(repo, ".milhouse/runs/r1/meta.json", "{}");
		// An editor or the OS may create files while a run is under way. Git itself refuses to
		// overwrite an untracked file, so they cannot be lost and must not stop a merge.
		writeFile(repo, "notes.txt", "untracked");
		writeFile(repo, ".DS_Store", "x");
		expect(await isDirty(repo)).toBe(false);
		// At the start of a run they matter: exec works from the last commit and would not see them.
		expect(await isDirty(repo, { untracked: true })).toBe(true);

		writeFile(repo, "src/app.ts", "changed");
		expect(await isDirty(repo)).toBe(true);
		await git(repo, "checkout", "--", "src/app.ts");
		expect(await isDirty(repo)).toBe(false);

		writeFile(repo, "src/app.ts", "staged");
		await git(repo, "add", "src/app.ts");
		expect(await isDirty(repo)).toBe(true);
	});
});

describe("a new worktree", () => {
	it("leaves no ref behind when the folder above it cannot be made", async () => {
		const repo = await makeRepo();
		const root = tempDir();
		writeFile(root, "file", "x"); // a file where a folder should be
		const path = join(root, "file", "inside", "run-x");
		const base = await revParse(repo, "HEAD");
		await expect(ensureWorktree(repo, path, "refs/milhouse/run-x", base)).rejects.toThrow();
		expect(await refExists(repo, "refs/milhouse/run-x")).toBe(false);
	});

	it("gets the folders above it for its owner only: it holds a copy of the project", async () => {
		const repo = await makeRepo();
		const root = tempDir();
		const path = join(root, "one", "two", "run-x");
		await ensureWorktree(repo, path, "refs/milhouse/run-x", await revParse(repo, "HEAD"));
		for (const folder of [join(root, "one"), join(root, "one", "two")]) {
			expect(statSync(folder).mode & 0o777).toBe(0o700);
		}
	});
});

describe("history between two commits", () => {
	it("lists only the subjects after `from` (a bracketed id must not match the whole history)", async () => {
		const repo = await makeRepo();
		await commitFile(repo, "a.txt", "a", "[T-old] earlier run");
		const base = await revParse(repo, "HEAD");
		await commitFile(repo, "b.txt", "b", "[T-new] this run");
		await commitFile(repo, "c.txt", "c", "[T-new2] this run too");
		expect(await commitSubjects(repo, base)).toEqual(["[T-new2] this run too", "[T-new] this run"]);
		expect(await commitSubjects(repo, "HEAD")).toEqual([]);
	});

	it("reports every touched file, including one that was changed and then reverted", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		await commitFile(repo, "secrets.env", "KEY=1", "add secret");
		await git(repo, "rm", "-q", "secrets.env");
		await git(repo, "commit", "-q", "-m", "remove secret");
		await commitFile(repo, "src/x.ts", "x", "add x");
		expect((await touchedFiles(repo, base)).sort()).toEqual(["secrets.env", "src/x.ts"]);
	});

	it("reports a moved file under its old name too, so a rename cannot dodge neverTouch", async () => {
		const repo = await makeRepo();
		await commitFile(repo, "migrations/001.sql", "create table t(id int);\n", "migration");
		const base = await revParse(repo, "HEAD");
		await git(repo, "mv", "migrations/001.sql", "src/schema.sql");
		await git(repo, "commit", "-q", "-m", "move it");
		expect((await touchedFiles(repo, base)).sort()).toEqual([
			"migrations/001.sql",
			"src/schema.sql",
		]);
	});

	it("reports non-ASCII names as they are (not quoted and escaped)", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		await commitFile(repo, "migrations/002_añadir.sql", "x", "add");
		expect(await touchedFiles(repo, base)).toEqual(["migrations/002_añadir.sql"]);
	});

	it("includes changes that came in through a merge commit", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		await git(repo, "checkout", "-q", "-b", "side");
		await commitFile(repo, "secrets.env", "KEY=1", "side work");
		await git(repo, "checkout", "-q", "main");
		await commitFile(repo, "main.txt", "m", "main work");
		await git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
		expect(await touchedFiles(repo, base)).toContain("secrets.env");
	});

	it("attributes added lines to their files", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		writeFile(repo, "src/app.ts", "export const app = 1;\nexport const two = 2;\n// TODO: later\n");
		writeFile(repo, "docs/readme.md", "hello\nworld\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "add");
		const added = await addedLines(repo, base);
		expect(added).toContainEqual({ file: "src/app.ts", text: "// TODO: later" });
		expect(added).toContainEqual({ file: "docs/readme.md", text: "world" });
		expect(added.some((a) => a.text === "export const two = 2;")).toBe(false);
	});

	it("names a file with a space or a non-ASCII letter as it is", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		writeFile(repo, "docs/café.md", "one\n");
		writeFile(repo, "user guide.md", "two\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "add");
		const files = (await addedLines(repo, base)).map((a) => a.file).sort();
		expect(files).toEqual(["docs/café.md", "user guide.md"]);
	});

	it("leaves out binary files: their bytes are not text to check", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		writeFile(repo, "logo.png", "PNG\u0000 \nmore\n");
		writeFile(repo, "src/app.ts", "export const app = 1;\nexport const two = 2;\n// note\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "add");
		const added = await addedLines(repo, base);
		expect(added.some((a) => a.file === "logo.png")).toBe(false);
		expect(added).toContainEqual({ file: "src/app.ts", text: "// note" });
	});

	it("still sees added lines when .gitattributes tries to hide the diff", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		writeFile(repo, ".gitattributes", "* -diff -whitespace\n");
		writeFile(
			repo,
			"src/app.ts",
			"export const app = 1;\nexport const two = 2;\n// TODO: sneaky   \n",
		);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "attributes");
		expect(await addedLines(repo, base)).toContainEqual({
			file: "src/app.ts",
			text: "// TODO: sneaky   ",
		});
		expect(await diffPatch(repo, base)).toContain("+// TODO: sneaky");
	});

	it("is not fooled by content lines that look like diff headers", async () => {
		const repo = await makeRepo();
		await commitFile(repo, "notes.txt", "-- old line\nkeep\n", "notes");
		const base = await revParse(repo, "HEAD");
		writeFile(repo, "notes.txt", "++ new header-like line\nkeep\n// TODO: after a fake header\n");
		writeFile(repo, "other.txt", "x\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "tricky");
		const added = await addedLines(repo, base);
		expect(added).toContainEqual({ file: "notes.txt", text: "++ new header-like line" });
		expect(added).toContainEqual({ file: "notes.txt", text: "// TODO: after a fake header" });
		expect(added).toContainEqual({ file: "other.txt", text: "x" });
	});

	it("handles files without a trailing newline and several hunks", async () => {
		const repo = await makeRepo();
		await commitFile(
			repo,
			"long.txt",
			`${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}`,
			"long",
		);
		const base = await revParse(repo, "HEAD");
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		lines[2] = "changed 2";
		lines[27] = "changed 27 TODO";
		writeFile(repo, "long.txt", lines.join("\n"));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "edit");
		const added = await addedLines(repo, base);
		expect(added.map((a) => a.text)).toEqual(["changed 2", "changed 27 TODO"]);
	});

	it("still finds added lines when the user's git config adds diff context", async () => {
		const repo = await makeRepo();
		await git(repo, "config", "diff.interHunkContext", "3");
		await git(repo, "config", "diff.context", "5");
		await commitFile(
			repo,
			"long.txt",
			Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
			"long",
		);
		const base = await revParse(repo, "HEAD");
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		lines[3] = "changed 3";
		lines[6] = "// TODO changed 6";
		writeFile(repo, "long.txt", lines.join("\n"));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "edit");
		expect((await addedLines(repo, base)).map((a) => a.text)).toEqual([
			"changed 3",
			"// TODO changed 6",
		]);
	});

	it("never answers from a part of the history either: a cut-off log could hide a task or a file", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const message = join(tempDir(), "message.txt"); // too long for a command-line argument
		writeFileSync(message, "x".repeat(33 * 1024 * 1024));
		await git(repo, "commit", "-q", "--allow-empty", "-F", message);
		await expect(commitSubjects(repo, base)).rejects.toThrow(/printed too much/);
	});

	it("fails loudly when the diff is too large to check, instead of checking a part of it", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		writeFile(repo, "bundle.js", `${"x".repeat(33 * 1024 * 1024)}\n`);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "a huge generated file");
		await expect(addedLines(repo, base)).rejects.toThrow(/too large to check/);
		// Reviewing a huge diff is not an error: the reviewer only ever sees the start of it.
		expect((await diffPatch(repo, base)).length).toBeGreaterThan(1_000_000);
	});
});

describe("the run worktree", () => {
	it("creates a detached worktree at the ref and reuses it afterwards", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const path = join(repo, ".milhouse", "work", "r1");

		expect((await ensureWorktree(repo, path, REF, base)).created).toBe(true);
		expect(await revParse(repo, REF)).toBe(base);
		expect(await branchExists(repo, "run-1")).toBe(false); // not a branch: an agent cannot switch to it
		expect(await currentBranch(path)).toBe(""); // detached
		expect(readFile(path, "src/app.ts")).toContain("app = 1");

		expect((await ensureWorktree(repo, path, REF, base)).created).toBe(false);
	});

	it("replaces a leftover directory that is not a worktree", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const path = join(repo, ".milhouse", "work", "r1");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "junk.txt"), "junk");
		expect((await ensureWorktree(repo, path, REF, base)).created).toBe(true);
		expect(existsSync(join(path, "junk.txt"))).toBe(false);
		expect(existsSync(join(path, "src", "app.ts"))).toBe(true);
	});

	it("accepts a commit by moving the ref, and resets back to it", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, base);

		const work = await commitFile(path, "one.txt", "1", "[T1] one");
		expect(await revParse(repo, REF)).toBe(base); // not accepted yet
		await acceptCommit(repo, REF, work);
		expect(await revParse(repo, REF)).toBe(work);

		await commitFile(path, "two.txt", "2", "[T2] two");
		writeFile(path, "dirty.txt", "junk");
		await resetWorktree(path, REF);
		expect(await revParse(path, "HEAD")).toBe(work);
		expect(existsSync(join(path, "two.txt"))).toBe(false);
		expect(existsSync(join(path, "dirty.txt"))).toBe(false);
	});

	it("keeps the ref where it is when an agent switches or moves branches in the worktree", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, base);
		await git(path, "checkout", "-q", "-b", "agent-branch");
		await commitFile(path, "x.txt", "x", "[T1] x");
		await git(path, "branch", "-f", "main", "HEAD").catch(() => undefined); // main is checked out elsewhere
		expect(await revParse(repo, REF)).toBe(base);
	});

	it("parks a failed attempt (commits and uncommitted files) on its own branch", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		await commitFile(path, "attempt.txt", "a", "[T1] attempt");
		writeFile(path, "unsaved.txt", "unsaved");
		await parkWorktree(repo, path, "mh-failed/P1");
		expect(await git(repo, "show", "mh-failed/P1:unsaved.txt")).toBe("unsaved");
		expect(await git(repo, "show", "mh-failed/P1:attempt.txt")).toBe("a");
	});

	it("parks new files even when git is configured not to show untracked files", async () => {
		const repo = await makeRepo();
		await git(repo, "config", "status.showUntrackedFiles", "no");
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		writeFile(path, "only-new.txt", "the only copy");
		await parkWorktree(repo, path, "mh-failed/P1");
		expect(await git(repo, "show", "mh-failed/P1:only-new.txt")).toBe("the only copy");
	});

	it("does not overwrite an earlier parked attempt with an attempt that produced nothing", async () => {
		const repo = await makeRepo();
		const base = await revParse(repo, "HEAD");
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, base);
		const attempt = await commitFile(path, "attempt.txt", "a", "[T1] the first attempt");
		await parkWorktree(repo, path, "mh-failed/P1", base);
		expect(await revParse(repo, "mh-failed/P1")).toBe(attempt);

		await resetWorktree(path, REF); // the next attempt starts from the accepted state ...
		await parkWorktree(repo, path, "mh-failed/P1", base); // ... and gets nowhere (the agent could not run)
		expect(await revParse(repo, "mh-failed/P1")).toBe(attempt); // the first one is still there
	});

	it("parks a clean worktree as it is, without adding a wip commit", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		const work = await commitFile(path, "attempt.txt", "a", "[T1] attempt");
		await parkWorktree(repo, path, "mh-failed/P1");
		expect(await revParse(repo, "mh-failed/P1")).toBe(work);
	});

	it("removes the worktree and the ref", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		await removeWorktree(repo, path);
		await deleteRef(repo, REF);
		expect(existsSync(path)).toBe(false);
		expect(await git(repo, "worktree", "list")).not.toContain("r1");
		expect(await refExists(repo, REF)).toBe(false);
	});

	it("says so when a failed attempt cannot be kept, instead of silently dropping it", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		writeFile(path, "unsaved.txt", "unsaved");
		await expect(parkWorktree(repo, path, "bad..name")).rejects.toThrow(/could not be kept/);
		expect(readFile(path, "unsaved.txt")).toBe("unsaved"); // nothing was reset
	});

	it("clears the index.lock that a killed git leaves behind, which would fail every later command", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
		writeFileSync(join(gitDir, "index.lock"), "");
		writeFile(path, "new.txt", "x");
		await expect(git(path, "add", "-A")).rejects.toThrow(/index\.lock/);

		await clearIndexLock(path);
		await git(path, "add", "-A"); // works again
		await clearIndexLock(path); // and clearing nothing is fine
	});

	it("refuses to delete a worktree that git has locked", async () => {
		const repo = await makeRepo();
		const path = join(repo, ".milhouse", "work", "r1");
		await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
		await git(repo, "worktree", "lock", path);
		await expect(removeWorktree(repo, path)).rejects.toThrow(/locked/);
		expect(existsSync(path)).toBe(true);
		await git(repo, "worktree", "unlock", path);
		await removeWorktree(repo, path);
		expect(existsSync(path)).toBe(false);
	});
});

describe("mergeInto and publish", () => {
	async function repoWithWork(): Promise<{ repo: string; work: string }> {
		const repo = await makeRepo();
		await git(repo, "checkout", "-q", "-b", "feature");
		const work = await commitFile(repo, "feature.txt", "f", "feature work");
		await git(repo, "checkout", "-q", "main");
		return { repo, work };
	}

	it("fast-forwards the branch to a commit that descends from it", async () => {
		const { repo, work } = await repoWithWork();
		expect(await publish(repo, work)).toEqual({ ok: true });
		expect(await revParse(repo, "HEAD")).toBe(work);
		expect(readFile(repo, "feature.txt")).toBe("f");
		expect(await git(repo, "log", "--oneline", "--merges")).toBe("");
	});

	it("refuses a commit the branch cannot fast-forward to, and leaves the branch alone", async () => {
		const { repo, work } = await repoWithWork();
		const moved = await commitFile(repo, "other.txt", "o", "someone else committed");
		const refused = await publish(repo, work);
		expect(refused.ok).toBe(false);
		expect(refused.error).toBeTruthy(); // git's own reason, not a guess
		expect(await revParse(repo, "HEAD")).toBe(moved);
		expect(await isDirty(repo)).toBe(false);
	});

	it("does not let a squash-by-default configuration pretend that the branch moved", async () => {
		const { repo, work } = await repoWithWork();
		await git(repo, "config", "branch.main.mergeOptions", "--squash");
		expect((await publish(repo, work)).ok).toBe(true); // explicit --no-squash wins
		expect(await revParse(repo, "HEAD")).toBe(work);
	});

	it("builds a merge commit in a checkout of its own, without touching the branch", async () => {
		const { repo, work } = await repoWithWork();
		await commitFile(repo, "other.txt", "o", "someone else committed");
		const head = await revParse(repo, "HEAD");
		const side = join(repo, ".milhouse", "work", "side");
		await ensureWorktree(repo, side, REF, head);
		const merged = await mergeInto(side, work, "merge feature");
		expect(merged).toEqual({ ok: true });
		expect(await git(side, "log", "-1", "--format=%s")).toBe("merge feature");
		expect(await revParse(repo, "HEAD")).toBe(head); // the branch has not moved yet
		expect((await publish(repo, await revParse(side, "HEAD"))).ok).toBe(true);
		expect(readFile(repo, "other.txt")).toBe("o");
		expect(readFile(repo, "feature.txt")).toBe("f");
	});

	it("aborts a conflicting merge and leaves a clean checkout", async () => {
		const repo = await makeRepo();
		await git(repo, "checkout", "-q", "-b", "feature");
		const work = await commitFile(repo, "src/app.ts", "feature version\n", "feature edit");
		await git(repo, "checkout", "-q", "main");
		await commitFile(repo, "src/app.ts", "main version\n", "main edit");
		const side = join(repo, ".milhouse", "work", "side");
		await ensureWorktree(repo, side, REF, await revParse(repo, "HEAD"));

		const result = await mergeInto(side, work, "merge");
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(await git(side, "status", "--porcelain")).toBe("");
		expect(readFile(side, "src/app.ts")).toBe("main version\n");
	});

	it("never overwrites an ignored local file that the published work starts to track", async () => {
		const repo = await makeRepo();
		await commitFile(repo, ".gitignore", "local.env\n", "ignore local.env");
		await git(repo, "checkout", "-q", "-b", "feature");
		writeFile(repo, "local.env", "from the agent\n");
		await git(repo, "add", "-f", "local.env");
		await git(repo, "commit", "-q", "-m", "track local.env");
		const work = await revParse(repo, "HEAD");
		await git(repo, "checkout", "-q", "main");
		writeFile(repo, "local.env", "my local settings\n"); // ignored on main: git would overwrite it silently

		const result = await publish(repo, work);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("local.env");
		expect(readFile(repo, "local.env")).toBe("my local settings\n");
		expect(await revParse(repo, "HEAD")).not.toBe(work);
	});

	it("is not stopped by the user's merge and commit hooks: milhouse runs its own checks", async () => {
		const { repo, work } = await repoWithWork();
		await commitFile(repo, "other.txt", "o", "someone else committed");
		for (const hook of ["pre-merge-commit", "commit-msg"]) {
			const path = join(repo, ".git", "hooks", hook);
			writeFileSync(path, "#!/bin/sh\necho rejected by a hook >&2\nexit 1\n", { mode: 0o755 });
		}
		const side = join(repo, ".milhouse", "work", "side");
		await ensureWorktree(repo, side, REF, await revParse(repo, "HEAD"));
		expect(await mergeInto(side, work, "merge feature")).toEqual({ ok: true });
	});
});

describe("git environment", () => {
	it("ignores GIT_DIR and friends inherited from a caller such as a git hook", async () => {
		const repo = await makeRepo();
		const other = await makeRepo();
		await git(other, "checkout", "-q", "-b", "the-callers-branch");
		process.env.GIT_DIR = join(other, ".git");
		process.env.GIT_WORK_TREE = other;
		try {
			expect(await repoRoot(repo)).toBe(repo);
			expect(await currentBranch(repo)).toBe("main"); // not the caller's branch
		} finally {
			unsetEnv("GIT_DIR", "GIT_WORK_TREE");
		}
	});

	it("gives commits a neutral identity when git has none, instead of failing them", async () => {
		const repo = tempDir();
		const home = tempDir();
		const saved = { ...process.env };
		Object.assign(process.env, {
			HOME: home,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Seed",
			GIT_AUTHOR_EMAIL: "seed@example.com",
			GIT_COMMITTER_NAME: "Seed",
			GIT_COMMITTER_EMAIL: "seed@example.com",
		});
		try {
			await git(repo, "init", "-q", "-b", "main");
			await git(repo, "commit", "-q", "--allow-empty", "-m", "seed");
			for (const key of [
				"GIT_AUTHOR_NAME",
				"GIT_AUTHOR_EMAIL",
				"GIT_COMMITTER_NAME",
				"GIT_COMMITTER_EMAIL",
			]) {
				delete process.env[key];
			}
			await git(repo, "config", "user.useConfigOnly", "true"); // git must not guess a name

			await detectIdentity(repo);
			const path = join(repo, ".milhouse", "work", "r1");
			await ensureWorktree(repo, path, REF, await revParse(repo, "HEAD"));
			writeFile(path, "unsaved.txt", "unsaved");
			await parkWorktree(repo, path, "mh-failed/P1"); // commits as a side effect
			expect(await git(repo, "show", "mh-failed/P1:unsaved.txt")).toBe("unsaved");
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
			await detectIdentity(repo); // back to the real environment for the other tests
		}
	});
});
