import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	acceptCommit,
	addedLines,
	branchExists,
	commitSubjects,
	currentBranch,
	deleteRef,
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

	it("is dirty for tracked and untracked changes, but never because of .milhouse/", async () => {
		const repo = await makeRepo();
		expect(await isDirty(repo)).toBe(false);

		writeFile(repo, ".milhouse/config.ts", "export default {};");
		writeFile(repo, ".milhouse/runs/r1/meta.json", "{}");
		expect(await isDirty(repo)).toBe(false);

		writeFile(repo, "notes.txt", "untracked");
		expect(await isDirty(repo)).toBe(true);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "notes");
		expect(await isDirty(repo)).toBe(false);

		writeFile(repo, "src/app.ts", "changed");
		expect(await isDirty(repo)).toBe(true);
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
		expect(await publish(repo, work)).toBe(true);
		expect(await revParse(repo, "HEAD")).toBe(work);
		expect(readFile(repo, "feature.txt")).toBe("f");
		expect(await git(repo, "log", "--oneline", "--merges")).toBe("");
	});

	it("refuses a commit the branch cannot fast-forward to, and leaves the branch alone", async () => {
		const { repo, work } = await repoWithWork();
		const moved = await commitFile(repo, "other.txt", "o", "someone else committed");
		expect(await publish(repo, work)).toBe(false);
		expect(await revParse(repo, "HEAD")).toBe(moved);
		expect(await isDirty(repo)).toBe(false);
	});

	it("does not let a squash-by-default configuration pretend that the branch moved", async () => {
		const { repo, work } = await repoWithWork();
		await git(repo, "config", "branch.main.mergeOptions", "--squash");
		expect(await publish(repo, work)).toBe(true); // explicit --no-squash wins
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
		expect(await publish(repo, await revParse(side, "HEAD"))).toBe(true);
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
});
