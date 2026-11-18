/** Deterministic checks. They run before the AI reviewer, cost nothing and cannot be talked around. */

import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AddedLine } from "./git.ts";
import { run } from "./proc.ts";
import type { Evidence } from "./types.ts";
import { tail } from "./util.ts";

export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Files that match one of the `neverTouch` globs. A trailing "/" means "everything below". */
export function forbiddenFiles(files: string[], patterns: string[]): string[] {
	const globs = patterns.map((p) => new Bun.Glob(p.endsWith("/") ? `${p}**` : p));
	return files.filter((file) => globs.some((glob) => glob.match(file)));
}

const TRAILING_SPACE = /[ \t]+$/;
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/;

/** Added lines with trailing whitespace or a leftover merge-conflict marker: "file: problem". */
export function findWhitespaceProblems(added: AddedLine[]): string[] {
	return added.flatMap(({ file, text }) => {
		if (CONFLICT_MARKER.test(text)) return [`${file}: conflict marker "${text.trim()}"`];
		if (TRAILING_SPACE.test(text)) {
			return [`${file}: trailing whitespace after "${text.trim().slice(0, 60)}"`];
		}
		return [];
	});
}

const FIXME_MARKER = /\b(?:TODO|FIXME)\b/;
const STUB_MARKER = /not implemented|unimplemented!\(|todo!\(|NotImplementedError/i;

/** Added lines that leave work undone: "file: line". */
export function findPlaceholders(added: AddedLine[]): string[] {
	return added
		.filter(({ text }) => FIXME_MARKER.test(text) || STUB_MARKER.test(text))
		.map(({ file, text }) => `${file}: ${text.trim()}`);
}

/** Run shell commands one after another. Returns a description of the first failure, or null. */
export async function runChecks(
	commands: Array<[label: string, command: string]>,
	cwd: string,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string | null> {
	for (const [label, command] of commands) {
		if (!command.trim()) continue;
		const result = await run(command, [], {
			cwd,
			shell: true,
			timeoutMs,
			env: { ...process.env, CI: "true" },
		});
		// A shell can exit 0 while a child it started keeps running; a timeout is a failure either way.
		if (result.code === 0 && !result.timedOut) continue;
		const why = result.timedOut
			? `timed out after ${Math.round(timeoutMs / 1000)}s`
			: `exit code ${result.code}`;
		return `${label} failed (\`${command}\`, ${why}):\n${tail(result.stdout + result.stderr, 2500)}`;
	}
	return null;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const LINE_SLACK = 5; // models miscount lines by a few
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
			if (!(start >= 1 && end >= start && start <= content.length)) return false;
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
