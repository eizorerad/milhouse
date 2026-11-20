import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_TEMPLATE, configTemplate } from "../src/config.ts";
import { detectCommands } from "../src/detect.ts";
import { cleanupTempDirs, tempDir, writeFile } from "./helpers.ts";

afterEach(cleanupTempDirs);

/** A project directory holding `files` (path to content). */
function project(files: Record<string, string>): string {
	const dir = tempDir();
	for (const [file, content] of Object.entries(files)) writeFile(dir, file, content);
	return dir;
}

const scripts = (body: Record<string, string>) => JSON.stringify({ scripts: body });

/** A test that unittest finds: only a TestCase is. */
const CASE =
	"import unittest\n\nclass A(unittest.TestCase):\n    def test_a(self):\n        pass\n";

describe("detectCommands", () => {
	it("finds nothing in an empty project", () => {
		expect(detectCommands(tempDir())).toEqual({});
	});

	it("takes the scripts of package.json and the install that matches the lock file", () => {
		const dir = project({
			"package.json": scripts({ test: "node --test", lint: "eslint .", build: "tsc -p ." }),
			"package-lock.json": "{}",
		});
		expect(detectCommands(dir)).toEqual({
			setup: "npm ci",
			build: "npm run build",
			lint: "npm run lint",
			test: "npm run test",
		});
		const bun = project({ "package.json": scripts({ test: "bun test" }), "bun.lock": "" });
		expect(detectCommands(bun)).toEqual({
			setup: "bun install --frozen-lockfile",
			test: "bun run test",
		});
	});

	it("prefers a typecheck script to a build for the build check", () => {
		const dir = project({ "package.json": scripts({ build: "bun build x", typecheck: "tsc" }) });
		expect(detectCommands(dir).build).toBe("npm run typecheck");
	});

	it("ignores npm's placeholder test script, and a package.json that has no usable script", () => {
		const placeholder = scripts({ test: 'echo "Error: no test specified" && exit 1' });
		expect(detectCommands(project({ "package.json": placeholder }))).toEqual({});
		expect(detectCommands(project({ "package.json": "{ not json" }))).toEqual({});
	});

	it("knows Cargo, Go and Python projects", () => {
		expect(detectCommands(project({ "Cargo.toml": "" }))).toEqual({
			build: "cargo build",
			test: "cargo test",
		});
		expect(detectCommands(project({ "go.mod": "module x" }))).toEqual({
			build: "go build ./...",
			lint: "go vet ./...",
			test: "go test ./...",
		});
		expect(detectCommands(project({ "pytest.ini": "" }))).toEqual({ test: "python3 -m pytest" });
		const unittest = project({ "tests/test_app.py": CASE });
		expect(detectCommands(unittest)).toEqual({ test: "python3 -m unittest discover -s tests" });
	});

	it("does not guess unittest from a file name: a pytest-style test would be found by nothing", () => {
		const dir = project({ "tests/test_sum.py": "def test_sum():\n    assert 1 + 1 == 3\n" });
		expect(detectCommands(dir)).toEqual({});
		const withMake = project({
			"tests/test_sum.py": "def test_sum():\n    assert False\n",
			Makefile: "test:\n\tpytest\n",
		});
		expect(detectCommands(withMake)).toEqual({ test: "make test" });
	});

	it("does not take a mere mention of unittest for a test that unittest would find", () => {
		const mock = project({
			"tests/test_mock.py":
				"from unittest.mock import Mock\n\ndef test_mock():\n    assert Mock()\n",
		});
		expect(detectCommands(mock)).toEqual({});
	});

	it("finds a unittest file after a folder or a broken link that is named like one", () => {
		const dir = project({ "tests/test_real.py": CASE });
		for (const name of ["test_a.py", "test_b.py", "test_c.py"]) {
			mkdirSync(join(dir, "tests", name)); // a folder: reading it fails
		}
		expect(detectCommands(dir)).toEqual({ test: "python3 -m unittest discover -s tests" });
	});

	it("knows a double-colon Makefile rule, but not an assignment", () => {
		expect(detectCommands(project({ Makefile: "test::\n\tpytest\n" }))).toEqual({
			test: "make test",
		});
		expect(detectCommands(project({ Makefile: "test::=pytest\nlint:=ruff\n" }))).toEqual({});
	});

	it("survives odd files: a file called tests, an empty script, an assignment that looks like a target", () => {
		expect(detectCommands(project({ tests: "not a folder" }))).toEqual({});
		expect(detectCommands(project({ "package.json": scripts({ test: "  ", lint: "" }) }))).toEqual(
			{},
		);
		expect(detectCommands(project({ Makefile: "build:=gcc\ntest::=pytest\n" }))).toEqual({});
	});

	it("runs the tests of every language in a project that has several", () => {
		const dir = project({
			"package.json": scripts({ test: "node --test" }),
			"tests/test_a.py": CASE,
		});
		expect(detectCommands(dir).test).toBe("npm run test && python3 -m unittest discover -s tests");
	});

	it("uses Makefile targets only where nothing else was found", () => {
		const makefile = "test:\n\tpytest\n\nlint:\n\truff .\n\nbuild-docs:\n\ttrue\n";
		expect(detectCommands(project({ Makefile: makefile }))).toEqual({
			lint: "make lint",
			test: "make test",
		});
		const both = project({ Makefile: makefile, "package.json": scripts({ test: "node --test" }) });
		expect(detectCommands(both).test).toBe("npm run test");
		expect(detectCommands(both).lint).toBe("make lint");
	});
});

describe("configTemplate", () => {
	it("is the plain template when nothing was found", () => {
		expect(configTemplate({})).toBe(CONFIG_TEMPLATE);
	});

	it("keeps a command that holds $ signs as it is, and says that the commands were found", () => {
		const text = configTemplate({ test: "echo $& $$ $1" });
		expect(text).toContain('test: "echo $& $$ $1"');
		expect(text).toContain("Found in this project");
		expect(configTemplate({})).not.toContain("Found in this project");
		expect(configTemplate({ test: "" })).not.toContain("Found in this project"); // nothing was found
	});

	it("writes the commands that were found, as the config's own values", () => {
		const text = configTemplate({ setup: "npm ci", test: 'npm run "test"' });
		expect(text).toContain(
			'commands: { setup: "npm ci", build: "", lint: "", test: "npm run \\"test\\"" },',
		);
		expect(text).not.toContain('commands: { setup: "", build: "", lint: "", test: "" },');
	});
});
