import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const runsDir = join(cwd, ".milhouse", "runs");
const runsIndex = join(cwd, ".milhouse", "runs-index.json");

if (existsSync(runsDir)) {
	rmSync(runsDir, { recursive: true, force: true });
	console.log("removed .milhouse/runs");
}

if (existsSync(runsIndex)) {
	rmSync(runsIndex, { force: true });
	console.log("removed .milhouse/runs-index.json");
}
