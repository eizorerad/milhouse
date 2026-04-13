import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["src"];
const forbidden = [/\bTODO\b/, /\bFIXME\b/, /\bTBD\b/, /\bXXX\b/];
const offenders = [];

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".claude") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(fullPath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const content = readFileSync(fullPath, "utf8");
		for (const pattern of forbidden) {
			if (pattern.test(content)) {
				offenders.push(`${relative(process.cwd(), fullPath)} matches ${pattern}`);
			}
		}
	}
}

for (const root of roots) {
	try {
		walk(join(process.cwd(), root));
	} catch {}
}

if (offenders.length > 0) {
	console.error("forbidden-tokens-check failed:");
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}

console.log("forbidden-tokens-check passed");
