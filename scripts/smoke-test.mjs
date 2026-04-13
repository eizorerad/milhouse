import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const tmpDir = mkdtempSync(join(tmpdir(), "milhouse-smoke-"));

try {
	const help = spawnSync("bun", ["run", "src/index.ts", "--help"], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	if (help.status !== 0 || !help.stdout.includes("Usage:")) {
		throw new Error("help command failed");
	}

	const init = spawnSync("bun", ["run", join(projectRoot, "src/index.ts"), "--init"], {
		cwd: tmpDir,
		encoding: "utf8",
	});
	if (init.status !== 0) {
		throw new Error("init command failed");
	}

	console.log("smoke-test passed");
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}
