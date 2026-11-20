import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	findPlaceholders,
	findWhitespaceProblems,
	forbiddenFiles,
	runChecks,
	runProjectChecks,
	verifyEvidence,
} from "../src/gates.ts";
import {
	cleanupTempDirs,
	git,
	goneWithin,
	makeRepo,
	readFile,
	tempDir,
	unsetEnv,
	writeFile,
} from "./helpers.ts";

afterEach(cleanupTempDirs);

describe("forbiddenFiles", () => {
	it("matches globs, dotfiles and directories", () => {
		const files = [
			"migrations/001.sql",
			"migrations/sub/002.sql",
			".env",
			".env.local",
			"src/app.ts",
			"env.ts",
		];
		expect(forbiddenFiles(files, ["migrations/**"])).toEqual([
			"migrations/001.sql",
			"migrations/sub/002.sql",
		]);
		expect(forbiddenFiles(files, [".env*"])).toEqual([".env", ".env.local"]);
		expect(forbiddenFiles(files, ["migrations/"])).toEqual([
			"migrations/001.sql",
			"migrations/sub/002.sql",
		]);
		expect(forbiddenFiles(files, ["src/app.ts"])).toEqual(["src/app.ts"]);
	});

	it("matches a pattern without a slash at any depth, like .gitignore", () => {
		const files = ["app/.env", "services/api/.env.production", "web/yarn.lock", "src/env.ts"];
		expect(forbiddenFiles(files, [".env*"])).toEqual(["app/.env", "services/api/.env.production"]);
		expect(forbiddenFiles(files, ["*.lock"])).toEqual(["web/yarn.lock"]);
	});

	it("keeps a pattern with a slash relative to the repository root", () => {
		const files = ["migrations/001.sql", "app/migrations/001.sql", "app/keys/a.pem"];
		expect(forbiddenFiles(files, ["migrations/**"])).toEqual(["migrations/001.sql"]);
		expect(forbiddenFiles(files, ["/migrations/"])).toEqual(["migrations/001.sql"]);
		expect(forbiddenFiles(files, ["app/keys/"])).toEqual(["app/keys/a.pem"]);
	});

	it("treats a name as the file or directory of that name, with everything below it", () => {
		const files = ["secrets/key", "app/secrets/key", "secrets.md", "sub/cache/a", "cache.txt"];
		expect(forbiddenFiles(files, ["secrets"])).toEqual(["secrets/key", "app/secrets/key"]);
		expect(forbiddenFiles(files, ["cache/"])).toEqual(["sub/cache/a"]); // a directory at any depth
		expect(forbiddenFiles(files, ["/cache/"])).toEqual([]); // only at the root
	});

	it("lets a name with a trailing slash match directories only, as .gitignore does", () => {
		const files = ["cache", "sub/cache", "sub/cache/a", "cache/b"];
		expect(forbiddenFiles(files, ["cache/"])).toEqual(["sub/cache/a", "cache/b"]);
		expect(forbiddenFiles(files, ["cache"])).toEqual(files); // a name: file or directory
		expect(forbiddenFiles(files, ["cache//"])).toEqual(["sub/cache/a", "cache/b"]);
	});

	it("roots a file name that starts with a slash", () => {
		const files = ["a.ts", "sub/a.ts"];
		expect(forbiddenFiles(files, ["/a.ts"])).toEqual(["a.ts"]);
		expect(forbiddenFiles(files, ["a.ts"])).toEqual(["a.ts", "sub/a.ts"]);
	});

	it("matches nothing without patterns", () => {
		expect(forbiddenFiles(["a.ts"], [])).toEqual([]);
	});
});

describe("findPlaceholders", () => {
	it("flags TODO/FIXME and stubs in added lines", () => {
		const found = findPlaceholders([
			{ file: "a.ts", text: "// TODO: handle errors" },
			{ file: "b.ts", text: "throw new Error('not implemented')" },
			{ file: "c.py", text: "raise NotImplementedError" },
			{ file: "d.rs", text: "todo!()" },
			{ file: "e.ts", text: "const x = 1; // FIXME" },
		]);
		expect(found.map((f) => f.split(":")[0])).toEqual(["a.ts", "b.ts", "c.py", "d.rs", "e.ts"]);
	});

	it("leaves ordinary code and words alone", () => {
		expect(
			findPlaceholders([
				{ file: "a.ts", text: "const todoList = []; // the todo list of the user" },
				{ file: "b.ts", text: "// XXX-XXX phone format" },
				{ file: "c.ts", text: "return value;" },
			]),
		).toEqual([]);
	});
});

describe("findWhitespaceProblems", () => {
	it("flags trailing whitespace and leftover conflict markers in added lines", () => {
		const found = findWhitespaceProblems([
			{ file: "a.ts", text: "const x = 1;   " },
			{ file: "b.ts", text: "<<<<<<< HEAD" },
			{ file: "c.ts", text: ">>>>>>> feature" },
			{ file: "d.ts", text: "\tindented();\t" },
		]);
		expect(found.map((f) => f.split(":")[0])).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
	});

	it("sees through CRLF line endings: they are not trailing whitespace, but a space before one is", () => {
		expect(
			findWhitespaceProblems([
				{ file: "ok.txt", text: "const x = 1;\r" },
				{ file: "bad.txt", text: "const x = 1; \r" },
				{ file: "marker.txt", text: "<<<<<<< HEAD\r" },
			]).map((f) => f.split(":")[0]),
		).toEqual(["bad.txt", "marker.txt"]);
	});

	it("leaves clean lines and markdown underlines alone", () => {
		expect(
			findWhitespaceProblems([
				{ file: "a.ts", text: "const x = 1;" },
				{ file: "README.md", text: "=======" },
				{ file: "b.ts", text: "" },
				{ file: "c.ts", text: "  // indented comment" },
			]),
		).toEqual([]);
	});
});

describe("runChecks", () => {
	it("passes when every command succeeds, skipping empty ones", async () => {
		expect(await runChecks(tempDir(), { build: "true", lint: "", test: "echo ok" })).toBeNull();
	});

	it("stops at the first failure and reports it with the output", async () => {
		const failure = await runChecks(tempDir(), {
			build: "true",
			lint: "echo lint-broke >&2; exit 3",
			test: "echo never-run > ran.txt",
		});
		expect(failure).toContain("lint failed");
		expect(failure).toContain("exit code 3");
		expect(failure).toContain("lint-broke");
	});

	it("runs in the given directory", async () => {
		const dir = tempDir();
		expect(await runChecks(dir, { test: "test -f marker.txt" })).toContain("test failed");
		writeFileSync(join(dir, "marker.txt"), "x");
		expect(await runChecks(dir, { test: "test -f marker.txt" })).toBeNull();
	});

	it("kills a command that hangs, including what it spawned", async () => {
		const started = Date.now();
		const failure = await runChecks(tempDir(), { test: "sleep 30 & sleep 30" }, { timeoutMs: 300 });
		expect(failure).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

describe("runChecks and what a check leaves behind", () => {
	it("judges a check by its own exit, not by a background process that keeps its pipes open", async () => {
		const dir = tempDir();
		const started = Date.now();
		// The shell exits 0 at once; the background child is stopped, and does not turn the pass into a timeout.
		expect(await runChecks(dir, { test: "sleep 30 & exit 0" }, { timeoutMs: 5_000 })).toBeNull();
		expect(Date.now() - started).toBeLessThan(4_000);
	});

	it("stops background processes a check left running: they could change the next issue's files", async () => {
		const dir = tempDir();
		expect(await runChecks(dir, { test: "sleep 30 & echo $! > watcher.pid" })).toBeNull();
		const pid = Number(readFile(dir, "watcher.pid").trim());
		expect(await goneWithin(pid, 2_000)).toBe(true);
	});

	it("does not pass on the caller's GIT_DIR to the checks", async () => {
		const repo = await makeRepo();
		process.env.GIT_DIR = "/nonexistent/.git";
		try {
			expect(
				await runChecks(repo, { test: 'test "$(git rev-parse --show-toplevel)" = "$PWD"' }),
			).toBeNull();
		} finally {
			unsetEnv("GIT_DIR");
		}
	});
});

describe("runProjectChecks", () => {
	const commands = (over: Partial<Record<"build" | "lint" | "test", string>> = {}) => ({
		setup: "",
		build: "",
		lint: "",
		test: "",
		...over,
	});

	it("passes when the commands pass, and removes what they generated", async () => {
		const repo = await makeRepo();
		expect(
			await runProjectChecks(repo, commands({ test: "echo out > build-output.txt" })),
		).toBeNull();
		expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
	});

	it("reports a failing command, and still removes what it generated", async () => {
		const repo = await makeRepo();
		const failure = await runProjectChecks(repo, commands({ test: "echo x > junk.txt; exit 1" }));
		expect(failure).toContain("test failed");
		expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
	});

	it("rejects checks that rewrite a tracked file: what was tested is not what is committed", async () => {
		const repo = await makeRepo();
		const failure = await runProjectChecks(repo, commands({ lint: "echo fixed >> src/app.ts" }));
		expect(failure).toContain("changed tracked files");
		expect(failure).toContain("src/app.ts");
	});

	it("rejects checks that move HEAD, for example a build that commits", async () => {
		const repo = await makeRepo();
		writeFile(repo, "src/app.ts", "export const app = 2;\n");
		const failure = await runProjectChecks(
			repo,
			commands({ build: "git commit -qam 'generated' && true" }),
		);
		expect(failure).toContain("moved HEAD");
	});
});

describe("verifyEvidence", () => {
	function repoWithFile(): string {
		const repo = tempDir();
		mkdirSync(join(repo, "src"));
		writeFileSync(
			join(repo, "src", "auth.ts"),
			[
				"import x from 'y';",
				"",
				"export function login(user) {",
				"  return user.name;",
				"}",
				"",
			].join("\n"),
		);
		return repo;
	}
	const cite = (over: object) => ({
		file: "src/auth.ts",
		line_start: 3,
		line_end: 4,
		snippet: "export function login(user) {",
		...over,
	});

	it("keeps evidence whose file, lines and snippet hold up", () => {
		const repo = repoWithFile();
		expect(verifyEvidence(repo, [cite({})])).toHaveLength(1);
	});

	it("tolerates whitespace differences, ellipses and models miscounting lines by a few", () => {
		const repo = repoWithFile();
		expect(
			verifyEvidence(repo, [
				cite({ snippet: "export   function login(user)  {\n...\nreturn user.name;" }),
			]),
		).toHaveLength(1);
		expect(
			verifyEvidence(repo, [cite({ line_start: 1, line_end: 1, snippet: "return user.name;" })]),
		).toHaveLength(1);
	});

	it("drops evidence that was made up", () => {
		const repo = repoWithFile();
		const evidence = [
			cite({ file: "src/missing.ts" }),
			cite({ snippet: "function that does not exist()" }),
			cite({ line_start: 99, line_end: 100 }),
			cite({ line_start: 5, line_end: 3 }),
			cite({ snippet: "" }),
		];
		expect(verifyEvidence(repo, evidence)).toEqual([]);
	});

	it("never reads outside the repository, not even through `..` or a symlink", () => {
		const repo = repoWithFile();
		const outside = tempDir();
		writeFileSync(join(outside, "secret.txt"), "top secret value");
		symlinkSync(join(outside, "secret.txt"), join(repo, "link.txt"));
		const secret = { line_start: 1, line_end: 1, snippet: "top secret value" };
		expect(verifyEvidence(repo, [cite({ ...secret, file: join(outside, "secret.txt") })])).toEqual(
			[],
		);
		expect(verifyEvidence(repo, [cite({ ...secret, file: "link.txt" })])).toEqual([]);
		expect(verifyEvidence(repo, [cite({ ...secret, file: "../../../etc/passwd" })])).toEqual([]);
	});
});
