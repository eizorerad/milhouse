/** Build, lint and test commands that the project itself defines: a suggestion for `milhouse init`. Nothing here runs them. */

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
		lint: script("lint"),
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

function fromPython(dir: string): Commands {
	if (has(dir, "pytest.ini") || read(dir, "pyproject.toml").includes("pytest")) {
		return { test: "python3 -m pytest" };
	}
	return usesUnittest(join(dir, "tests")) ? { test: "python3 -m unittest discover -s tests" } : {};
}

function fromMakefile(dir: string): Commands {
	const makefile = read(dir, "Makefile");
	const target = (name: string): string | undefined =>
		new RegExp(`^${name}:{1,2}(?![:=])`, "m").test(makefile) ? `make ${name}` : undefined;
	return { build: target("build"), lint: target("lint"), test: target("test") };
}

/** The commands of every language in the project, joined where several define the same one; a Makefile fills only what is left. */
export function detectCommands(dir: string): Commands {
	const found: Commands = {};
	for (const source of [fromPackageJson, fromCargo, fromGo, fromPython]) {
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
