/** Setup, build, lint and test commands that the project itself defines: what its config starts with. Nothing here runs them. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

type Commands = Partial<Config["commands"]>;

const SLOTS = ["setup", "build", "lint", "test"] as const;

const has = (dir: string, file: string): boolean => existsSync(join(dir, file));

function read(dir: string, file: string): string {
	try {
		return readFileSync(join(dir, file), "utf-8");
	} catch {
		return "";
	}
}

/** The package manager that the lock file names, and the install that leaves the lock file as it is. */
function nodeTool(dir: string): { run: string; install: string } {
	if (has(dir, "bun.lock") || has(dir, "bun.lockb")) {
		return { run: "bun run", install: "bun install --frozen-lockfile" };
	}
	if (has(dir, "pnpm-lock.yaml")) {
		return { run: "pnpm run", install: "pnpm install --frozen-lockfile" };
	}
	if (has(dir, "yarn.lock")) return { run: "yarn run", install: "yarn install --frozen-lockfile" };
	return { run: "npm run", install: has(dir, "package-lock.json") ? "npm ci" : "npm install" };
}

/** A linter that rewrites the files is no check: a check has to leave the checkout as it found it. */
const REWRITES = /--(?:fix|write)\b/;

function fromPackageJson(dir: string): Commands {
	let scripts: Record<string, unknown>;
	try {
		scripts = JSON.parse(read(dir, "package.json")).scripts ?? {};
	} catch {
		return {};
	}
	const tool = nodeTool(dir);
	// npm's own placeholder for a missing test is not a test.
	const script = (name: string): string | undefined => {
		const body = scripts[name];
		const usable =
			typeof body === "string" && body.trim() !== "" && !body.includes("no test specified");
		return usable ? `${tool.run} ${name}` : undefined;
	};
	const found = {
		build: script("typecheck") ?? script("build"),
		lint: REWRITES.test(String(scripts.lint)) ? undefined : script("lint"),
		test: script("test"),
	};
	return Object.values(found).some(Boolean) ? { setup: tool.install, ...found } : {};
}

const fromCargo = (dir: string): Commands =>
	has(dir, "Cargo.toml") ? { build: "cargo build", test: "cargo test" } : {};

const fromGo = (dir: string): Commands =>
	has(dir, "go.mod")
		? { build: "go build ./...", lint: "go vet ./...", test: "go test ./..." }
		: {};

/** A class that unittest runs: a TestCase (also the async one) among its bases, not just the word in a comment. */
const UNITTEST_CLASS = /^\s*class\s+\w+\s*\([^)]*\b(?:unittest\.)?(?:IsolatedAsyncio)?TestCase\b/m;

/** Whether a test file in `folder` defines such a class: a pytest-style function would be found by nothing. */
function usesUnittest(folder: string): boolean {
	try {
		return readdirSync(folder).some(
			(name) => /^test.*\.py$/.test(name) && UNITTEST_CLASS.test(read(folder, name)),
		);
	} catch {
		return false; // no such folder, or not a folder
	}
}

/**
 * How a Python project installs what it needs, and the interpreter that then has it. The environment is the
 * checkout's own (`.venv`): one that the project's folder shares would run the project's files, not the run's.
 */
function pythonTool(dir: string): { setup?: string; python: string } {
	if (has(dir, "uv.lock")) return { setup: "uv sync --frozen", python: "uv run --frozen python" };
	if (has(dir, "poetry.lock")) {
		return {
			setup: "POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --no-interaction",
			python: "poetry run python",
		};
	}
	if (has(dir, "requirements.txt")) {
		return {
			// Before Python 3.13 a new environment does not ignore itself, and git would clean it away as stray files.
			setup:
				"python3 -m venv .venv && echo '*' > .venv/.gitignore && .venv/bin/pip install -r requirements.txt",
			python: ".venv/bin/python",
		};
	}
	return { python: "python3" };
}

function fromPython(dir: string): Commands {
	const { setup, python } = pythonTool(dir);
	const pytest = ["pyproject.toml", "requirements.txt"].some((f) =>
		read(dir, f).includes("pytest"),
	);
	if (pytest || has(dir, "pytest.ini")) return { setup, test: `${python} -m pytest` };
	return usesUnittest(join(dir, "tests"))
		? { setup, test: `${python} -m unittest discover -s tests` }
		: {};
}

/** A new checkout has no submodules: the run's own has to fetch them before anything is installed. */
const fromSubmodules = (dir: string): Commands =>
	has(dir, ".gitmodules") ? { setup: "git submodule update --init --recursive" } : {};

function fromMakefile(dir: string): Commands {
	const makefile = read(dir, "Makefile");
	const target = (name: string): string | undefined =>
		new RegExp(`^${name}:{1,2}(?![:=])`, "m").test(makefile) ? `make ${name}` : undefined;
	return { build: target("build"), lint: target("lint"), test: target("test") };
}

/** The commands of every language in the project, joined where several define the same one; a Makefile fills only what is left. */
export function detectCommands(dir: string): Commands {
	const found: Commands = {};
	for (const source of [fromSubmodules, fromPackageJson, fromCargo, fromGo, fromPython]) {
		const commands = source(dir);
		for (const slot of SLOTS) {
			const command = commands[slot];
			if (command) found[slot] = found[slot] ? `${found[slot]} && ${command}` : command;
		}
	}
	const make = fromMakefile(dir);
	for (const slot of SLOTS) {
		const command = make[slot];
		if (command && !found[slot]) found[slot] = command;
	}
	return found;
}
