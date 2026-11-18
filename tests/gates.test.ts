import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	findPlaceholders,
	findWhitespaceProblems,
	forbiddenFiles,
	runChecks,
	verifyEvidence,
} from "../src/gates.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

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
		expect(
			await runChecks(
				[
					["build", "true"],
					["lint", ""],
					["test", "echo ok"],
				],
				tempDir(),
			),
		).toBeNull();
	});

	it("stops at the first failure and reports it with the output", async () => {
		const failure = await runChecks(
			[
				["build", "true"],
				["lint", "echo lint-broke >&2; exit 3"],
				["test", "echo never-run > ran.txt"],
			],
			tempDir(),
		);
		expect(failure).toContain("lint failed");
		expect(failure).toContain("exit code 3");
		expect(failure).toContain("lint-broke");
	});

	it("runs in the given directory", async () => {
		const dir = tempDir();
		expect(await runChecks([["test", "test -f marker.txt"]], dir)).toContain("test failed");
		writeFileSync(join(dir, "marker.txt"), "x");
		expect(await runChecks([["test", "test -f marker.txt"]], dir)).toBeNull();
	});

	it("kills a command that hangs, including what it spawned", async () => {
		const started = Date.now();
		const failure = await runChecks([["test", "sleep 30 & sleep 30"]], tempDir(), 300);
		expect(failure).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(5000);
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
