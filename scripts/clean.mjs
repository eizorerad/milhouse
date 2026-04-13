import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const targets = ["dist", "node_modules"];

for (const target of targets) {
	const fullPath = join(cwd, target);
	if (existsSync(fullPath)) {
		rmSync(fullPath, { recursive: true, force: true });
		console.log(`removed ${target}`);
	}
}

for (const entry of readdirSync(cwd)) {
	if (entry.startsWith(".bun-build")) {
		rmSync(join(cwd, entry), { recursive: true, force: true });
		console.log(`removed ${entry}`);
	}
}
