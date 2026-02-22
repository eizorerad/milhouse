import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { generateConfigTs } from "../../config/template.ts";
import { PROBE_SUBDIRS, WORK_SUBDIRS } from "../../domain/config/directories.ts";
import { getDirectoryService } from "../../services/config/DirectoryService.ts";
import { getConfigService } from "../../services/config/index.ts";
import { logSuccess, logWarn } from "../../ui/logger.ts";

/**
 * Handle --init command
 * Creates .milhouse/ directory structure + config.ts + .gitignore rules
 */
export async function runInit(workDir = process.cwd()): Promise<void> {
	const configService = getConfigService(workDir);
	const directoryService = getDirectoryService();

	if (configService.isInitialized()) {
		logWarn(".milhouse/ already exists");
		console.log("To overwrite, delete .milhouse/ and run again");
		return;
	}

	// Create directory structure
	const { created: createdDirs } = directoryService.createDirectoryStructure(workDir);

	// Initialize config (creates config.yaml and progress.txt via legacy system)
	const initResult = configService.ensureInitialized();
	if (!initResult.success) {
		const errorType = initResult.error.type;
		const errorPath = "path" in initResult.error ? initResult.error.path : "unknown";
		logWarn(`Failed to initialize config: ${errorType} at ${errorPath}`);
		return;
	}
	const { detected } = initResult.value;

	// Generate .milhouse/config.ts (the primary config file)
	const configTsPath = join(workDir, ".milhouse", "config.ts");
	writeFileSync(configTsPath, generateConfigTs(detected));

	// Update .gitignore
	ensureGitignoreRules(workDir);

	// Show detected info
	console.log("");
	console.log(pc.bold("Detected:"));
	console.log(`  Project:   ${pc.cyan(detected.name)}`);
	if (detected.language) console.log(`  Language:  ${pc.cyan(detected.language)}`);
	if (detected.framework) console.log(`  Framework: ${pc.cyan(detected.framework)}`);
	if (detected.testCmd) console.log(`  Test:      ${pc.cyan(detected.testCmd)}`);
	if (detected.lintCmd) console.log(`  Lint:      ${pc.cyan(detected.lintCmd)}`);
	if (detected.buildCmd) console.log(`  Build:     ${pc.cyan(detected.buildCmd)}`);
	console.log("");

	logSuccess("Created .milhouse/");
	console.log("");

	// Show structure
	console.log(pc.bold("Directory structure:"));
	console.log(`  ${pc.cyan(".milhouse/config.ts")}       - Central config (edit this)`);
	console.log(`  ${pc.cyan(".milhouse/config.yaml")}     - Legacy config (auto-generated)`);
	console.log(`  ${pc.cyan(".milhouse/state/")}          - Runtime state`);
	console.log(`  ${pc.cyan(".milhouse/probes/")}         - Probe results`);
	for (const probe of PROBE_SUBDIRS) {
		console.log(`    ${pc.dim(`└─ ${probe}/`)}`);
	}
	console.log(`  ${pc.cyan(".milhouse/plans/")}          - Plans and briefs`);
	console.log(`  ${pc.cyan(".milhouse/work/")}           - Branch/worktree metadata`);
	for (const subdir of WORK_SUBDIRS) {
		console.log(`    ${pc.dim(`└─ ${subdir}/`)}`);
	}
	console.log("");

	if (createdDirs.length > 0) {
		console.log(pc.dim(`Created ${createdDirs.length} directories`));
		console.log("");
	}

	console.log(pc.bold("Next steps:"));
	console.log(`  1. Edit:  ${pc.cyan(".milhouse/config.ts")}`);
	console.log(`  2. Run:   ${pc.cyan('milhouse --scan --scope "your focus"')}`);
}

/**
 * Ensure .gitignore has rules to track config.ts but ignore runtime data.
 */
function ensureGitignoreRules(workDir: string): void {
	const gitignorePath = join(workDir, ".gitignore");
	const marker = "!.milhouse/config.ts";

	let content = "";
	if (existsSync(gitignorePath)) {
		content = readFileSync(gitignorePath, "utf-8");
		if (content.includes(marker)) return; // already configured
	}

	// Remove blanket .milhouse/ ignore if present, replace with selective rules
	const lines = content.split("\n");
	const filtered = lines.filter((l) => l.trim() !== ".milhouse/" && l.trim() !== ".milhouse");
	filtered.push(
		"",
		"# Milhouse — track config, ignore runtime data",
		".milhouse/*",
		"!.milhouse/config.ts",
	);

	writeFileSync(gitignorePath, filtered.join("\n").replace(/\n{3,}/g, "\n\n"));
}
