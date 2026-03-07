import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const SRC_DIR = join(import.meta.dir, "..", "src");

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(full));
		} else if (entry.name.endsWith(".ts") && entry.name !== "state.ts") {
			results.push(full);
		}
	}
	return results;
}

describe("state safety", () => {
	it("no production code calls updateIssue() or updateTask()", () => {
		const files = collectTsFiles(SRC_DIR);
		const violations: string[] = [];
		const pattern = /\.\s*(updateIssue|updateTask)\s*\(/g;

		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(content)) !== null) {
				const rel = file.replace(SRC_DIR, "src");
				violations.push(`${rel}: ${match[0].trim()}`);
			}
		}

		expect(violations).toEqual([]);
	});
});
