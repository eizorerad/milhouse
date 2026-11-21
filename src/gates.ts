/** Deterministic checks. They run before the AI reviewer, cost nothing and cannot be talked around. */

import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type AddedLine, gitOrThrow, revParse, withoutGitRouting } from "./git.ts";
import { run } from "./proc.ts";
import type { Config, Evidence } from "./types.ts";
import { MINUTE, tail } from "./util.ts";

export const COMMAND_TIMEOUT_MS = 10 * MINUTE;

/**
 * A test for files that match one of `patterns`, written like .gitignore lines but without exceptions (`!`):
 * a name is a file or a directory with everything below it (with a slash at its end: a directory), a pattern
 * with a slash in it or in front of it starts at the repository root, one without (`.env*`, `cache/`) matches
 * at any depth.
 */
export function globMatcher(patterns: string[]): (file: string) => boolean {
	const globs = patterns.flatMap((raw) => {
		const name = raw.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!name) return [];
		const anchored = raw.startsWith("/") || name.includes("/");
		const path = anchored ? name : `**/${name}`;
		const below = new Bun.Glob(`${path}/**`);
		return raw.endsWith("/") ? [below] : [new Bun.Glob(path), below];
	});
	return (file) => globs.some((glob) => glob.match(file));
}

/** Files that match one of the `neverTouch` patterns. */
export function forbiddenFiles(files: string[], patterns: string[]): string[] {
	return files.filter(globMatcher(patterns));
}

const TRAILING_SPACE = /[ \t]+$/;
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/;

/** Added lines with trailing whitespace or a leftover merge-conflict marker: "file: problem". */
export function findWhitespaceProblems(added: AddedLine[]): string[] {
	return added.flatMap(({ file, text: raw }) => {
		const text = raw.replace(/\r$/, ""); // the line ending of a CRLF file is not trailing whitespace
		if (CONFLICT_MARKER.test(text)) return [`${file}: conflict marker "${text.trim()}"`];
		if (TRAILING_SPACE.test(text)) {
			return [`${file}: trailing whitespace after "${text.trim().slice(0, 60)}"`];
		}
		return [];
	});
}

/**
 * A note that work is left: TODO or FIXME where a comment begins, or where a line begins when a colon or a
 * name in brackets follows. The word alone is none (an enum value, a string, `todoList`).
 */
const NOTE = /(?:\/\/|\/\*|^\s*\*|#|--|<!--)\s*(?:TODO|FIXME)\b|^\s*(?:TODO|FIXME)\s*[:(]/;
/** Rust's own words for code that is not written yet. */
const STUB = /\b(?:todo|unimplemented)!\(/;

/**
 * Added lines that say themselves that work is left: "file: line". Only what cannot be meant otherwise: a
 * gate that is wrong costs every retry of an issue. Whether a `throw new Error("not implemented")` is a stub
 * or an answer to a caller is for the reviewer to say.
 */
export function findPlaceholders(added: AddedLine[]): string[] {
	return added
		.filter(({ text }) => NOTE.test(text) || STUB.test(text))
		.map(({ file, text }) => `${file}: ${text.trim()}`);
}

/**
 * Run shell commands (label -> command) one after another, in the order given. Returns a description of the
 * first failure, or null. `reap`: stop what a command left running (a watcher, a server) when it has finished.
 */
export async function runChecks(
	cwd: string,
	commands: Record<string, string>,
	{
		timeoutMs = COMMAND_TIMEOUT_MS,
		reap = true,
		passed,
	}: { timeoutMs?: number; reap?: boolean; passed?: string[] } = {},
): Promise<string | null> {
	for (const [label, command] of Object.entries(commands)) {
		if (!command.trim()) continue;
		const result = await run(command, [], {
			cwd,
			shell: true,
			timeoutMs,
			reap,
			env: { ...withoutGitRouting(process.env), CI: "true" },
		});
		// A shell can exit 0 while a child it started keeps running; a timeout is a failure either way.
		if (result.code === 0 && !result.timedOut) {
			passed?.push(`${label}: \`${command}\` (exit 0)`);
			continue;
		}
		const why = result.timedOut
			? `timed out after ${Math.round(timeoutMs / 1000)}s`
			: `exit code ${result.code}`;
		return `${label} failed (\`${command}\`, ${why}):\n${tail(result.stdout + result.stderr, 2500)}`;
	}
	return null;
}

/**
 * Build, lint and test in `dir`, a clean checkout of the commit being judged. The commands must leave it as
 * it was: one that rewrites a tracked file (a fixing linter) or makes a commit would make the tested state
 * differ from the committed one. Returns what is wrong, or null.
 */
export async function runProjectChecks(
	dir: string,
	commands: Config["commands"],
	opts: { passed?: string[]; timeoutMs?: number } = {},
): Promise<string | null> {
	const before = await revParse(dir, "HEAD");
	const { build, lint, test } = commands;
	const failure = await runChecks(dir, { build, lint, test }, opts);
	await gitOrThrow(dir, "clean", "-fd"); // what the commands generated: the tree was clean before them
	if (failure) return failure;
	if ((await revParse(dir, "HEAD")) !== before) {
		return "Running the checks moved HEAD (they made a commit), so what was tested is not what is committed. Make the commands read-only.";
	}
	const changed = await gitOrThrow(dir, "status", "--porcelain", "--untracked-files=no");
	if (changed) {
		return `Running the checks changed tracked files, so what was tested is not what is committed. Commit those changes or make the commands read-only:\n${tail(changed, 800)}`;
	}
	return null;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const LINE_SLACK = 5; // models miscount lines by a few
/** A citation points at a place in a file: a range that covers the whole file would find any snippet. */
export const MAX_CITED_LINES = 200;
const ELLIPSIS = /^(\.{3}|…)$/;

/** The evidence that holds up: file inside the repo, line range in the file, snippet found near it. */
export function verifyEvidence(repo: string, evidence: Evidence[]): Evidence[] {
	const root = realpathSync(repo);
	return evidence.filter((item) => {
		try {
			const file = realpathSync(resolve(repo, item.file));
			if (!file.startsWith(root + sep)) return false;
			const content = readFileSync(file, "utf-8").split("\n");
			const { line_start: start, line_end: end } = item;
			// Numbers: a harness that does not enforce the answer's schema may send "3", and "3" + 5 is "35".
			if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
			if (!(start >= 1 && end >= start && start <= content.length)) return false;
			if (end - start >= MAX_CITED_LINES) return false;
			const window = squash(
				content.slice(Math.max(0, start - 1 - LINE_SLACK), end + LINE_SLACK).join(" "),
			);
			const wanted = item.snippet
				.split("\n")
				.map(squash)
				.filter((line) => line && !ELLIPSIS.test(line));
			return wanted.length > 0 && wanted.every((line) => window.includes(line));
		} catch {
			return false; // the file does not exist or cannot be read
		}
	});
}
