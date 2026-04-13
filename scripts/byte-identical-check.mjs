import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["src", "tests"];
const ignoredDirs = new Set(["node_modules", "dist", ".claude", ".milhouse"]);
const byHash = new Map();

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (ignoredDirs.has(entry.name)) continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(fullPath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const content = readFileSync(fullPath);
		const hash = createHash("sha256").update(content).digest("hex");
		const paths = byHash.get(hash) ?? [];
		paths.push(relative(process.cwd(), fullPath));
		byHash.set(hash, paths);
	}
}

for (const root of roots) {
	try {
		if (statSync(root).isDirectory()) walk(root);
	} catch {}
}

const duplicates = [...byHash.values()].filter((paths) => paths.length > 1);
if (duplicates.length > 0) {
	console.error("byte-identical-check failed:");
	for (const group of duplicates) console.error(`  ${group.join(" == ")}`);
	process.exit(1);
}

console.log("byte-identical-check passed");
